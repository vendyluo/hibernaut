/**
 * 這整支測試檔的重點是它**沒有** import 什麼：
 *
 *   沒有 `agents`、沒有 miniflare、沒有 wrangler、沒有 ManagedRuntime、沒有 Layer。
 *
 * 這正是 Jido 把 Action / Agent 跟 AgentServer 切開之後拿到的東西 ——
 * 「不用起 process 就能測」在這裡變成「不用起 Durable Object 就能測」。
 */
import { describe, expect, it } from "vitest";
import {
  chatAgent,
  initialChatState,
  MAX_HISTORY_MESSAGES,
  MAX_MESSAGE_CHARS,
  type ChatState
} from "../src/example/chat.js";

const { cmd, reconcile } = chatAgent;

/** 固定時鐘。`cmd` 讀不到時鐘，時間一律從外面傳進來。 */
const T0 = 1_700_000_000_000;
const TIMEOUT_MS = 60_000;

const awaiting = (requestId: string, deadlineAt = T0 + TIMEOUT_MS): ChatState => ({
  ...initialChatState,
  phase: { _tag: "AwaitingModel", requestId, deadlineAt },
  seq: 1
});

describe("chat agent cmd — 純決策", () => {
  it("使用者訊息會排好逾時守衛，才發出模型呼叫", () => {
    const { state, directives } = cmd(initialChatState, {
      _tag: "UserMessage",
      text: "hi",
      now: T0
    });

    expect(state.phase).toEqual({
      _tag: "AwaitingModel",
      requestId: "req-1",
      deadlineAt: T0 + TIMEOUT_MS
    });
    expect(state.messages).toEqual([{ role: "user", text: "hi" }]);

    // 順序有意義：守衛必須先於呼叫。
    expect(directives.map((d) => d._tag)).toEqual([
      "ScheduleAction",
      "RunInstruction"
    ]);
  });

  it("忙碌時拒絕新訊息，而不是讓 mailbox 長大", () => {
    const busy = awaiting("req-1");
    const { state, directives } = cmd(busy, {
      _tag: "UserMessage",
      text: "again",
      now: T0
    });

    expect(state).toBe(busy);
    expect(directives).toEqual([
      { _tag: "Emit", event: "busy", payload: { reason: "awaiting model response" } }
    ]);
  });

  it("過期的 ModelResult 被完全忽略（at-least-once 的必要守衛）", () => {
    const waiting = awaiting("req-2");
    const { state, directives } = cmd(waiting, {
      _tag: "ModelResult",
      requestId: "req-1", // 上一輪的殘留
      outcome: { _tag: "Ok", value: { text: "stale" } }
    });

    expect(state).toBe(waiting);
    expect(directives).toEqual([]);
  });

  it("重複送達同一個 ModelResult 是安全的", () => {
    const waiting: ChatState = {
      ...awaiting("req-1"),
      messages: [{ role: "user", text: "hi" }]
    };
    const action = {
      _tag: "ModelResult",
      requestId: "req-1",
      outcome: { _tag: "Ok", value: { text: "hello" } }
    } as const;

    const first = cmd(waiting, action);
    const second = cmd(first.state, action);

    expect(first.state.messages).toHaveLength(2);
    expect(second.state.messages).toHaveLength(2);
    expect(second.directives).toEqual([]);
  });

  it("結果回來之後，逾時守衛照樣送達但不造成傷害", () => {
    const idle: ChatState = { ...initialChatState, seq: 1 };
    const { state, directives } = cmd(idle, {
      _tag: "ModelTimeout",
      requestId: "req-1"
    });

    expect(state).toBe(idle);
    expect(directives).toEqual([]);
  });

  it("真的逾時才把 agent 拉回 Idle 並回報", () => {
    const { state, directives } = cmd(awaiting("req-1"), {
      _tag: "ModelTimeout",
      requestId: "req-1"
    });

    expect(state.phase).toEqual({ _tag: "Idle" });
    expect(directives).toEqual([
      { _tag: "Emit", event: "error", payload: { message: "model timed out" } }
    ]);
  });

  it("cmd 是純的：同樣輸入永遠同樣輸出", () => {
    const action = { _tag: "UserMessage", text: "hi", now: T0 } as const;
    expect(cmd(initialChatState, action)).toEqual(cmd(initialChatState, action));
  });

  it("序號用盡時拒絕新請求，不產生重複 requestId", () => {
    const exhausted: ChatState = {
      ...initialChatState,
      seq: Number.MAX_SAFE_INTEGER
    };

    const { state, directives } = cmd(exhausted, {
      _tag: "UserMessage",
      text: "hi",
      now: T0
    });

    expect(state).toBe(exhausted);
    expect(directives).toEqual([
      { _tag: "Emit", event: "error", payload: { message: "request sequence exhausted" } }
    ]);
  });
});

