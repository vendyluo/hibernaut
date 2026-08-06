/**
 * 把純核心接到平台上。這支檔案應該一直很短。
 */
import { routeAgentRequest } from "agents";
import { Effect, Layer } from "effect";
import { ActionError } from "./core/action.js";
import {
  chatActions,
  chatAgent,
  initialChatState,
  MAX_MESSAGE_CHARS,
  ModelClient,
  type ChatAction,
  type ChatState
} from "./example/chat.js";
import { DirectiveAgent } from "./runtime/shell.js";

/**
 * 正式實作應該在這裡接 Workers AI binding 或 AI Gateway。
 * 重點是它是一個 Layer —— 測試時整個換掉，不需要碰 agent 邏輯。
 */
const ModelClientLive = Layer.succeed(ModelClient, {
  complete: (messages) =>
    messages.length === 0
      ? Effect.fail(
          new ActionError({ action: "callModel", message: "empty conversation" })
        )
      : Effect.succeed(`echo: ${messages[messages.length - 1]?.text ?? ""}`)
});

/** 單則訊息的 UTF-8 byte 上限。字元數上限由 schema 保證（bytes >= chars）。 */
const MAX_MESSAGE_BYTES = MAX_MESSAGE_CHARS;

export class ChatAgent extends DirectiveAgent<
  Cloudflare.Env,
  ChatState,
  ChatAction,
  ModelClient
> {
  initialState = initialChatState;

  protected readonly def = chatAgent;
  protected readonly actions = chatActions;

  protected layer(): Layer.Layer<ModelClient> {
    return ModelClientLive;
  }

  // WebSocket 文字就是一個 action。邊界的活（byte 上限、rejected 回報、時鐘）
  // 由 shell 統一做 —— 對話型 agent 只覆寫這兩個。
  protected override maxInputBytes(): number {
    return MAX_MESSAGE_BYTES;
  }

  protected override textAction(text: string, now: number): ChatAction {
    return { _tag: "UserMessage", text, now };
  }
}

export default {
  async fetch(request: Request, env: Cloudflare.Env): Promise<Response> {
    return (
      (await routeAgentRequest(request, env)) ??
      new Response("Not found", { status: 404 })
    );
  }
};
