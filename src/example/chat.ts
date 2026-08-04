/**
 * 範例：一個會呼叫模型的對話 agent。
 *
 * 這支檔案示範在 Durable Object 上非做不可、但示範程式碼幾乎都會漏掉的事。
 * 全部都是 BEAM 上的老習慣：
 *
 * 1. **用 requestId 做關聯，對過期的回應直接丟掉。**
 *    directive 走 `this.schedule()`，那是 at-least-once 的。同一個 `ModelResult`
 *    可能送達兩次；hibernation 後醒來也可能收到上一輪的殘留。這等同 OTP 裡收到
 *    過期 monitor ref 的 `handle_info` —— 你不會去信任它，你會比對 ref 然後忽略。
 *
 * 2. **逾時用另一個 schedule，而不是取消。**
 *    成功時那個 `ModelTimeout` 還是會照樣送達，然後被第 1 點的守衛忽略掉。
 *
 * 3. **忙碌時明確拒絕，而不是排隊。**
 *    DO 是單執行緒且序列化的，沒有 BEAM 的公平調度。
 *
 * 4. **時間不是從環境讀的。**
 *    `cmd` 裡沒有 `Date.now()`；`now` 由 shell 在邊界取好放進 action payload。
 *
 * 5. **守衛的期限寫在狀態裡，不是只寫在排程表裡。**
 *    `setState` 與 `this.schedule()` 是兩次可獨立失敗的寫入，中間的窗口在平台層面
 *    關不起來（見 `core/agent.ts` 的 `reconcile` 說明）。所以 `AwaitingModel` 帶著
 *    `deadlineAt`，醒來時只看狀態就能判斷「我該有守衛嗎？」並自行補回來。
 *
 * 6. **所有會被持久化的東西都有上限。**
 *    訊息長度、歷史長度都設界並寫進 schema。DO 的狀態會一直存在，沒有上限
 *    就等於把儲存與 LLM 成本的控制權交給 client。
 */
import { Context, Effect, Schema } from "effect";
import { defineAction, type ActionError } from "../core/action.js";
import { defineAgent, only, type CmdResult } from "../core/agent.js";
import {
  emit,
  runInstruction,
  scheduleAction,
  type Outcome
} from "../core/directive.js";

// ---------------------------------------------------------------------------
// 容量上限 —— schema、cmd、邊界三處共用同一組常數
// ---------------------------------------------------------------------------

/** 單則訊息上限。邊界依 UTF-8 byte 長度擋，schema 依字元數當不變式（bytes >= chars）。 */
export const MAX_MESSAGE_CHARS = 4_096;
/** 保留最近幾則。超過就從頭裁掉。 */
export const MAX_HISTORY_MESSAGES = 40;

const MODEL_TIMEOUT_SECONDS = 60;

// ---------------------------------------------------------------------------
// 狀態
// ---------------------------------------------------------------------------

const MessageText = Schema.String.pipe(Schema.maxLength(MAX_MESSAGE_CHARS));

const Message = Schema.Struct({
  role: Schema.Literal("user", "assistant"),
  text: MessageText
});
export type Message = Schema.Schema.Type<typeof Message>;

const Phase = Schema.Union(
  Schema.Struct({ _tag: Schema.Literal("Idle") }),
  Schema.Struct({
    _tag: Schema.Literal("AwaitingModel"),
    requestId: Schema.String,
    /** 守衛應該在什麼時候到期（epoch ms）。修復時只靠這個，不靠排程表。 */
    deadlineAt: Schema.Number
  })
);

export const ChatState = Schema.Struct({
  messages: Schema.Array(Message).pipe(
    Schema.maxItems(MAX_HISTORY_MESSAGES)
  ),
  phase: Phase,
  /** 單調遞增。同時當作 requestId 的來源 —— 純的、可重放的。 */
  seq: Schema.Number.pipe(
    Schema.int(),
    Schema.between(0, Number.MAX_SAFE_INTEGER)
  )
});
export type ChatState = Schema.Schema.Type<typeof ChatState>;

export const initialChatState: ChatState = {
  messages: [],
  phase: { _tag: "Idle" },
  seq: 0
};

// ---------------------------------------------------------------------------
// Action（agent 的輸入字母表）
// ---------------------------------------------------------------------------

export type ChatAction =
  | { readonly _tag: "UserMessage"; readonly text: string; readonly now: number }
  | {
      readonly _tag: "ModelResult";
      readonly requestId: string;
      readonly outcome: Outcome;
    }
  | { readonly _tag: "ModelTimeout"; readonly requestId: string }
  | {
      readonly _tag: "RearmGuard";
      readonly requestId: string;
      readonly remainingSeconds: number;
    };

// ---------------------------------------------------------------------------
// cmd —— 純函式。沒有 Effect、沒有 I/O、沒有時鐘。
// ---------------------------------------------------------------------------

