import { env, evictDurableObject, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { TurnError } from "../src/core/commit.js";
import { emit } from "../src/core/directive.js";
import { chatAgent, type ChatState } from "../src/example/chat.js";
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

  it("reports uncertain storage failure without dispatching or rolling back", async () => {
    const stub = stubFor("uncertain-commit");
    await runInDurableObject(stub, async (instance: ChatAgent) => {
      await instance.dispatch(noop);
      const target = instance as unknown as { def: typeof chatAgent; onEmit: () => void };
      target.def = {
        ...chatAgent,
        cmd: (state) => ({ state: { ...state, seq: 1 }, directives: [emit("later", {})] }),
      };
      let emissions = 0;
      target.onEmit = () => {
        emissions++;
      };
      const original = instance.setState.bind(instance);
      instance.setState = (state) => {
        original(state);
        throw new Error("lost storage acknowledgement");
      };
      await expect(instance.dispatch(noop)).rejects.toMatchObject({
        name: "TurnError",
        stage: "commit",
        commitStatus: "unknown",
      });
      expect(emissions).toBe(0);
    });
    await evictDurableObject(stub);
    expect(await runInDurableObject(stub, (instance: ChatAgent) => instance.state.seq)).toBe(1);
  });

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
