/**
 * 持久狀態不符 schema 時的處置。
 *
 * TypeScript 的型別在 SQLite 的 JSON 上不存在，Agents SDK 也只是 `JSON.parse`。
 * 舊版部署、schema 演進、人工修復或資料損壞都可能讓狀態不再符合 `ChatState`。
 *
 * ## 為什麼是隔離而不是重置
 *
 * 預設策略選**隔離**：原始資料原封不動留在 SQLite，agent 拒絕服務並回報。
 * 這是三個選項裡唯一不會造成資料遺失、也不會讓壞狀態繼續汙染下游的：
 *
 *   - 默默重置 → 使用者的對話無聲消失，而且你不會知道發生過
 *   - 照樣執行 → `cmd` 可能 throw 或走進沒有匹配的分支，恢復保證跟著失效
 *   - 隔離     → 沒有資料遺失，故障明確可見，人可以決定要遷移還是丟棄
 *
 * 這是可以改的產品決策，不是技術結論 —— 真的要自動遷移，就在 `onStart()` 的
 * 驗證失敗分支接上 migration，而不是把未驗證的資料丟給 `cmd`。
 */
import { env, evictDurableObject, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { ChatState } from "../src/example/chat.js";
import type { ChatAgent } from "../src/index.js";

const stubFor = (name: string) => env.ChatAgent.get(env.ChatAgent.idFromName(name));

/** 寫入不符 `ChatState` 的狀態：`AwaitingModel` 缺少 `deadlineAt`。 */
const writeCorruptState = (stub: DurableObjectStub) =>
  runInDurableObject(stub, (instance: ChatAgent) => {
    instance.setState({
      messages: [],
      phase: { _tag: "AwaitingModel", requestId: "req-1" },
      seq: 1
    } as unknown as ChatState);
  });

describe("持久狀態驗證", () => {
  it("狀態不符 schema 時，agent 醒來就隔離並拒絕服務", async () => {
    const stub = stubFor("corrupt-quarantine");
    await writeCorruptState(stub);

    await evictDurableObject(stub);

    await runInDurableObject(stub, async (instance: ChatAgent) => {
      // dispatch 會先走驗證；隔離之後它不做事，狀態保持原樣。
      await instance.dispatch({ _tag: "UserMessage", text: "hi", now: Date.now() });

      expect(instance.quarantined).not.toBeNull();
      const state = instance.state as unknown as Record<string, unknown>;
      expect(state.seq).toBe(1);
      expect(state.messages).toEqual([]);
    });
  });

  it("隔離不會重置或刪除原始資料，人工判讀時還在", async () => {
    const stub = stubFor("corrupt-preserved");
    await writeCorruptState(stub);

    await evictDurableObject(stub);

    await runInDurableObject(stub, (instance: ChatAgent) => {
      const state = instance.state as unknown as { phase: Record<string, unknown> };
      // 原封不動：沒有被補上 deadlineAt，也沒有被換成 initialState。
      expect(state.phase).toEqual({ _tag: "AwaitingModel", requestId: "req-1" });
    });
  });

  it("直接呼叫 reconcileNow 也不能繞過驗證與隔離", async () => {
    const stub = stubFor("corrupt-reconcile");
    await writeCorruptState(stub);

    await evictDurableObject(stub);

    await runInDurableObject(stub, async (instance: ChatAgent) => {
      await expect(instance.reconcileNow()).resolves.toBeUndefined();
      expect(instance.quarantined).not.toBeNull();
    });
  });

  it("合法狀態不會被誤判為隔離", async () => {
    const stub = stubFor("valid-not-quarantined");

    await runInDurableObject(stub, (instance: ChatAgent) => {
      instance.setState({ messages: [], phase: { _tag: "Idle" }, seq: 0 });
    });
    await evictDurableObject(stub);

    await runInDurableObject(stub, async (instance: ChatAgent) => {
      expect(instance.quarantined).toBeNull();
      await instance.dispatch({ _tag: "UserMessage", text: "hi", now: Date.now() });
      expect((instance.state as ChatState).messages).toHaveLength(2);
    });
  });
});
