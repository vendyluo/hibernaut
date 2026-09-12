/**
 * 本地 workerd：跨 handler 的 storage 存取與 in-memory fiber 遺失。
 *
 * 第一個測試只證明同一 DO 的 storage 可由後續 handler 等待的 fiber 存取，
 * 不推論其他 Request/Response/subrequest 的 I/O context 契約。
 * 第二個測試強制驅逐實例後檢查延遲寫入未發生；不驗證 production 驅逐時序，
 * 也不對平台是否產生紀錄或告警作保證。In-memory fiber 不能作為持久工作紀錄。
 */
import { env, evictDurableObject, runInDurableObject } from "cloudflare:test";
import { Effect, Exit, Fiber } from "effect";
import { describe, expect, it } from "vitest";
import type { ChatState } from "../src/example/chat.js";
import type { ChatAgent } from "../src/index.js";

const stubFor = (name: string) => env.ChatAgent.get(env.ChatAgent.idFromName(name));

describe("跨 handler 的 fiber", () => {
  it("後續 handler 等待的 fiber 仍能存取同一 DO storage", async () => {
    const stub = stubFor("io-context");
    const holder: { fiber?: Fiber.RuntimeFiber<unknown, unknown> } = {};

    await runInDurableObject(stub, (_instance, ctx) => {
      holder.fiber = Effect.runFork(
        Effect.gen(function* () {
          yield* Effect.sleep("20 millis");
          yield* Effect.promise(() => ctx.storage.put("probe", "ok"));
          return yield* Effect.promise(() => ctx.storage.get("probe"));
        })
      );
    });

    const exit = await runInDurableObject(
      stub,
      async () =>
        await Effect.runPromise(
          Fiber.await(holder.fiber!) as Effect.Effect<Exit.Exit<unknown, unknown>>
        )
    );

    expect(Exit.isSuccess(exit)).toBe(true);
    expect(Exit.isSuccess(exit) ? exit.value : null).toBe("ok");
  });

  it("強制驅逐後，未被等待的 fiber 不會完成延遲寫入", async () => {
    const stub = stubFor("fork-lost");

    await runInDurableObject(stub, (instance: ChatAgent) => {
      instance.setState({ messages: [], phase: { _tag: "Idle" }, seq: 0 });
      // 一個「稍後才會把結果寫回狀態」的背景工作 —— Effect 使用者的自然寫法。
      Effect.runFork(
        Effect.gen(function* () {
          yield* Effect.sleep("500 millis");
          const state = instance.state as ChatState;
          instance.setState({ ...state, seq: 999 });
        })
      );
    });

    // 強制清掉實例；timer 的存在會影響正常休眠資格，這不是 production 時序測試。
    await evictDurableObject(stub);
    await new Promise((resolve) => setTimeout(resolve, 800));

    await runInDurableObject(stub, (instance: ChatAgent) => {
      const state = instance.state as ChatState;
      // 只斷言延遲寫入未完成；不把本地結果推論成平台可觀測性保證。
      expect(state.seq).toBe(0);
    });
  });
});
