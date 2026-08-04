/**
 * AgentDef —— 對應 `Jido.Agent`（jido/lib/jido/agent.ex）。
 *
 * Jido moduledoc 的三條不變式，這裡一條不改地照搬：
 *
 *   > - The returned `agent` is **always complete** — no "apply directives" step needed
 *   > - `directives` are **external effects only** — they never modify agent state
 *   > - `cmd/2` is a **pure function** — given same inputs, always same outputs
 *
 * 所以 `cmd` 的型別是同步的純函式，**簽章裡沒有 Effect**。這是刻意的：
 * Effect 只出現在 Action 的葉節點（core/action.ts）跟 shell（runtime/shell.ts）。
 * agent 的決策邏輯不需要 Effect，也就不需要 runtime、不需要 Layer、不需要 DO 就能測。
 *
 * ## 為什麼 `cmd` 必須是純的，在 Durable Object 上比在 BEAM 上更重要
 *
 * DO 會 hibernate。每次醒來 `onStart()` 都會重跑一次（等同 OTP 的 `init/1`）。
 * 如果決策邏輯裡摻了 I/O、時鐘、亂數，你就無法回答「我現在被驅逐，醒來還能不能
 * 接續？」這個問題 —— 而在 DO 上這個問題每 70–140 秒就被問一次。
 *
 * 純函式讓答案永遠是「可以」：狀態是完整的，重放同一個 action 得到同一個結果。
 *
 * ## 推論：時間與亂數是輸入，不是環境
 *
 * `cmd` 裡不准出現 `Date.now()` / `crypto.randomUUID()`。需要的話由 shell 在
 * 邊界取好，放進 action payload 傳進來。這也是 snapshot test 能成立的前提。
 */
import type { Schema } from "effect";
import type { Directive } from "./directive.js";

export interface TaggedAction {
  readonly _tag: string;
}

export interface CmdResult<S, A> {
  /** 已經完整的最終狀態。不需要再套用任何 directive。 */
  readonly state: S;
  /** 純粹出站的外部效果描述。 */
  readonly directives: ReadonlyArray<Directive<A>>;
}

export interface AgentDef<S, A extends TaggedAction> {
  readonly name: string;
  /**
   * 狀態 schema。在信任邊界驗證：DO 每次醒來從 SQLite 讀回時。
   * 由 `DirectiveAgent.onStart()` 實際執行 —— 驗證失敗會把 agent 隔離。
   */
  readonly state: Schema.Schema<S, any>;
  readonly initialState: S;
  /** 純函式。同樣輸入永遠同樣輸出。 */
  readonly cmd: (state: S, action: A) => CmdResult<S, A>;
  /**
   * 自我修復。純函式：看著狀態回答「要把自己修回一致，該做哪個 action？」
   * 不需要修就回 `null`。
   *
   * ## 為什麼需要這個
   *
   * `dispatch` 是「先寫狀態、再送效果」，但這兩步**不在同一個交易裡**：
   * 狀態走 `setState`，排程走 `this.schedule()`，是兩次獨立、可獨立失敗的寫入。
   * DO 只提供同步的 `ctx.storage.transactionSync()`，跨不過 `await`，而
   * `schedule()` 是 async —— 所以這個窗口**在平台層面關不起來**。
   *
   * 既然關不起來，就只能讓它可偵測、可修復：把「我應該有一個守衛，期限是 T」
   * 寫進**狀態本身**，而不是只依賴排程表裡那一列存不存在。這樣醒來時的修復
   * 只需要看狀態，不需要去問另一個可能根本沒寫成功的地方。
   *
   * `now` 由 shell 在邊界取好傳進來 —— 規則 1（時間是輸入，不是環境）照舊成立。
   */
  readonly reconcile?: (state: S, now: number) => A | null;
}

export const defineAgent = <S, A extends TaggedAction>(
  def: AgentDef<S, A>
): AgentDef<S, A> => def;

/** 沒有任何外部效果的 `cmd` 回傳值。 */
export const only = <S, A>(state: S): CmdResult<S, A> => ({
  state,
  directives: []
});

/** 狀態不變、只送出效果。 */
export const effects = <S, A>(
  state: S,
  directives: ReadonlyArray<Directive<A>>
): CmdResult<S, A> => ({ state, directives });
