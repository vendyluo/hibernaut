/**
 * Spike 1：hibernation 存活，以及 schedule 沒寫成功時的自我修復。
 *
 * 這是整份設計最關鍵、也是 `wrangler dev` **測不到**的一件事。Cloudflare 文件寫得很直白：
 * 本地開發時 hibernatable WebSocket 的事件照常送達，但
 *
 *   > the Durable Object is never evicted from memory
 *
 * 所以 `wrangler dev` 永遠是綠的，然後上線後每 70–140 秒被咬一次。
 * `evictDurableObject()` 做的正好是真實驅逐做的事：記憶體沒了，SQLite 還在。
 */
import {
  env,
  evictDurableObject,
  runDurableObjectAlarm,
  runInDurableObject
} from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { chatAgent, type ChatState } from "../src/example/chat.js";
import type { ChatAgent } from "../src/index.js";

const stubFor = (name: string) => env.ChatAgent.get(env.ChatAgent.idFromName(name));

const phaseOf = async (stub: DurableObjectStub) =>
  runInDurableObject(stub, (instance: ChatAgent) => (instance.state as ChatState).phase);

/**
 * 走真實入口把 DO 叫醒。
 *
 * `runInDurableObject()` 是直接戳實例的方法，會**繞過** partyserver 的
 * `#ensureInitialized()`，也就繞過 `onStart()`。真實環境的喚醒一律經過
 * `fetch` / `alarm` / `webSocketMessage`，所以這裡用 `fetch` 才測得到醒來時的修復。
 */
const wake = async (stub: DurableObjectStub) => {
  await stub.fetch("https://example.com/_wake").catch(() => undefined);
};

const scheduleRows = async (stub: DurableObjectStub) =>
  runInDurableObject(stub, (instance: ChatAgent) =>
    instance.ctx.storage.sql
      .exec("SELECT callback, payload, type FROM cf_agents_schedules")
      .toArray()
  );

/** 製造「呼叫已發出、狀態已記錄、守衛已排程」的中間態 —— DO 最可能死掉的那一刻。 */
const enterAwaitingModel = async (
  stub: DurableObjectStub,
  requestId: string,
  opts: { deadlineInMs?: number; armGuard?: boolean; delaySeconds?: number } = {}
) => {
  const { deadlineInMs = 60_000, armGuard = true, delaySeconds = 30 } = opts;
  await runInDurableObject(stub, async (instance: ChatAgent) => {
    instance.setState({
      messages: [{ role: "user", text: "hi" }],
      phase: {
        _tag: "AwaitingModel",
        requestId,
        deadlineAt: Date.now() + deadlineInMs
      },
      seq: 1
    });
    if (armGuard) {
      await instance.schedule(delaySeconds, "resumeAction", {
        _tag: "ModelTimeout",
        requestId
      });
    }
  });
};

describe("Durable Object 驅逐", () => {
  it("evictDurableObject 真的清掉記憶體狀態（先驗證測試工具本身可信）", async () => {
    const stub = stubFor("evict-proof");

    await runInDurableObject(stub, (instance: ChatAgent) => {
      (instance as unknown as Record<string, unknown>).__marker = "alive";
    });
    await runInDurableObject(stub, (instance: ChatAgent) => {
      expect((instance as unknown as Record<string, unknown>).__marker).toBe("alive");
    });

    await evictDurableObject(stub);

    // 全新實例：記憶體裡的東西不見了。這正是 hibernation 之後的樣子。
    await runInDurableObject(stub, (instance: ChatAgent) => {
      expect((instance as unknown as Record<string, unknown>).__marker).toBeUndefined();
    });
  });

  it("setState 的狀態跨越驅逐存活", async () => {
    const stub = stubFor("state-survives");
    await enterAwaitingModel(stub, "req-1");

    await evictDurableObject(stub);

    await runInDurableObject(stub, (instance: ChatAgent) => {
      const state = instance.state as ChatState;
      expect(state.messages).toEqual([{ role: "user", text: "hi" }]);
      expect(state.seq).toBe(1);
    });
  });

  it("逾時守衛本身跨越驅逐存活在 SQLite 裡", async () => {
    const stub = stubFor("guard-persists");
    await enterAwaitingModel(stub, "req-1");

    await evictDurableObject(stub);

    const rows = await scheduleRows(stub);
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows[0]).toMatchObject({
      callback: "resumeAction",
      type: "delayed",
      payload: JSON.stringify({ _tag: "ModelTimeout", requestId: "req-1" })
    });
  });

  it("驅逐後守衛到期執行，把 agent 從 AwaitingModel 拉回 Idle", async () => {
    const stub = stubFor("guard-recovers");
    await enterAwaitingModel(stub, "req-1");

    // 模擬「模型呼叫途中 DO 被回收」：記憶體沒了，排程還在 SQLite 裡。
    await evictDurableObject(stub);

    // 把時鐘往前撥。`runDurableObjectAlarm()` 會立刻叫起 alarm handler，
    // 但 Agents SDK 的 handler 只處理 `time <= now` 的列，所以要先讓它到期。
    await runInDurableObject(stub, (instance: ChatAgent) => {
      instance.ctx.storage.sql.exec(
        "UPDATE cf_agents_schedules SET time = ?",
        Math.floor(Date.now() / 1000) - 1
      );
    });

    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect(await phaseOf(stub)).toEqual({ _tag: "Idle" });
  });

  it("驅逐後 ManagedRuntime 重建，完整一輪對話仍然走得完", async () => {
    const stub = stubFor("runtime-rebuild");

    await runInDurableObject(stub, async (instance: ChatAgent) => {
      await instance.dispatch({ _tag: "UserMessage", text: "first", now: Date.now() });
    });

    await evictDurableObject(stub);

    // 這一輪的 Layer 與 ManagedRuntime 都是從零重建的。
    await runInDurableObject(stub, async (instance: ChatAgent) => {
      await instance.dispatch({ _tag: "UserMessage", text: "second", now: Date.now() });
      const state = instance.state as ChatState;
      expect(state.phase).toEqual({ _tag: "Idle" });
      expect(state.messages.map((m) => m.text)).toEqual([
        "first",
        "echo: first",
        "second",
        "echo: second"
      ]);
    });
  });
});

