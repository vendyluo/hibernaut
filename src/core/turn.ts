/**
 * 回合守衛 —— 對話型 agent 的共同不變式，從第一個真實應用的逐字重複中回流。
 *
 * 一個「回合」是：收到輸入 → 進入 Busy/Awaiting → 外部呼叫來回若干次 → 回到 Idle。
 * 這裡固化三件每個對話型 agent 都要做對的事：
 *
 *   1. requestId 從單調 seq 導出（純的、可重放，不用 crypto）
 *   2. 期限寫進狀態本身（`deadlineAt`），修復時只看狀態、不問排程表
 *   3. 醒來時的修復決策：過期就地逾時，未到就補排守衛（冪等）
 *
 * 這裡刻意**不**固化 phase 的形狀 —— 每個 agent 的 Busy phase 各有業務欄位
 * （chat 是 `AwaitingModel`，tool-loop agent 還會帶 round 等）。守衛只要求
 * 兩個欄位存在（`TurnGuard`）。
 */

/** Busy 類 phase 至少要帶的守衛欄位。 */
export interface TurnGuard {
  readonly requestId: string;
  /** 整輪的期限（epoch ms）。 */
  readonly deadlineAt: number;
}

/**
 * 由 seq 導出下一個請求。seq 耗盡（極端防禦）回 `null`，呼叫端應拒絕本輪。
 */
export const nextRequest = (
  seq: number
): { readonly seq: number; readonly requestId: string } | null =>
  seq >= Number.MAX_SAFE_INTEGER
    ? null
    : { seq: seq + 1, requestId: `req-${seq + 1}` };

/** 期限 = 邊界取好的 now + 逾時秒數。 */
export const guardDeadline = (now: number, timeoutSeconds: number): number =>
  now + timeoutSeconds * 1_000;

/**
 * 醒來時的守衛修復決策。純函式，`now` 由 shell 在邊界傳入。
 *
 * 只看狀態、不看排程表 —— 排程表那一列正是可能沒寫成功的東西
 * （`setState` 與 `schedule()` 是兩次可獨立失敗的寫入）。
 *
 * 不在 Busy（`guard === null`）→ 不用修。
 * 期限已過 → `onExpired`：不管守衛在不在，直接就地逾時。
 * 期限未到 → `onRearm`：把守衛補排回來；配合 `idempotent` 排程不會長出重複列。
 */
export const reconcileTurn = <A>(
  guard: TurnGuard | null,
  now: number,
  onExpired: (requestId: string) => A,
  onRearm: (requestId: string, remainingSeconds: number) => A
): A | null => {
  if (guard === null) return null;
  if (now >= guard.deadlineAt) return onExpired(guard.requestId);
  return onRearm(
    guard.requestId,
    Math.max(1, Math.ceil((guard.deadlineAt - now) / 1_000))
  );
};
