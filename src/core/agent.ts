/**
 * AgentDef —— 對應 `Jido.Agent`（jido/lib/jido/agent.ex）。
 *
 * 以下是受 Jido 啟發的本地契約（不是逐字引用，來源見 THIRD_PARTY.md）：
 * 回傳完整 state；directive 描述外部效果；本模板的 cmd 是純函式。
 * Jido 的 Action 可以有副作用，不應把本地較嚴格的 cmd 契約當成 Jido 全部行為。
 *
 * 所以 `cmd` 的型別是同步的純函式，**簽章裡沒有 Effect**。這是刻意的：
 * Effect 只出現在 Action 的葉節點（core/action.ts）跟 shell（runtime/shell.ts）。
 * agent 的決策邏輯不需要 Effect，也就不需要 runtime、不需要 Layer、不需要 DO 就能測。
 *
 * ## 為什麼 `cmd` 必須是純的，在 Durable Object 上比在 BEAM 上更重要
 *
 * DO 會 hibernate。每次醒來 `onStart()` 都會重跑一次（等同 OTP 的 `init/1`）。
 * 如果決策邏輯裡摻了 I/O、時鐘、亂數，你就無法回答「我現在被驅逐，醒來還能不能
 * 接續？」這個問題。休眠／驅逐沒有固定週期，詳見 NOTES.md。
 *
 * 純函式讓狀態轉移可以重現；仍需要持久化、喚醒來源與領域恢復策略。
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
   * 儲存的是 JSON-compatible 的 S，驗證 schema 的 Type 側，不執行 decode/encode。
   * 轉換型 schema 不會自動遷移舊資料；migration 必須另行明確處理。
   */
  readonly state: Schema.Schema<S, any>;
  readonly initialState: S;
  /** 純函式。同樣輸入永遠同樣輸出。 */
  readonly cmd: (state: S, action: A) => CmdResult<S, A>;
  /**
   * 會進排程表的 action 子集的 schema。
   *
   * ## 為什麼需要這個
   *
   * 狀態醒來會過 `state` schema 驗證，但排程表（`cf_agents_schedules`）裡的
   * action payload 一樣是從 SQLite 讀回來的 —— 跨 hibernation、甚至跨部署存活。
   * 改版之後舊排程列帶著舊形狀的 payload 醒來，塞進 `cmd` 就是未定義行為。
   * 同一個信任邊界，就要有同一道驗證。
   *
   * 只需涵蓋**實際會被 `ScheduleAction` 排進去**的 action tag（通常是逾時守衛）。
   * 驗不過的排程回呼由 shell 丟棄並回報，不會進 `cmd`。
   * 與 state 相同，payload 必須已符合 Type 側；不在 callback 中轉換或正規化。
   *
   * 型別上刻意是 `any`（同 `ActionRegistry` 的理由）：這是 runtime 的信任邊界
   * 驗證，不是編譯期型別；子集 schema 的靜態型別窄於 `A`，宣告成 `Schema<A>`
   * 反而過不了 variance。
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly scheduledAction?: Schema.Schema<any, any>;
  /**
   * 自我修復。純函式：看著狀態回答「要把自己修回一致，該做哪個 action？」
   * 不需要修就回 `null`。
   *
   * ## 為什麼需要這個
   *
   * `dispatch` 是「先寫狀態、再送效果」，但這兩步**不在同一個交易裡**：
   * 狀態走 `setState`，排程走 `this.schedule()`，是兩次獨立、可獨立失敗的寫入。
   * 本實作沒有包住兩者的交易；這不是「平台只提供同步交易」的主張。
   *
   * 這裡選擇讓窗口可偵測、可修復：把「我應該有一個守衛，期限是 T」
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