/**
 * 這一組涵蓋審查點出的洞：`setState` 成功但 `this.schedule()` 失敗時，
 * 狀態停在 `AwaitingModel` 而守衛根本不存在。
 *
 * 舊測試只證明「已成功排入的守衛能跨驅逐存活」，完全沒碰到這個情況。
 */
describe("守衛沒排成功時的自我修復", () => {
  it("當下排程失敗會終結這批 directives，不會繼續呼叫模型", async () => {
    const stub = stubFor("schedule-failure-aborts-instruction");

    await runInDurableObject(stub, async (instance: ChatAgent) => {
      let instructionRan = false;
      const target = instance as unknown as {
        schedule: () => Promise<never>;
        executeInstruction: () => Promise<void>;
      };
      target.schedule = async () => {
        throw new Error("simulated schedule failure");
      };
      target.executeInstruction = async () => {
        instructionRan = true;
      };

      await instance.dispatch({ _tag: "UserMessage", text: "hi", now: Date.now() });

      expect((instance.state as ChatState).phase).toEqual({ _tag: "Idle" });
      expect(instructionRan).toBe(false);
    });
  });

  it("期限已過且沒有守衛：醒來就地逾時，不會永久卡住", async () => {
    const stub = stubFor("reconcile-expired");
    // armGuard: false 精準重現「schedule 沒寫成功」
    await enterAwaitingModel(stub, "req-1", { deadlineInMs: -1, armGuard: false });

    expect(await scheduleRows(stub)).toHaveLength(0);

    await evictDurableObject(stub);
    await wake(stub); // 真實喚醒 → onStart → reconcile

    expect(await phaseOf(stub)).toEqual({ _tag: "Idle" });
  });

  it("期限未到且沒有守衛：醒來把守衛補排回來", async () => {
    const stub = stubFor("reconcile-rearm");
    await enterAwaitingModel(stub, "req-1", {
      deadlineInMs: 60_000,
      armGuard: false
    });

    expect(await scheduleRows(stub)).toHaveLength(0);

    await evictDurableObject(stub);
    await wake(stub); // 真實喚醒 → onStart → reconcile

    const rows = await scheduleRows(stub);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      callback: "resumeAction",
      payload: JSON.stringify({ _tag: "ModelTimeout", requestId: "req-1" })
    });
  });

  it("繞過真實入口直接 dispatch，也會先自我修復（不變式不依賴進入路徑）", async () => {
    const stub = stubFor("reconcile-on-dispatch");
    await enterAwaitingModel(stub, "req-1", { deadlineInMs: -1, armGuard: false });

    await evictDurableObject(stub);

    // 沒有 wake()：直接戳方法，繞過 onStart。
    await runInDurableObject(stub, async (instance: ChatAgent) => {
      await instance.dispatch({ _tag: "UserMessage", text: "hi", now: Date.now() });
      const state = instance.state as ChatState;
      // 修復先發生（AwaitingModel → Idle），這則訊息才被正常處理。
      expect(state.phase).toEqual({ _tag: "Idle" });
      expect(state.messages.map((m) => m.text)).toEqual(["hi", "hi", "echo: hi"]);
    });
  });

  it("重複修復不會長出重複的排程列（idempotent）", async () => {
    const stub = stubFor("reconcile-idempotent");
    await enterAwaitingModel(stub, "req-1", {
      deadlineInMs: 60_000,
      armGuard: false
    });

    for (let i = 0; i < 3; i++) {
      await evictDurableObject(stub);
      await runInDurableObject(stub, (instance: ChatAgent) => instance.reconcileNow());
    }

    expect(await scheduleRows(stub)).toHaveLength(1);
  });
});

describe("初始化只完成一次，而且所有呼叫都等待同一輪", () => {
  it("第二個 dispatch 不會越過仍在進行的 onWake", async () => {
    const stub = stubFor("initialization-single-flight");

    await runInDurableObject(stub, async (instance: ChatAgent) => {
      let releaseWake!: () => void;
      const wakeBlocked = new Promise<void>((resolve) => {
        releaseWake = resolve;
      });
      let cmdCalls = 0;

      const target = instance as unknown as {
        onWake: () => Promise<void>;
        def: typeof chatAgent;
      };
      target.onWake = async () => await wakeBlocked;
      const originalDef = target.def;
      target.def = {
        ...originalDef,
        cmd: (state, action) => {
          cmdCalls += 1;
          return originalDef.cmd(state, action);
        }
      };

      const first = instance.dispatch({
        _tag: "UserMessage",
        text: "first",
        now: Date.now()
      });
      const second = instance.dispatch({
        _tag: "UserMessage",
        text: "second",
        now: Date.now()
      });

      await Promise.resolve();
      expect(cmdCalls).toBe(0);

      releaseWake();
      await Promise.all([first, second]);
      expect(cmdCalls).toBe(3);
    });
  });
});
