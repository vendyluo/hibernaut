import { env, evictDurableObject, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { Effect, Exit, Schema } from "effect";
import { defineAction } from "../src/core/action.js";
import { TurnError } from "../src/core/commit.js";
import { emit, runInstruction } from "../src/core/directive.js";
import { chatAgent, chatActions, type ChatState } from "../src/example/chat.js";
import type { ChatAgent } from "../src/index.js";

const stubFor = (name: string) => env.ChatAgent.get(env.ChatAgent.idFromName(name));
const noop = { _tag: "ModelTimeout", requestId: "unused" } as const;

describe("candidate validation and commit boundary", () => {
  it.each(["nested getter", "candidate getter", "array subclass"])(
    "rejects %s without evaluating runtime code, committing or emitting",
    async (kind) => {
      const stub = stubFor(`portable-boundary-${kind.replaceAll(" ", "-")}`);
      await runInDurableObject(stub, async (instance: ChatAgent) => {
        await instance.dispatch(noop);
        const before = instance.state;
        const target = instance as unknown as { def: typeof chatAgent; onEmit: () => void };
        let executions = 0;
        let emissions = 0;
        class RewritingArray extends Array<never> {
          toJSON() {
            executions++;
            return "unexpected string";
          }
        }
        const state = { ...before, seq: 1 };
        const candidate = { state, directives: [emit("must-not-run", {})] };
        if (kind === "nested getter") {
          Object.defineProperty(state, "seq", {
            enumerable: true,
            get: () => {
              executions++;
              return 1;
            },
          });
        } else if (kind === "candidate getter") {
          Object.defineProperty(candidate, "state", {
            enumerable: true,
            get: () => {
              executions++;
              return state;
            },
          });
        } else {
          state.messages = new RewritingArray();
        }
        target.def = { ...chatAgent, cmd: () => candidate };
        target.onEmit = () => {
          emissions++;
        };
        await expect(instance.dispatch(noop)).rejects.toMatchObject({
          stage: "validation",
          commitStatus: "not-committed",
        });
        expect(executions).toBe(0);
        expect(emissions).toBe(0);
        expect(instance.state).toEqual(before);
        expect(await instance.getSchedules()).toHaveLength(0);
      });
      await evictDurableObject(stub);
      expect(await runInDurableObject(stub, (instance: ChatAgent) => instance.state.seq)).toBe(0);
    },
  );

  it.each(["state", "directive", "schedule", "target", "payload"])(
    "rejects invalid %s before storage or any effect",
    async (kind) => {
      const stub = stubFor(`invalid-candidate-${kind}`);
      await runInDurableObject(stub, async (instance: ChatAgent) => {
        await instance.dispatch(noop);
        const before = instance.state;
        const target = instance as unknown as { def: typeof chatAgent; onEmit: () => void };
        let emissions = 0;
        target.onEmit = () => {
          emissions++;
        };
        const invalid =
          kind === "directive"
            ? { _tag: "Unknown" }
            : kind === "schedule"
              ? { _tag: "ScheduleAction", delaySeconds: 1, action: { _tag: "ModelTimeout" } }
              : kind === "target"
                ? {
                    _tag: "RunInstruction",
                    action: "missing",
                    params: {},
                    resultAction: "ModelResult",
                  }
                : emit("bad", () => "not data");
        target.def = {
          ...chatAgent,
          cmd: () => ({
            state:
              kind === "state"
                ? ({ ...before, seq: "invalid" } as unknown as ChatState)
                : { ...before, seq: 1 },
            directives:
              kind === "state" ? [emit("first", {})] : ([emit("first", {}), invalid] as never),
          }),
        };
        await expect(instance.dispatch(noop)).rejects.toMatchObject({
          name: "TurnError",
          stage: "validation",
          commitStatus: "not-committed",
        });
        expect(instance.state).toEqual(before);
        expect(emissions).toBe(0);
        expect(await instance.getSchedules()).toHaveLength(0);
      });
      await evictDurableObject(stub);
      expect(await runInDurableObject(stub, (instance: ChatAgent) => instance.state.seq)).toBe(0);
    },
  );

  it("retains the commit and stops later effects after dispatch failure", async () => {
    const stub = stubFor("committed-effect-failure");
    await runInDurableObject(stub, async (instance: ChatAgent) => {
      await instance.dispatch(noop);
      const target = instance as unknown as {
        def: typeof chatAgent;
        onEmit: (event: string) => void;
      };
      const seen: string[] = [];
      target.def = {
        ...chatAgent,
        cmd: (state) => ({
          state: { ...state, seq: 1 },
          directives: [emit("first", {}), emit("later", {})],
        }),
      };
      target.onEmit = (event) => {
        seen.push(event);
        throw new Error("transport unavailable");
      };
      await expect(instance.dispatch(noop)).rejects.toMatchObject({
        name: "TurnError",
        stage: "effects",
        commitStatus: "committed",
      });
      expect(seen).toEqual(["first"]);
      expect(instance.state.seq).toBe(1);
    });
    await evictDurableObject(stub);
    expect(await runInDurableObject(stub, (instance: ChatAgent) => instance.state.seq)).toBe(1);
  });

  it("blocks an in-flight instruction result after another turn has an uncertain commit", async () => {
    const stub = stubFor("uncertain-in-flight-result");
    await runInDurableObject(stub, async (instance: ChatAgent) => {
      await instance.dispatch(noop);
      const target = instance as unknown as {
        def: typeof chatAgent;
        actions: typeof chatActions;
        onEmit: () => void;
      };
      let started!: () => void;
      let finish!: (value: string) => void;
      const entered = new Promise<void>((resolve) => {
        started = resolve;
      });
      const pending = new Promise<string>((resolve) => {
        finish = resolve;
      });
      let commands = 0;
      let emissions = 0;
      target.actions = {
        callModel: {
          ...chatActions.callModel,
          run: () =>
            Effect.promise(() => {
              started();
              return pending.then((text) => ({ text }));
            }),
        },
      };
      target.def = {
        ...chatAgent,
        cmd: (state) => {
          commands++;
          return {
            state: { ...state, seq: state.seq + 1 },
            directives:
              commands === 1
                ? [runInstruction("callModel", { messages: [] }, "ModelResult")]
                : [emit("late", {})],
          };
        },
      };
      target.onEmit = () => {
        emissions++;
      };
      const first = instance.dispatch(noop).then(
        () => null,
        (error: unknown) => error,
      );
      await entered;
      const originalSetState = instance.setState.bind(instance);
      instance.setState = () => {
        throw new Error("storage acknowledgement unavailable");
      };
      try {
        await expect(instance.dispatch(noop)).rejects.toMatchObject({
          stage: "commit",
          commitStatus: "unknown",
        });
      } finally {
        instance.setState = originalSetState;
        finish("late result");
      }
      expect(await first).toMatchObject({
        stage: "effects",
        commitStatus: "committed",
        cause: { stage: "commit", commitStatus: "unknown" },
      });
      expect(commands).toBe(2);
      expect(emissions).toBe(0);
      expect(instance.state.seq).toBe(1);
      expect(instance.quarantined).not.toBeNull();
    });
  });

  it.each(["before write", "after write"])(
    "quarantines an uncertain commit %s until a new activation reloads storage",
    async (failurePoint) => {
      const stub = stubFor(`uncertain-${failurePoint.replaceAll(" ", "-")}`);
      await runInDurableObject(stub, async (instance: ChatAgent) => {
        await instance.dispatch(noop);
        const target = instance as unknown as {
          def: typeof chatAgent;
          onEmit: (event: string) => void;
          runQuery: (
            action: ReturnType<typeof defineAction>,
            params: unknown,
          ) => Promise<Exit.Exit<unknown, unknown>>;
        };
        let commands = 0;
        let queries = 0;
        let domainEmissions = 0;
        target.def = {
          ...chatAgent,
          cmd: (state) => {
            commands++;
            return { state: { ...state, seq: state.seq + 1 }, directives: [emit("domain", {})] };
          },
        };
        target.onEmit = (event) => {
          if (event === "domain") domainEmissions++;
        };
        const originalSetState = instance.setState.bind(instance);
        const originalSql = instance.sql.bind(instance);
        if (failurePoint === "before write") {
          // Exercise the real SDK memory-before-SQL ordering with an injected storage rejection.
          instance.sql = ((
            strings: TemplateStringsArray,
            ...values: (string | number | boolean | null)[]
          ) => {
            const query = strings.join("?");
            if (query.includes("INSERT") && query.includes("cf_agents_state"))
              throw new Error("storage rejected write");
            return originalSql(strings, ...values);
          }) as typeof instance.sql;
        } else {
          instance.setState = (state) => {
            originalSetState(state);
            throw new Error("lost storage acknowledgement");
          };
        }
        try {
          await expect(instance.dispatch(noop)).rejects.toMatchObject({
            stage: "commit",
            commitStatus: "unknown",
          });
        } finally {
          instance.sql = originalSql;
          instance.setState = originalSetState;
        }
        expect(instance.state.seq).toBe(1);
        expect(instance.quarantined).toContain("commit result is uncertain");
        await instance.dispatch(noop);
        await instance.reconcileNow();
        await instance.onStart();
        const query = defineAction({
          name: "query",
          input: Schema.Unknown,
          output: Schema.Number,
          run: () => {
            queries++;
            return Effect.succeed(1);
          },
        });
        expect(Exit.isFailure(await target.runQuery(query, null))).toBe(true);
        expect(commands).toBe(1);
        expect(queries).toBe(0);
        expect(domainEmissions).toBe(0);
        const rows = instance.sql<{
          state: string;
        }>`SELECT state FROM cf_agents_state WHERE id = 'cf_state_row_id'`;
        expect(JSON.parse(rows[0]!.state).seq).toBe(failurePoint === "before write" ? 0 : 1);
      });
      await evictDurableObject(stub);
      await runInDurableObject(stub, async (instance: ChatAgent) => {
        const target = instance as unknown as { def: typeof chatAgent };
        target.def = {
          ...chatAgent,
          cmd: (state) => ({ state: { ...state, seq: state.seq + 1 }, directives: [] }),
        };
        await instance.dispatch(noop);
        expect(instance.quarantined).toBeNull();
        expect(instance.state.seq).toBe(failurePoint === "before write" ? 1 : 2);
      });
    },
  );

  it("classifies command failure before commit", async () => {
    const stub = stubFor("command-failure");
    await runInDurableObject(stub, async (instance: ChatAgent) => {
      await instance.dispatch(noop);
      const target = instance as unknown as { def: typeof chatAgent };
      target.def = {
        ...chatAgent,
        cmd: () => {
          throw new Error("domain failure");
        },
      };
      await expect(instance.dispatch(noop)).rejects.toBeInstanceOf(TurnError);
      await expect(instance.dispatch(noop)).rejects.toMatchObject({
        stage: "execution",
        commitStatus: "not-committed",
      });
    });
  });
});
