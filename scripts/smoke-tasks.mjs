import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

// Local only. accept/resume can straddle a full Wrangler process restart.
const phase = process.argv[2] ?? "all";
const receiptPath = process.argv[3] ?? ".wrangler/task-smoke-receipt.json";
const base = process.env.TASK_SMOKE_URL ?? "http://127.0.0.1:8787";
assert(["all", "accept", "resume"].includes(phase), "Use all, accept or resume");
assert(["127.0.0.1", "localhost"].includes(new URL(base).hostname), "Smoke must target localhost");
const localFetch = (url, options = {}) =>
  fetch(url, { ...options, signal: AbortSignal.timeout(10_000) });
const body = { text: "durable smoke", policy: "transient-only", requireApproval: true };
const poll = async (url, expected) => {
  for (let attempt = 0; attempt < 100; attempt++) {
    const response = await localFetch(url);
    assert.equal(response.status, 200);
    const record = await response.json();
    if (record.status === expected) return record;
    assert(!["failed", "cancelled"].includes(record.status), JSON.stringify(record));
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Task did not become ${expected}`);
};

let receipt;
if (phase !== "resume") {
  const url = `${base}/tasks/smoke-${randomUUID()}/jobs/one`;
  const accepted = await localFetch(url, { method: "PUT", body: JSON.stringify(body) });
  assert.equal(accepted.status, 202);
  const record = await accepted.json();
  await poll(url, "waiting");
  receipt = { url, workflowId: record.workflowId };
  await mkdir(dirname(receiptPath), { recursive: true });
  await writeFile(receiptPath, JSON.stringify(receipt));
  console.log("Task accepted and durably waiting for approval", record.workflowId);
} else {
  receipt = JSON.parse(await readFile(receiptPath, "utf8"));
  const target = new URL(receipt.url);
  assert.equal(target.origin, new URL(base).origin, "Receipt must target the same local server");
}
if (phase !== "accept") {
  const waiting = await poll(receipt.url, "waiting");
  assert.equal(waiting.workflowId, receipt.workflowId);
  const duplicate = await localFetch(receipt.url, { method: "PUT", body: JSON.stringify(body) });
  assert.equal(duplicate.status, 202);
  assert.equal((await duplicate.json()).workflowId, receipt.workflowId);
  assert.equal((await localFetch(`${receipt.url}/approve`, { method: "POST" })).status, 202);
  const completed = await poll(receipt.url, "succeeded");
  assert.deepEqual(completed.output, { text: "result: durable smoke" });
  console.log("Task resumed, deduped and retained terminal output", receipt.workflowId);
}