const truncate = (text: string): string => {
  if (text.length <= MAX_MESSAGE_CHARS) return text;

  const truncated = text.slice(0, MAX_MESSAGE_CHARS);
  const last = truncated.charCodeAt(truncated.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? truncated.slice(0, -1) : truncated;
};

/** 追加並裁掉最舊的，維持 schema 的 maxItems 不變式。 */
const append = (
  messages: ReadonlyArray<Message>,
  message: Message
): ReadonlyArray<Message> =>
  [...messages, message].slice(-MAX_HISTORY_MESSAGES);

const cmd = (
  state: ChatState,
  action: ChatAction
): CmdResult<ChatState, ChatAction> => {
  switch (action._tag) {
    case "UserMessage": {
      // (3) 忙碌時明確拒絕。DO 不會幫你公平調度。
      if (state.phase._tag === "AwaitingModel") {
        return {
          state,
          directives: [emit("busy", { reason: "awaiting model response" })]
        };
      }

      if (state.seq >= Number.MAX_SAFE_INTEGER) {
        return {
          state,
          directives: [emit("error", { message: "request sequence exhausted" })]
        };
      }

      const seq = state.seq + 1;
      const requestId = `req-${seq}`;
      const messages = append(state.messages, {
        role: "user",
        text: truncate(action.text)
      });

      return {
        state: {
          messages,
          // (5) 期限進狀態，修復時不必依賴排程表。
          phase: {
            _tag: "AwaitingModel",
            requestId,
            deadlineAt: action.now + MODEL_TIMEOUT_SECONDS * 1_000
          },
          seq
        },
        directives: [
          // (2) 逾時守衛。成功時它照樣會來，然後被忽略。
          scheduleAction(MODEL_TIMEOUT_SECONDS, {
            _tag: "ModelTimeout",
            requestId
          } as const),
          // 呼叫模型：狀態已經記下「我在等 requestId」，之後被驅逐也接得回來。
          runInstruction("callModel", { messages }, "ModelResult", { requestId })
        ]
      };
    }

    case "ModelResult": {
      // (1) 過期回應直接丟。at-least-once 的必要守衛。
      if (!isAwaiting(state, action.requestId)) return only(state);

      if (action.outcome._tag === "Err") {
        return {
          state: { ...state, phase: { _tag: "Idle" } },
          directives: [emit("error", { message: action.outcome.message })]
        };
      }

      const text = extractText(action.outcome.value);
      if (text === null) {
        return {
          state: { ...state, phase: { _tag: "Idle" } },
          directives: [emit("error", { message: "malformed model output" })]
        };
      }

      return {
        state: {
          ...state,
          messages: append(state.messages, { role: "assistant", text }),
          phase: { _tag: "Idle" }
        },
        directives: [emit("message", { role: "assistant", text })]
      };
    }

    case "ModelTimeout": {
      // 正常路徑就是走到這裡被忽略 —— 結果早就回來了。
      if (!isAwaiting(state, action.requestId)) return only(state);
      return {
        state: { ...state, phase: { _tag: "Idle" } },
        directives: [emit("error", { message: "model timed out" })]
      };
    }

    case "RearmGuard": {
      // 由 reconcile 產生：狀態說我該有守衛，但可能沒排成功。重排是冪等的。
      if (!isAwaiting(state, action.requestId)) return only(state);
      return {
        state,
        directives: [
          scheduleAction(action.remainingSeconds, {
            _tag: "ModelTimeout",
            requestId: action.requestId
          } as const)
        ]
      };
    }
  }
};

const isAwaiting = (state: ChatState, requestId: string): boolean =>
  state.phase._tag === "AwaitingModel" && state.phase.requestId === requestId;

const extractText = (value: unknown): string | null => {
  if (typeof value === "object" && value !== null && "text" in value) {
    const text = (value as { text: unknown }).text;
    if (typeof text === "string") return truncate(text);
  }
  return null;
};

/**
 * 自我修復。純函式，`now` 由 shell 傳入。
 *
 * 只看狀態，不看排程表 —— 因為排程表那一列正是可能沒寫成功的東西。
 */
const reconcile = (state: ChatState, now: number): ChatAction | null => {
  if (state.phase._tag !== "AwaitingModel") return null;

  // 期限已過：不管守衛在不在，直接就地逾時。
  if (now >= state.phase.deadlineAt) {
    return { _tag: "ModelTimeout", requestId: state.phase.requestId };
  }

  // 期限未到：把守衛補排回來。`idempotent` 讓重複補排不會長出多列。
  return {
    _tag: "RearmGuard",
    requestId: state.phase.requestId,
    remainingSeconds: Math.max(
      1,
      Math.ceil((state.phase.deadlineAt - now) / 1_000)
    )
  };
};

export const chatAgent = defineAgent<ChatState, ChatAction>({
  name: "chat",
  state: ChatState,
  initialState: initialChatState,
  cmd,
  reconcile
});

// ---------------------------------------------------------------------------
// Action 實作（唯一允許出現 I/O 與 Effect 的地方）
// ---------------------------------------------------------------------------

export class ModelClient extends Context.Tag("ModelClient")<
  ModelClient,
  {
    readonly complete: (
      messages: ReadonlyArray<Message>
    ) => Effect.Effect<string, ActionError>;
  }
>() {}

export const callModel = defineAction({
  name: "callModel",
  input: Schema.Struct({ messages: Schema.Array(Message) }),
  output: Schema.Struct({ text: Schema.String }),
  timeoutMs: 25_000,
  // 單次 handler 內的瞬時重試。跨 hibernation 的重試不歸這裡管。
  retry: { maxRetries: 2, backoffMs: 250 },
  run: ({ messages }) =>
    ModelClient.pipe(
      Effect.flatMap((client) => client.complete(messages)),
      Effect.map((text) => ({ text }))
    )
});

export const chatActions = { callModel };
