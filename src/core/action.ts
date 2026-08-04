/**
 * Action —— 對應 `Jido.Action`（agentjido/jido_action/lib/jido_action.ex）。
 *
 * Action 是「可組合的執行單元」：有 input schema、有 output schema、有一個 `run`。
 * Jido 的關鍵設計是 Action **不需要 process 就能測**；這裡的對應是
 * **Action 不需要 Durable Object、不需要 miniflare 就能測**。
 *
 * Action 是這份架構裡唯一允許做 I/O 的地方，也是唯一需要 Effect 的地方。
 * `cmd` 是純的（見 core/agent.ts），shell 是薄的（見 runtime/shell.ts）。
 */
import { Data, Duration, Effect, Schedule, Schema } from "effect";

export class ActionError extends Data.TaggedError("ActionError")<{
  readonly action: string;
  readonly message: string;
}> {}

export interface RetryPolicy {
  /** 單次 handler 內的重試次數。跨 hibernation 的重試不歸這裡管。 */
  readonly maxRetries: number;
  /** 初始退避，每次加倍。對應 jido_action 的 `:backoff`。 */
  readonly backoffMs: number;
}

export interface Action<I, O, R = never> {
  readonly name: string;
  readonly input: Schema.Schema<I, any>;
  readonly output: Schema.Schema<O, any>;
  readonly run: (input: I) => Effect.Effect<O, ActionError, R>;
  /**
   * 單次執行的上限。對應 jido_action `Jido.Exec` 的 `:timeout`（預設 30_000）。
   *
   * 這裡刻意設 25 秒而不是 30 秒：Workers 的請求有自己的時間預算，
   * 留一點餘裕讓 timeout 錯誤能走完 `cmd` 並把狀態寫回去，而不是被平台硬砍。
   */
  readonly timeoutMs?: number;
  readonly retry?: RetryPolicy;
}

/**
 * Registry 是異質集合（每個 Action 的 I/O 型別都不同），這裡的 `any` 是刻意的：
 * 型別安全在 Action 定義處與 `runAction` 的 schema 驗證處成立，不在 registry 這層。
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyAction<R = never> = Action<any, any, R>;
export type ActionRegistry<R = never> = Readonly<Record<string, AnyAction<R>>>;

export const defineAction = <I, O, R = never>(
  action: Action<I, O, R>
): Action<I, O, R> => action;

const DEFAULT_TIMEOUT_MS = 25_000;

/**
 * 驗證輸入 → 執行 → 驗證輸出，全部收斂成 `ActionError`。
 *
 * 這裡的 `Effect.retry` / `Effect.timeout` 是**單次 handler 內**的策略。
 * 它們活在記憶體裡，DO 一被驅逐就沒了 —— 這是對的，因為它們本來就只該負責
 * 「這一次呼叫的瞬時失敗」。真正需要跨時間的重試請用 `ScheduleAction` directive，
 * 或 `this.schedule()` 的 `retry` 選項。
 */
export const runAction = <I, O, R>(
  action: Action<I, O, R>,
  params: unknown
): Effect.Effect<O, ActionError, R> => {
  const wrap = (message: string) =>
    new ActionError({ action: action.name, message });

  const executed = Schema.decodeUnknown(action.input)(params).pipe(
    Effect.mapError((e) => wrap(`invalid input: ${e.message}`)),
    Effect.flatMap(action.run),
    Effect.flatMap((out) =>
      Schema.validate(action.output)(out).pipe(
        Effect.mapError((e) => wrap(`invalid output: ${e.message}`))
      )
    )
  );

  const retried =
    action.retry === undefined
      ? executed
      : Effect.retry(executed, {
          times: action.retry.maxRetries,
          schedule: Schedule.exponential(
            Duration.millis(action.retry.backoffMs)
          )
        });

  return retried.pipe(
    Effect.timeoutFail({
      duration: Duration.millis(action.timeoutMs ?? DEFAULT_TIMEOUT_MS),
      onTimeout: () => wrap("timed out")
    })
  );
};
