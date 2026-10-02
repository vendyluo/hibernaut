import { Agent, type Connection } from "agents";
import { Schema } from "effect";
import {
  isTerminal,
  taskKeyPattern,
  TaskRequest,
  TaskOutput,
  currentTaskContract,
  resolveTaskContract,
  type TaskRecord,
} from "../core/task.js";

/** Acceptance and terminal receipts live here; Workflows owns step execution and recovery. */
export class TaskAgent extends Agent<Cloudflare.Env> {
  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    super(ctx, env);
    void this
      .sql`CREATE TABLE IF NOT EXISTS hibernaut_tasks (key TEXT PRIMARY KEY, record TEXT NOT NULL)`;
  }

  override validateStateChange(_state: unknown, source: Connection | "server"): void {
    if (source !== "server") throw new Error("Agent state is server-owned");
  }

  private read(key: string): TaskRecord | null {
    const rows = this.sql<{
      record: string;
    }>`SELECT record FROM hibernaut_tasks WHERE key = ${key}`;
    if (!rows[0]) return null;
    const record = JSON.parse(rows[0].record) as TaskRecord;
    return { ...record, contract: resolveTaskContract(record.contract) };
  }

  private write(record: TaskRecord): void {
    void this
      .sql`INSERT OR REPLACE INTO hibernaut_tasks (key, record) VALUES (${record.key}, ${JSON.stringify(record)})`;
  }

  /** No await between reading, deciding and writing. Terminal receipts are immutable. */
  private transition(
    key: string,
    change: (
      current: TaskRecord,
    ) => Partial<Pick<TaskRecord, "status" | "watcherId" | "termination" | "output" | "error">>,
  ): TaskRecord {
    const current = this.read(key);
    if (!current) throw new Error("Unknown task receipt");
    if (isTerminal(current.status)) return current;
    const next = { ...current, ...change(current) };
    this.write(next);
    return next;
  }

  /** A watcher can be created after settlement; clean by ownership, not a stale saved ID. */
  private async cleanupWatchers(key: string): Promise<void> {
    for (const schedule of await this.listSchedules()) {
      if (
        schedule.callback === "watchTask" &&
        (schedule.payload as { key?: string } | undefined)?.key === key
      )
        await this.cancelSchedule(schedule.id);
    }
  }

  async submitTask(key: string, request: TaskRequest): Promise<TaskRecord> {
    if (!taskKeyPattern.test(key)) throw new Error("Invalid task key");
    const validated = Schema.decodeUnknownResult(TaskRequest)(request);
    if (validated._tag === "Failure") throw new Error(validated.failure.message);
    // Canonical field order makes request identity independent of JSON property order.
    request = {
      text: validated.success.text,
      policy: validated.success.policy,
      requireApproval: validated.success.requireApproval,
    };
    let record = this.read(key);
    if (record && JSON.stringify(record.request) !== JSON.stringify(request)) {
      throw new Error("Task key already belongs to a different request");
    }
    if (!record) {
      const digest = await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(JSON.stringify([this.name, key])),
      );
      // Re-read after the asynchronous hash: another submit may have registered the same key.
      record = this.read(key);
      if (record && JSON.stringify(record.request) !== JSON.stringify(request)) {
        throw new Error("Task key already belongs to a different request");
      }
      if (!record) {
        const now = Date.now();
        record = {
          key,
          request,
          contract: currentTaskContract,
          workflowId: Array.from(new Uint8Array(digest), (v) =>
            v.toString(16).padStart(2, "0"),
          ).join(""),
          watcherId: "",
          status: "submitting",
          createdAt: now,
          deadlineAt: now + 25 * 60 * 60 * 1_000,
        };
        this.write(record);
      }
    }
    if (!isTerminal(record.status)) {
      // Reserve identity first; then arm recovery before creating or acknowledging the Workflow.
      // Each key owns a watcher, so terminal cleanup cannot remove another job's wake-up.
      const watcher = await this.scheduleEvery(60, "watchTask", { key });
      const current = this.transition(key, () => ({ watcherId: watcher.id }));
      if (isTerminal(current.status)) await this.cancelSchedule(watcher.id);
      else if (current.status === "submitting") await this.ensureWorkflow(current);
    }
    return this.read(key)!;
  }

  private async ensureWorkflow(record: TaskRecord): Promise<void> {
    if (!record.watcherId) {
      // Inspection can recover an unacknowledged submission too; arm it before starting work.
      const watcher = await this.scheduleEvery(60, "watchTask", { key: record.key });
      record = this.transition(record.key, () => ({ watcherId: watcher.id }));
      if (isTerminal(record.status)) {
        await this.cancelSchedule(watcher.id);
        return;
      }
    }
    record = this.read(record.key)!;
    if (isTerminal(record.status)) return;
    try {
      await this.env.TaskWorkflow.create({
        id: record.workflowId,
        params: {
          version: 1,
          contract: resolveTaskContract(record.contract),
          owner: this.name,
          key: record.key,
          request: record.request,
        },
      });
    } catch (error) {
      // A lost response or concurrent submission can mean create succeeded. Same ID cannot create a second task.
      try {
        const instance = await this.env.TaskWorkflow.get(record.workflowId);
        const status = await instance.status();
        if (status.status === "unknown") throw error;
      } catch {
        throw error;
      }
    }
    this.transition(record.key, (current) =>
      current.status === "submitting" ? { status: "queued" } : {},
    );
  }

  async getTask(key: string): Promise<TaskRecord | null> {
    const record = this.read(key);
    if (!record || isTerminal(record.status)) return record;
    await this.reconcileTask(record);
    return this.read(key);
  }

  async approveTask(key: string): Promise<void> {
    const record = await this.getTask(key);
    if (!record || isTerminal(record.status) || !record.request.requireApproval)
      throw new Error("Task does not accept approval");
    const instance = await this.env.TaskWorkflow.get(record.workflowId);
    await instance.sendEvent({ type: "approve", payload: {} });
  }

  async cancelTask(key: string): Promise<TaskRecord | null> {
    if (!(await this.getTask(key))) return null;
    // Persist intent before the cross-binding call so a lost response is recoverable.
    const record = this.transition(key, (current) => ({
      termination: current.termination ?? "cancel",
    }));
    if (!isTerminal(record.status)) await this.reconcileTask(record);
    return this.read(key);
  }

  async settleTask(
    key: string,
    workflowId: string,
    status: "succeeded" | "failed" | "cancelled",
    output?: { text: string },
    error?: string,
  ): Promise<void> {
    const record = this.read(key);
    if (!record || record.workflowId !== workflowId) throw new Error("Unknown task receipt");
    // A late Workflow callback cannot reverse cancellation or overwrite another terminal outcome.
    this.transition(key, () => ({
      status,
      ...(output ? { output } : {}),
      ...(error ? { error } : {}),
    }));
    // Cleanup is retried by the watcher; it must not turn a persisted success into failure.
    try {
      await this.cleanupWatchers(key);
    } catch {
      /* watcher retries cleanup */
    }
  }

  async markTaskWaiting(key: string, workflowId: string): Promise<void> {
    const record = this.read(key);
    if (!record || record.workflowId !== workflowId) throw new Error("Unknown task receipt");
    this.transition(key, () => ({ status: "waiting" }));
  }

  async watchTask({ key }: { key: string }): Promise<void> {
    const record = this.read(key);
    if (!record) {
      // An interrupted submission before receipt registration never accepted work.
      await this.cleanupWatchers(key);
      return;
    }
    if (isTerminal(record.status)) await this.cleanupWatchers(key);
    else await this.reconcileTask(record);
  }

  private async reconcileTask(record: TaskRecord): Promise<void> {
    if (record.status === "submitting") await this.ensureWorkflow(record);
    record = this.read(record.key)!;
    if (isTerminal(record.status)) return;
    const instance = await this.env.TaskWorkflow.get(record.workflowId);
    const state = await instance.status();
    if (state.status === "unknown") throw new Error("Workflow state is unavailable");
    record = this.read(record.key)!;
    if (isTerminal(record.status)) return;
    if (await this.projectTerminal(record, state)) return;
    // A completion can arrive while projection is awaited. Never act on that old snapshot.
    record = this.read(record.key)!;
    if (isTerminal(record.status)) return;
    if (record.termination || Date.now() >= record.deadlineAt) {
      record = this.transition(record.key, (current) => ({
        termination: current.termination ?? "deadline",
      }));
      if (isTerminal(record.status)) return;
      const termination = record.termination!;
      try {
        await instance.terminate();
      } catch (error) {
        // Completion can win the race with termination. Reconcile the actual outcome.
        if (await this.projectTerminal(this.read(record.key)!, await instance.status())) return;
        throw error;
      }
      await this.settleTask(
        record.key,
        record.workflowId,
        termination === "deadline" ? "failed" : "cancelled",
        undefined,
        termination === "deadline" ? "Task deadline exceeded" : undefined,
      );
    } else {
      this.transition(record.key, (current) => ({
        status:
          current.status === "waiting" || state.status === "waiting"
            ? "waiting"
            : state.status === "queued"
              ? "queued"
              : "running",
      }));
    }
  }

  private async projectTerminal(record: TaskRecord, state: InstanceStatus): Promise<boolean> {
    if (state.status === "complete") {
      const output = Schema.decodeUnknownResult(TaskOutput)(state.output);
      if (output._tag === "Success")
        await this.settleTask(record.key, record.workflowId, "succeeded", output.success);
      else
        await this.settleTask(
          record.key,
          record.workflowId,
          "failed",
          undefined,
          "Invalid Workflow output",
        );
    } else if (state.status === "errored") {
      await this.settleTask(
        record.key,
        record.workflowId,
        "failed",
        undefined,
        state.error?.message ?? "Workflow failed",
      );
    } else if (state.status === "terminated") {
      await this.settleTask(
        record.key,
        record.workflowId,
        record.termination === "deadline" ? "failed" : "cancelled",
        undefined,
        record.termination === "deadline" ? "Task deadline exceeded" : undefined,
      );
    } else return false;
    return true;
  }
}