describe("reconcile — 排程可能沒寫成功時的自我修復", () => {
  it("Idle 不需要修復", () => {
    expect(reconcile?.(initialChatState, T0)).toBeNull();
  });

  it("期限未到就把守衛補排回來，剩餘秒數依 deadlineAt 算出", () => {
    const repair = reconcile?.(awaiting("req-1", T0 + 30_000), T0);
    expect(repair).toEqual({
      _tag: "RearmGuard",
      requestId: "req-1",
      remainingSeconds: 30
    });
  });

  it("期限已過就地逾時，不管排程表裡有沒有那一列", () => {
    const repair = reconcile?.(awaiting("req-1", T0 - 1), T0);
    expect(repair).toEqual({ _tag: "ModelTimeout", requestId: "req-1" });
  });

  it("RearmGuard 只重排守衛，不動狀態", () => {
    const waiting = awaiting("req-1");
    const { state, directives } = cmd(waiting, {
      _tag: "RearmGuard",
      requestId: "req-1",
      remainingSeconds: 30
    });

    expect(state).toBe(waiting);
    expect(directives).toEqual([
      {
        _tag: "ScheduleAction",
        delaySeconds: 30,
        action: { _tag: "ModelTimeout", requestId: "req-1" }
      }
    ]);
  });

  it("過期的 RearmGuard 被忽略", () => {
    const waiting = awaiting("req-2");
    const { state, directives } = cmd(waiting, {
      _tag: "RearmGuard",
      requestId: "req-1",
      remainingSeconds: 30
    });

    expect(state).toBe(waiting);
    expect(directives).toEqual([]);
  });

  it("修復路徑會走到 Idle：AwaitingModel → ModelTimeout → Idle", () => {
    const stuck = awaiting("req-1", T0 - 1);
    const repair = reconcile?.(stuck, T0);
    const { state } = cmd(stuck, repair!);

    expect(state.phase).toEqual({ _tag: "Idle" });
    expect(reconcile?.(state, T0)).toBeNull();
  });
});

describe("容量上限 — 持久狀態不能無界成長", () => {
  it("超長訊息被裁到上限", () => {
    const { state } = cmd(initialChatState, {
      _tag: "UserMessage",
      text: "x".repeat(MAX_MESSAGE_CHARS * 2),
      now: T0
    });

    expect(state.messages[0]!.text).toHaveLength(MAX_MESSAGE_CHARS);
  });

  it("超長的模型輸出也被裁到上限", () => {
    const { state } = cmd(awaiting("req-1"), {
      _tag: "ModelResult",
      requestId: "req-1",
      outcome: { _tag: "Ok", value: { text: "y".repeat(MAX_MESSAGE_CHARS * 2) } }
    });

    expect(state.messages.at(-1)!.text).toHaveLength(MAX_MESSAGE_CHARS);
  });

  it("模型輸出不會在上限邊界切斷 surrogate pair", () => {
    const { state } = cmd(awaiting("req-1"), {
      _tag: "ModelResult",
      requestId: "req-1",
      outcome: {
        _tag: "Ok",
        value: { text: `${"a".repeat(MAX_MESSAGE_CHARS - 1)}😀` }
      }
    });

    const text = state.messages.at(-1)!.text;
    expect(text).toBe("a".repeat(MAX_MESSAGE_CHARS - 1));
    expect(text).not.toContain("�");
  });

  it("連續對話不會讓歷史無界成長", () => {
    let state = initialChatState;

    for (let i = 0; i < MAX_HISTORY_MESSAGES * 2; i++) {
      state = cmd(state, {
        _tag: "UserMessage",
        text: `msg-${i}`,
        now: T0 + i
      }).state;
      state = cmd(state, {
        _tag: "ModelResult",
        requestId: `req-${i + 1}`,
        outcome: { _tag: "Ok", value: { text: `reply-${i}` } }
      }).state;
    }

    expect(state.messages).toHaveLength(MAX_HISTORY_MESSAGES);
    // 保留的是最新的，不是最舊的。
    expect(state.messages.at(-1)!.text).toBe(
      `reply-${MAX_HISTORY_MESSAGES * 2 - 1}`
    );
  });
});
