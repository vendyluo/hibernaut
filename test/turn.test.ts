/**
 * 回合守衛工具組 —— 純函式，零平台。
 * 行為面的驗證在 chat 的 reconcile 測試裡；這裡釘邊界條件。
 */
import { describe, expect, it } from "vitest";
import { guardDeadline, nextRequest, reconcileTurn } from "../src/core/turn.js";

describe("nextRequest", () => {
  it("由 seq 導出單調遞增的 requestId", () => {
    expect(nextRequest(0)).toEqual({ seq: 1, requestId: "req-1" });
    expect(nextRequest(41)).toEqual({ seq: 42, requestId: "req-42" });
  });

  it("seq 耗盡回 null，不會 wrap", () => {
    expect(nextRequest(Number.MAX_SAFE_INTEGER)).toBeNull();
  });
});

describe("guardDeadline", () => {
  it("期限 = now + 秒數（epoch ms）", () => {
    expect(guardDeadline(1_000, 60)).toBe(61_000);
  });
});

describe("reconcileTurn", () => {
  const expired = (requestId: string) => ({ kind: "expired", requestId });
  const rearm = (requestId: string, remainingSeconds: number) => ({
    kind: "rearm",
    requestId,
    remainingSeconds
  });

  it("不在 Busy → 不用修", () => {
    expect(reconcileTurn(null, 0, expired, rearm)).toBeNull();
  });

  it("期限已過 → 就地逾時", () => {
    const guard = { requestId: "req-1", deadlineAt: 1_000 };
    expect(reconcileTurn(guard, 1_000, expired, rearm)).toEqual({
      kind: "expired",
      requestId: "req-1"
    });
  });

  it("期限未到 → 補排守衛，秒數無條件進位", () => {
    const guard = { requestId: "req-2", deadlineAt: 10_500 };
    expect(reconcileTurn(guard, 9_000, expired, rearm)).toEqual({
      kind: "rearm",
      requestId: "req-2",
      remainingSeconds: 2
    });
  });

  it("剩餘時間不足 1 秒仍排 1 秒，不會排出 0 或負數", () => {
    const guard = { requestId: "req-3", deadlineAt: 1_100 };
    expect(reconcileTurn(guard, 1_099, expired, rearm)).toEqual({
      kind: "rearm",
      requestId: "req-3",
      remainingSeconds: 1
    });
  });
});
