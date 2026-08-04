/**
 * E2E：真的走 Worker 入口。
 *
 * 其他 Workers 測試都用 `env.ChatAgent.get(...)` 直接操作 DO，那會**繞過**整合入口。
 * 審查正確指出：入口壞掉的時候那些測試照樣全綠。這一支專門守住那條路徑 ——
 * 從 `SELF.fetch()` 發出真實的 WebSocket upgrade，一路到 `onMessage` 再回到 client。
 */
import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { MAX_MESSAGE_CHARS } from "../src/example/chat.js";

const AGENT_URL = "https://example.com/agents/chat-agent";

/** 建立連線並回傳一個「收下一則訊息」的函式。 */
const connect = async (room: string) => {
  const response = await SELF.fetch(`${AGENT_URL}/${room}`, {
    headers: { Upgrade: "websocket" }
  });

  expect(response.status).toBe(101);
  const ws = response.webSocket;
  expect(ws).toBeDefined();
  ws!.accept();

  const inbox: string[] = [];
  const waiters: Array<(value: string) => void> = [];
  ws!.addEventListener("message", (event: MessageEvent) => {
    const data = String(event.data);
    const waiter = waiters.shift();
    if (waiter) waiter(data);
    else inbox.push(data);
  });

  const next = (): Promise<string> => {
    const buffered = inbox.shift();
    if (buffered !== undefined) return Promise.resolve(buffered);
    return new Promise<string>((resolve) => waiters.push(resolve));
  };

  return { ws: ws!, next };
};

/** 過濾掉 Agents SDK 自己的狀態同步訊息，只留 agent 送出的事件。 */
const nextEvent = async (
  next: () => Promise<string>,
  types: ReadonlyArray<string>
): Promise<{ type: string; payload: Record<string, unknown> }> => {
  for (let i = 0; i < 10; i++) {
    const parsed = JSON.parse(await next()) as {
      type: string;
      payload?: Record<string, unknown>;
    };
    if (types.includes(parsed.type)) {
      return { type: parsed.type, payload: parsed.payload ?? {} };
    }
  }
  throw new Error(`did not observe any of: ${types.join(", ")}`);
};

describe("Worker 入口路由", () => {
  it("WebSocket upgrade 打到 agent，訊息一路走到 onMessage 並收到回覆", async () => {
    const { ws, next } = await connect("route-e2e");

    ws.send("hello");

    const event = await nextEvent(next, ["message", "error"]);
    expect(event.type).toBe("message");
    expect(event.payload).toEqual({ role: "assistant", text: "echo: hello" });

    ws.close();
  });

  it("超大訊息在持久化之前就被擋掉", async () => {
    const { ws, next } = await connect("route-too-large");

    ws.send("x".repeat(MAX_MESSAGE_CHARS + 1));

    const event = await nextEvent(next, ["rejected", "message"]);
    expect(event.type).toBe("rejected");
    expect(event.payload.reason).toBe("message too large");

    ws.close();
  });

  it("未知路徑回 404，不會落到「一律回 ok」的舊行為", async () => {
    const response = await SELF.fetch("https://example.com/nope");
    expect(response.status).toBe(404);
  });
});
