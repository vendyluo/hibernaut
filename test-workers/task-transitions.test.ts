import {
  env,
  evictDurableObject,
  introspectWorkflow,
  runInDurableObject,
  SELF,
} from "cloudflare:test";
import { getAgentByName } from "agents";
import { describe, expect, it } from "vitest";
import { currentTaskContract, type TaskRecord } from "../src/core/task.js";
import type { TaskAgent } from "../src/example/task-agent.js";

const request = { text: "hello", policy: "transient-only", requireApproval: true } as const;
const seed = (instance: TaskAgent, key = "one"): TaskRecord => {
  const record: TaskRecord = {
    key,
    request,
    workflowId: `workflow-${key}`,
    watcherId: "",
    status: "waiting",
    contract: currentTaskContract,
    createdAt: Date.now(),
    deadlineAt: Date.now() + 60_000,
  };
  void instance.sql`INSERT INTO hibernaut_tasks (key, record) VALUES (${key}, ${JSON.stringify(record)})`;
  return record;
};
const stored = (instance: TaskAgent, key = "one"): TaskRecord =>
  JSON.parse(
    instance.sql<{ record: string }>`SELECT record FROM hibernaut_tasks WHERE key = ${key}`[0]!
      .record,
  ) as TaskRecord;

describe("receipt transition invariants", () => {
  it.each(["succeeded", "failed", "cancelled"] as const)(
    "preserves %s when cancellation receives an older inspection snapshot",
    async (status) => {
      const stub = await getAgentByName(env.TaskAgent, `transition-cancel-${status}`);
      await runInDurableObject(stub, async (instance: TaskAgent) => {
        const snapshot = seed(instance);
        const target = instance as unknown as { reconcileTask: () => Promise<void> };
        let reconciliations = 0;
        target.reconcileTask = async () => {
          reconciliations++;
        };
        instance.getTask = async () => {
          await instance.settleTask(
            "one",
            snapshot.workflowId,
            status,
            status === "succeeded" ? { text: "retained" } : undefined,
            status === "failed" ? "retained error" : undefined,
          );
          return snapshot;
        };
        const record = await instance.cancelTask("one");
        expect(record).toEqual(stored(instance));
        expect(record).toMatchObject({ status });
        expect(record?.termination).toBeUndefined();
        if (status === "succeeded") expect(record?.output).toEqual({ text: "retained" });
        if (status === "failed") expect(record?.error).toBe("retained error");
        expect(reconciliations).toBe(0);
        await instance.markTaskWaiting("one", snapshot.workflowId);
        await instance.settleTask("one", snapshot.workflowId, "failed", undefined, "late");
        expect(stored(instance)).toEqual(record);
      });
      await evictDurableObject(stub);
      expect(await stub.getTask("one")).toMatchObject({ status });
    },
  );

  it("preserves completion arriving while deadline projection is awaited", async () => {
    await using all = await introspectWorkflow(env.TaskWorkflow);
    const response = await SELF.fetch("https://example.com/tasks/transition-deadline/jobs/one", {
      method: "PUT",
      body: JSON.stringify(request),
    });
    expect(response.status).toBe(202);
    const receipt = (await response.json()) as TaskRecord;
    const [workflow] = await all.get();
    await workflow!.waitForStepResult({ name: "record-waiting-v1" });
    const stub = await getAgentByName(env.TaskAgent, "transition-deadline");
    await runInDurableObject(stub, async (instance: TaskAgent) => {
      const record = { ...stored(instance), deadlineAt: Date.now() - 1 };
      void instance.sql`UPDATE hibernaut_tasks SET record = ${JSON.stringify(record)} WHERE key = 'one'`;
      const target = instance as unknown as {
        projectTerminal: (record: TaskRecord, state: InstanceStatus) => Promise<boolean>;
      };
      const project = target.projectTerminal.bind(instance);
      target.projectTerminal = async (current, state) => {
        const terminal = await project(current, state);
        if (!terminal)
          await instance.settleTask("one", current.workflowId, "succeeded", {
            text: "completion won",
          });
        return terminal;
      };
      await instance.watchTask({ key: "one" });
      expect(stored(instance)).toMatchObject({
        status: "succeeded",
        output: { text: "completion won" },
      });
      expect(stored(instance).termination).toBeUndefined();
    });
    await evictDurableObject(stub);
    expect(await stub.getTask("one")).toMatchObject({
      status: "succeeded",
      output: { text: "completion won" },
    });
    // Stop the synthetic still-waiting platform execution after checking the retained receipt.
    await (await env.TaskWorkflow.get(receipt.workflowId)).terminate();
  });

  it("cleans every owned watcher without changing another job or a terminal receipt", async () => {
    const stub = await getAgentByName(env.TaskAgent, "transition-watchers");
    await runInDurableObject(stub, async (instance: TaskAgent) => {
      const record = seed(instance);
      seed(instance, "other");
      await instance.scheduleEvery(60, "watchTask", { key: "one" });
      await instance.scheduleEvery(61, "watchTask", { key: "one" });
      const other = await instance.scheduleEvery(60, "watchTask", { key: "other" });
      await instance.settleTask("one", record.workflowId, "succeeded", { text: "retained" });
      const terminal = stored(instance);
      expect((await instance.getSchedules()).map((schedule) => schedule.id)).toEqual([other.id]);
      // A submission already in flight can arm a watcher after terminal cleanup.
      await instance.scheduleEvery(60, "watchTask", { key: "one" });
      await instance.watchTask({ key: "one" });
      expect(stored(instance)).toEqual(terminal);
      expect((await instance.getSchedules()).map((schedule) => schedule.id)).toEqual([other.id]);
    });
  });
});
