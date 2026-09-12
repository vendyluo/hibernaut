import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

// Local only: running this check must never create cloud resources.
const url = `ws://127.0.0.1:8787/agents/chat-agent/smoke-${randomUUID()}`;
const ws = new WebSocket(url);
const timeout = setTimeout(() => {
  console.error("Smoke timed out. Start npm run dev in another terminal.");
  process.exit(1);
}, 10_000);
let rejected = false;
let sawState = false;
let verified = false;

ws.addEventListener("open", () => ws.send(JSON.stringify({
  type: "cf_agent_state",
  state: { messages: [], phase: { _tag: "Idle" }, seq: 999 }
})));
ws.addEventListener("error", (event) => {
  console.error("Local WebSocket failed", event.message);
  process.exit(1);
});
ws.addEventListener("message", ({ data }) => {
  const event = JSON.parse(String(data));
  if (event.type === "cf_agent_state") {
    assert.notEqual(event.state.seq, 999, "client state overwrite succeeded");
    if (event.state.seq === 1) sawState = true;
  }
  if (event.type === "cf_agent_state_error") {
    rejected = true;
    ws.send("hello hibernaut");
  }
  if (event.type === "message") {
    assert.equal(rejected, true);
    assert.equal(sawState, true);
    assert.deepEqual(event.payload, {
      role: "assistant", text: "echo: hello hibernaut"
    });
    verified = true;
    ws.close(1000, "smoke complete");
  }
});
ws.addEventListener("close", ({ code }) => {
  assert.equal(verified, true, "connection closed before verification");
  assert.equal(code, 1000, "unclean WebSocket close");
  clearTimeout(timeout);
  console.log("PASS: local WebSocket echo, server state, rejected client overwrite, clean close");
});
