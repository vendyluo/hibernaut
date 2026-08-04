/**
 * Directive —— 對應 `Jido.Agent.Directive`（jido/lib/jido/agent/directive.ex）。
 *
 * 一條 directive 是「外部效果的純描述」。`cmd` 只**產生** directive，永遠不執行它；
 * 執行是 runtime shell 的事。Jido 的原文：
 *
 *   > Agents and strategies **never** interpret or execute directives; they only emit them.
 *
 * ## 兩條不變式（照抄 Jido，不要自己發明）
 *
 * 1. **狀態變更不是 directive。**
 *    `cmd` 回傳的 state 已經是完整最終狀態，不需要「套用 directive」這一步。
 *    directive 只描述「要對外界做什麼」，永遠不會回頭改 state。
 *
 * 2. **directive 是嚴格單向出站的。**
 *    agent 不會收到 directive 當輸入。外界的回音要走 `RunInstruction.resultAction`
 *    重新進入 `cmd`，變成一個新的 action。
 *
 * ## Cloudflare 特有的額外約束：directive 必須可序列化
 *
 * 在 BEAM 上 directive 可以塞 pid、closure、任意 term，因為它馬上就被同一個
 * process 執行掉。在 Durable Object 上不行 —— directive 會被寫進
 * `cf_agents_schedules` 這張 SQLite 表、跨越 hibernation 之後才執行。
 *
 * 所以：**directive 裡不准有 function、Promise、Effect、或任何帶身分的物件。**
 * 只能是純資料。這就是為什麼 `RunInstruction.resultAction` 是一個字串 tag 而不是
 * 一個 callback —— callback 活不過驅逐。
 */

/** 對外送出一個事件（廣播給連線中的 WebSocket，或轉給其他 binding）。 */
export interface Emit {
  readonly _tag: "Emit";
  readonly event: string;
  readonly payload: unknown;
}

/**
 * 延遲後把一個 action 重新送回 `cmd`。對應 `%Directive.Schedule{}`。
 *
 * 這是「跨越單次 handler 的等待」唯一被允許的做法。不要用 `Effect.sleep`、
 * 不要用 `setTimeout`、不要用 `Effect.retry` 去等超過這次 handler 的東西 ——
 * DO 大約 70–140 秒沒活動就被驅逐，那些全部會消失。
 * `this.schedule()` 是寫進 SQLite 用 alarm 喚醒的，才是真的持久。
 */
export interface ScheduleAction<A> {
  readonly _tag: "ScheduleAction";
  readonly delaySeconds: number;
  readonly action: A;
}

/**
 * 執行一個 Action，並把結果**當成新的 action 送回 `cmd`**。
 * 對應 `%Directive.RunInstruction{instruction, result_action}`。
 *
 * 這是整份設計最重要的一個東西。它讓每一次外部呼叫（LLM、HTTP、DB）都變成
 * 一個**狀態轉移邊界**：呼叫前的狀態已經持久化，呼叫後的結果以新 action 進來
 * 再產生下一個持久化狀態。中間被 hibernate 掉也無所謂 —— 醒來時狀態是完整的，
 * 不會停在某個「函式執行到一半」的位置，因為根本沒有這種位置。
 */
export interface RunInstruction {
  readonly _tag: "RunInstruction";
  /** Action registry 的鍵。 */
  readonly action: string;
  /** 原始參數，交給 Action 的 input schema 驗證。 */
  readonly params: unknown;
  /** 結果要以哪個 action tag 送回 `cmd`。必須是字串：closure 活不過 hibernation。 */
  readonly resultAction: string;
  /** 原樣回傳到結果 payload 的 metadata，用來做關聯（例如 requestId）。 */
  readonly meta?: Readonly<Record<string, unknown>>;
}

/** 回報一個不可恢復的錯誤。對應 `%Directive.Error{}`。 */
export interface Fail {
  readonly _tag: "Fail";
  readonly reason: string;
  readonly detail?: unknown;
}

/** 請求 runtime 收掉這個 agent。對應 `%Directive.Stop{}`。 */
export interface Stop {
  readonly _tag: "Stop";
}

export type Directive<A> =
  | Emit
  | ScheduleAction<A>
  | RunInstruction
  | Fail
  | Stop;

/** `RunInstruction` 執行完之後，送回 `cmd` 的結果形狀。 */
export type Outcome =
  | { readonly _tag: "Ok"; readonly value: unknown }
  | { readonly _tag: "Err"; readonly message: string };

export const emit = (event: string, payload: unknown): Emit => ({
  _tag: "Emit",
  event,
  payload
});

export const scheduleAction = <A>(
  delaySeconds: number,
  action: A
): ScheduleAction<A> => ({ _tag: "ScheduleAction", delaySeconds, action });

export const runInstruction = (
  action: string,
  params: unknown,
  resultAction: string,
  meta?: Readonly<Record<string, unknown>>
): RunInstruction =>
  meta === undefined
    ? { _tag: "RunInstruction", action, params, resultAction }
    : { _tag: "RunInstruction", action, params, resultAction, meta };

export const fail = (reason: string, detail?: unknown): Fail =>
  detail === undefined
    ? { _tag: "Fail", reason }
    : { _tag: "Fail", reason, detail };

export const stop = (): Stop => ({ _tag: "Stop" });
