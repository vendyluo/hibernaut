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
  readonly phase?: "input" | "execution" | "output";
  /** Provider adapter decides whether this failure can safely be retried. */
  readonly retryable?: boolean;
}> {}

export interface RetryPolicy {
  /** 單次 handler 內的重試次數。跨 hibernation 的重試不歸這裡管。 */
  readonly maxRetries: number;
  /** 初始退避，每次加倍。對應 jido_action 的 `:backoff`。 */
  readonly backoffMs: number;
  /** Product policy; default retries only explicitly retryable execution failures. */
  readonly shouldRetry?: (error: ActionError) => boolean;
}

export interface Action<I, O, R = never> {
  readonly name: string;
  readonly input: Schema.Codec<I, any>;
  readonly output: Schema.Schema<O>;
  readonly run: (input: I) => Effect.Effect<O, ActionError, R>;
  /**
   * 整次 runAction（包含 retry / backoff）的應用層時間預算。
   * 預設 25 秒是範例政策，不是 Workers wall-clock 限制或平台保證。
   * 不涵蓋 shell 初始化或 ManagedRuntime 的 Layer 建立；它們需另設有界策略。
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

export const defineAction = <I, O, R = never>(action: Action<I, O, R>): Action<I, O, R> => action;

const DEFAULT_TIMEOUT_MS = 25_000;

/**
 * 驗證輸入 → 執行 → 驗證輸出，全部收斂成 `ActionError`。
 *
 * 這裡的 `Effect.retry` / `Effect.timeout` 是**單次 handler 內**的策略。
 * 它們活在記憶體裡，DO 一被驅逐就沒了 —— 這是對的，因為它們本來就只該負責
 * 「這一次呼叫的瞬時失敗」。跨 activation 的工作重試應另外採用官方 durable
 * execution / Workflows，或明確配置 SDK schedule 的 callback/retry 契約。
 * 本模板的 `ScheduleAction` 僅供可安全提早終結回合的守衛，不是工作重試佇列。
 */
export const runAction = <I, O, R>(
  action: Action<I, O, R>,
  params: unknown,
): Effect.Effect<O, ActionError, R> => {
  const wrap = (message: string, phase: "input" | "execution" | "output") =>
    new ActionError({ action: action.name, message, phase });

  const executed = Schema.decodeUnknownEffect(action.input)(params).pipe(
    Effect.mapError((e) => wrap(`invalid input: ${e.message}`, "input")),
    Effect.flatMap((input) =>
      action.run(input).pipe(
        Effect.mapError(
          (error) =>
            new ActionError({
              action: error.action,
              message: error.message,
              retryable: error.retryable,
              phase: "execution",
            }),
        ),
      ),
    ),
    Effect.flatMap((out) =>
      Schema.decodeUnknownEffect(Schema.toType(action.output))(out).pipe(
        Effect.mapError((e) => wrap(`invalid output: ${e.message}`, "output")),
      ),
    ),
  );

  const retried =
    action.retry === undefined
      ? executed
      : Effect.retry(executed, {
          times: action.retry.maxRetries,
          schedule: Schedule.exponential(Duration.millis(action.retry.backoffMs)),
          while:
            action.retry.shouldRetry ??
            ((error) => error.phase === "execution" && error.retryable === true),
        });

  return retried.pipe(
    Effect.timeoutOrElse({
      duration: Duration.millis(action.timeoutMs ?? DEFAULT_TIMEOUT_MS),
      orElse: () => Effect.fail(wrap("timed out", "execution")),
    }),
  );
};
