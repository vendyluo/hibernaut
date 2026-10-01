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
 * process 執行掉。本模板選擇純資料契約；其中 ScheduleAction.action 會被寫進
 * SDK 排程表跨越 activation，RunInstruction 本身不會被持久化或重放。
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
 * 本模板用它建立持久逾時守衛，排程失敗時會提早執行 action 並中止本批效果。
 * action 必須能安全提早終結回合，不能拿來排一般工作或遞迴補排自己。
 * 記憶體內的 sleep/retry 不會跨實例重建；官方 durable execution / Workflows
 * 是不同的持久執行選項，見 NOTES.md。
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
 * 再產生下一個持久化狀態。中斷後只恢復領域狀態，不能恢復原本執行位置；
 * 外部呼叫可能已成功而結果遺失，必須由應用定義冪等與補償策略。
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

export type Directive<A> = Emit | ScheduleAction<A> | RunInstruction | Fail | Stop;

/** `RunInstruction` 執行完之後，送回 `cmd` 的結果形狀。 */
export type Outcome =
  | { readonly _tag: "Ok"; readonly value: unknown }
  | { readonly _tag: "Err"; readonly message: string };

export const emit = (event: string, payload: unknown): Emit => ({
  _tag: "Emit",
  event,
  payload,
});

export const scheduleAction = <A>(delaySeconds: number, action: A): ScheduleAction<A> => ({
  _tag: "ScheduleAction",
  delaySeconds,
  action,
});

export const runInstruction = (
  action: string,
  params: unknown,
  resultAction: string,
  meta?: Readonly<Record<string, unknown>>,
): RunInstruction =>
  meta === undefined
    ? { _tag: "RunInstruction", action, params, resultAction }
    : { _tag: "RunInstruction", action, params, resultAction, meta };

export const fail = (reason: string, detail?: unknown): Fail =>
  detail === undefined ? { _tag: "Fail", reason } : { _tag: "Fail", reason, detail };

export const stop = (): Stop => ({ _tag: "Stop" });
