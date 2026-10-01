import {
  SELF,
  env,
  evictDurableObject,
  introspectWorkflow,
  introspectWorkflowInstance,
  runInDurableObject,
  runDurableObjectAlarm,
} from "cloudflare:test";
import { getAgentByName } from "agents";
import { describe, expect, it } from "vitest";
import type { TaskRecord } from "../src/core/task.js";
import type { TaskAgent } from "../src/example/task-agent.js";

const request = { text: "hello", policy: "transient-only", requireApproval: false } as const;
const url = (room: string, key: string) => `https://example.com/tasks/${room}/jobs/${key}`;
const submit = async (room: string, key: string, body: unknown = request) =>
  SELF.fetch(url(room, key), {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

describe("accepted durable tasks", () => {
  it("keeps terminal output after eviction and dedupes matching submissions", async () => {
    await using all = await introspectWorkflow(env.TaskWorkflow);
    const response = await submit("task-success", "one");
    expect(response.status).toBe(202);
    const receipt = (await response.json()) as TaskRecord;
    const [workflow] = await all.get();
    await workflow!.waitForStatus("complete");
    const stub = await getAgentByName(env.TaskAgent, "task-success");
    await evictDurableObject(stub);
    const found = await SELF.fetch(url("task-success", "one"));
    expect(await found.json()).toMatchObject({
      status: "succeeded",
      output: { text: "result: hello" },
    });
    const duplicate = await submit("task-success", "one");
    expect(((await duplicate.json()) as TaskRecord).workflowId).toBe(receipt.workflowId);
    expect(await all.get()).toHaveLength(1);
    expect(
      await runInDurableObject(stub, (instance: TaskAgent) => instance.getSchedules()),
    ).toHaveLength(0);
    expect((await submit("task-success", "one", { ...request, text: "different" })).status).toBe(
      409,
    );
  });

  it("continues a durable approval wait after its agent is evicted", async () => {
    await using all = await introspectWorkflow(env.TaskWorkflow);
    const response = await submit("task-approval", "one", { ...request, requireApproval: true });
    expect(response.status).toBe(202);
    const [workflow] = await all.get();
    await workflow!.waitForStepResult({ name: "record-waiting-v1" });
    const stub = await getAgentByName(env.TaskAgent, "task-approval");
    await evictDurableObject(stub);
    const status = await SELF.fetch(url("task-approval", "one"));
    expect(await status.json()).toMatchObject({ status: "waiting" });
    expect(
      (await SELF.fetch(`${url("task-approval", "one")}/approve`, { method: "POST" })).status,
    ).toBe(202);
    await workflow!.waitForStatus("complete");
    expect(await (await SELF.fetch(url("task-approval", "one"))).json()).toMatchObject({
      status: "succeeded",
    });
  });

  it("cancels durably and ignores late completion", async () => {
    await using all = await introspectWorkflow(env.TaskWorkflow);
    const response = await submit("task-cancel", "one", { ...request, requireApproval: true });
    const record = (await response.json()) as TaskRecord;
    const [workflow] = await all.get();
    await workflow!.waitForStepResult({ name: "record-waiting-v1" });
    expect(
      await (await SELF.fetch(url("task-cancel", "one"), { method: "DELETE" })).json(),
    ).toMatchObject({ status: "cancelled" });
    const stub = await getAgentByName(env.TaskAgent, "task-cancel");
    await stub.settleTask("one", record.workflowId, "succeeded", { text: "late" });
    await evictDurableObject(stub);
    expect(await stub.getTask("one")).toMatchObject({ status: "cancelled" });
  });

  it("records exhausted durable retries as a terminal failure without client polling", async () => {
    await using all = await introspectWorkflow(env.TaskWorkflow);
    await all.modifyAll(async (m) => {
      await m.disableRetryDelays();
      await m.mockStepError({ name: "compose-v1" }, new Error("provider unavailable"));
    });
    expect((await submit("task-failed", "one")).status).toBe(202);
    const [workflow] = await all.get();
    await workflow!.waitForStatus("errored");
    const stub = await getAgentByName(env.TaskAgent, "task-failed");
    const rows = await runInDurableObject(
      stub,
      (instance: TaskAgent) => instance.sql<{ record: string }>`SELECT record FROM hibernaut_tasks`,
    );
    expect(JSON.parse(rows[0]!.record)).toMatchObject({ status: "failed" });
    expect(
      await runInDurableObject(stub, (instance: TaskAgent) => instance.getSchedules()),
    ).toHaveLength(0);
  });

  it("bounds approval waits and records an expired wait", async () => {
    await using all = await introspectWorkflow(env.TaskWorkflow);
    await all.modifyAll(async (m) => {
      await m.forceEventTimeout({ name: "approval-v1" });
    });
    expect(
      (await submit("task-expired", "one", { ...request, requireApproval: true })).status,
    ).toBe(202);
    const [workflow] = await all.get();
    await workflow!.waitForStatus("errored");
    expect(await (await SELF.fetch(url("task-expired", "one"))).json()).toMatchObject({
      status: "failed",
    });
  });

  it("repairs an interrupted acceptance using the persisted watcher", async () => {
    const stub = await getAgentByName(env.TaskAgent, "task-repair");
    const record = await runInDurableObject(stub, async (instance: TaskAgent) => {
      const watcher = await instance.scheduleEvery(60, "watchTask", { key: "one" });
      const record: TaskRecord = {
        key: "one",
        workflowId: "acceptance-gap",
        watcherId: watcher.id,
        request,
        status: "submitting",
        createdAt: Date.now(),
        deadlineAt: Date.now() + 60_000,
      };
      void instance.sql`INSERT INTO hibernaut_tasks (key, record) VALUES ('one', ${JSON.stringify(record)})`;
      void instance.sql`UPDATE cf_agents_schedules SET time = ${Math.floor(Date.now() / 1_000) - 1} WHERE id = ${watcher.id}`;
      return record;
    });
    await using workflow = await introspectWorkflowInstance(env.TaskWorkflow, record.workflowId);
    await evictDurableObject(stub);
    await runDurableObjectAlarm(stub);
    await workflow.waitForStatus("complete");
    expect(await stub.getTask("one")).toMatchObject({ status: "succeeded" });
  });

  it("repairs a lost terminal publication through an alarm without client polling", async () => {
    await using all = await introspectWorkflow(env.TaskWorkflow);
    await all.modifyAll(async (m) => {
      await m.mockStepResult({ name: "record-success-v1" }, null);
    });
    const receipt = (await (await submit("task-projection", "one")).json()) as TaskRecord;
    const [workflow] = await all.get();
    await workflow!.waitForStatus("complete");
    const stub = await getAgentByName(env.TaskAgent, "task-projection");
    await runInDurableObject(stub, (instance: TaskAgent) => {
      void instance.sql`UPDATE cf_agents_schedules SET time = ${Math.floor(Date.now() / 1_000) - 1} WHERE id = ${receipt.watcherId}`;
    });
    await evictDurableObject(stub);
    await runDurableObjectAlarm(stub);
    const records = await runInDurableObject(
      stub,
      (instance: TaskAgent) => instance.sql<{ record: string }>`SELECT record FROM hibernaut_tasks`,
    );
    expect(JSON.parse(records[0]!.record)).toMatchObject({
      status: "succeeded",
      output: { text: "result: hello" },
    });
  });

  it("recovers a persisted deadline termination without changing it to cancellation", async () => {
    await using all = await introspectWorkflow(env.TaskWorkflow);
    const receipt = (await (
      await submit("task-deadline", "one", { ...request, requireApproval: true })
    ).json()) as TaskRecord;
    const [workflow] = await all.get();
    await workflow!.waitForStepResult({ name: "record-waiting-v1" });
    const stub = await getAgentByName(env.TaskAgent, "task-deadline");
    await runInDurableObject(stub, (instance: TaskAgent) => {
      const rows = instance.sql<{
        record: string;
      }>`SELECT record FROM hibernaut_tasks WHERE key = 'one'`;
      const record = { ...(JSON.parse(rows[0]!.record) as TaskRecord), termination: "deadline" };
      void instance.sql`UPDATE hibernaut_tasks SET record = ${JSON.stringify(record)} WHERE key = 'one'`;
      void instance.sql`UPDATE cf_agents_schedules SET time = ${Math.floor(Date.now() / 1_000) - 1} WHERE id = ${receipt.watcherId}`;
    });
    // Simulate a crash after the platform stopped the Workflow but before the receipt was settled.
    await (await env.TaskWorkflow.get(receipt.workflowId)).terminate();
    await evictDurableObject(stub);
    await runDurableObjectAlarm(stub);
    expect(await stub.getTask("one")).toMatchObject({
      status: "failed",
      error: "Task deadline exceeded",
    });
  });

  it("dedupes concurrent submissions and preserves immutable request identity", async () => {
    await using all = await introspectWorkflow(env.TaskWorkflow);
    const responses = await Promise.all([
      submit("task-concurrent", "one"),
      submit("task-concurrent", "one"),
    ]);
    expect(responses.map((r) => r.status)).toEqual([202, 202]);
    const records = await Promise.all(responses.map(async (r) => (await r.json()) as TaskRecord));
    expect(records[0]!.workflowId).toBe(records[1]!.workflowId);
    const [workflow] = await all.get();
    expect(await all.get()).toHaveLength(1);
    await workflow!.waitForStatus("complete");
  });

  it("rejects invalid requests before creating work", async () => {
    expect((await submit("task-invalid", "one", { ...request, text: "" })).status).toBe(400);
    expect((await SELF.fetch(url("task-invalid", "one"))).status).toBe(404);
    expect(
      (await submit("task-invalid", "large", { ...request, text: "x".repeat(17_000) })).status,
    ).toBe(413);
  });

  it("does not acknowledge acceptance when durable wake-up fails, and repairs on retry", async () => {
    await using all = await introspectWorkflow(env.TaskWorkflow);
    const stub = await getAgentByName(env.TaskAgent, "task-arm-failure");
    await runInDurableObject(stub, async (instance: TaskAgent) => {
      const original = instance.scheduleEvery;
      instance.scheduleEvery = async () => {
        throw new Error("alarm unavailable");
      };
      try {
        await expect(instance.submitTask("one", request)).rejects.toThrow("alarm unavailable");
        const rows = instance.sql<{ record: string }>`SELECT record FROM hibernaut_tasks`;
        expect(JSON.parse(rows[0]!.record)).toMatchObject({ status: "submitting", watcherId: "" });
      } finally {
        instance.scheduleEvery = original;
      }
    });
    expect(await all.get()).toHaveLength(0);
    expect((await submit("task-arm-failure", "one")).status).toBe(202);
    const [workflow] = await all.get();
    await workflow!.waitForStatus("complete");
    expect(await stub.getTask("one")).toMatchObject({ status: "succeeded" });
  });
});
