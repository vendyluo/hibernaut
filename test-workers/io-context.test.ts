/**
 * Spike 2：Effect fiber 活過原本的 handler 之後會怎樣。
 *
 * 這支 spike 推翻了我原本的假設，結果比假設更值得記下來。
 *
 * 我原本以為：fork 出去的 fiber 稍後做 I/O 會噴
 * `Cannot perform I/O on behalf of a different request`。
 *
 * 實測不會 —— 至少對 Durable Object 的 storage 不會。DO 的 `ctx.storage` 綁在
 * 物件本身而不是某一次請求，所以跨 handler 存取是合法的。
 * （那個錯誤真正管的是從別次 incoming request 抓來的物件，例如 Request/Response
 * 的 body 或在別的 context 發起的 subrequest。）
 *
 * 但**真正的危險沒有消失，只是換了名字**：fork 出去的工作沒有人等它，
 * DO 可以在它跑到一半時就被回收，而它做到一半的事會無聲消失 ——
 * 不會有例外、不會有紀錄。這比噴錯還糟，因為它不會出現在任何告警上。
 *
 * 結論不變，理由要換：**不要用 `Effect.fork` 承載跨 handler 的工作。**
 * 不是因為它會被平台擋下來，是因為它不會 —— 它只會安靜地不見。
 */
import { env, evictDurableObject, runInDurableObject } from "cloudflare:test";
import { Effect, Exit, Fiber } from "effect";
import { describe, expect, it } from "vitest";
import type { ChatState } from "../src/example/chat.js";
import type { ChatAgent } from "../src/index.js";

const stubFor = (name: string) => env.ChatAgent.get(env.ChatAgent.idFromName(name));

describe("跨 handler 的 fiber", () => {
  it("fork 出去的 fiber 之後仍能存取 DO storage（我原本的警告過寬）", async () => {
    const stub = stubFor("io-context");
    const holder: { fiber?: Fiber.RuntimeFiber<unknown, unknown> } = {};

    await runInDurableObject(stub, (instance: ChatAgent) => {
      holder.fiber = Effect.runFork(
        Effect.gen(function* () {
          yield* Effect.sleep("20 millis");
          yield* Effect.promise(() => instance.ctx.storage.put("probe", "ok"));
          return yield* Effect.promise(() => instance.ctx.storage.get("probe"));
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

  it("但 fork 出去的工作會在驅逐時無聲消失，沒有任何錯誤", async () => {
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

    // DO 在背景工作完成前就被回收。真實環境裡這只需要沒有流量就會發生。
    await evictDurableObject(stub);
    await new Promise((resolve) => setTimeout(resolve, 800));

    await runInDurableObject(stub, (instance: ChatAgent) => {
      const state = instance.state as ChatState;
      // 沒有例外、沒有告警、沒有紀錄 —— 那個工作就是沒發生。
      expect(state.seq).toBe(0);
    });
  });
});
