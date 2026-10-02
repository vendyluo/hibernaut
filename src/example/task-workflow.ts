import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import { Cause, Effect, Exit, Schema } from "effect";
import { defineAction, runAction } from "../core/action.js";
import {
  shouldRetryTask,
  TaskRequest,
  TaskOutput,
  getTaskPolicy,
  resolveTaskContract,
  type TaskParams,
} from "../core/task.js";

/** Replace this leaf with a provider adapter using the supplied stable idempotency key. */
export const composeTask = defineAction({
  name: "compose-task",
  input: Schema.Struct({ text: Schema.String, idempotencyKey: Schema.String }),
  output: TaskOutput,
  run: ({ text }) => Effect.succeed({ text: `result: ${text}` }),
});

export class TaskWorkflow extends WorkflowEntrypoint<Cloudflare.Env, TaskParams> {
  override async run(event: WorkflowEvent<TaskParams>, step: WorkflowStep) {
    const { owner, key } = event.payload;
    const agent = this.env.TaskAgent.getByName(owner);
    try {
      const request = await step.do(
        "validate-v1",
        { retries: { limit: 0, delay: "1 second" } },
        async () => {
          if (event.payload.version !== 1) throw new NonRetryableError("Unsupported task version");
          try {
            resolveTaskContract(event.payload.contract);
          } catch {
            throw new NonRetryableError("Unsupported task contract");
          }
          const result = Schema.decodeUnknownResult(TaskRequest)(event.payload.request);
          if (result._tag === "Failure") throw new NonRetryableError(result.failure.message);
          return result.success;
        },
      );
      const prepared = await step.do("prepare-v1", async () => {
        const text = request.text.trim();
        if (text.length === 0) throw new NonRetryableError("Text must not be blank");
        return text;
      });
      const contract = resolveTaskContract(event.payload.contract);
      const policy = getTaskPolicy(contract, request.policy);
      const output = await step.do(
        "compose-v1",
        {
          retries: { limit: policy.maxRetries, delay: policy.backoffMs, backoff: "exponential" },
          timeout: "30 seconds",
        },
        async () => {
          // Workflows owns durable retries. Do not add a second in-handler retry loop.
          const exit = await Effect.runPromiseExit(
            runAction(
              { ...composeTask, timeoutMs: policy.timeoutMs },
              {
                text: prepared,
                idempotencyKey: `${event.instanceId}:compose-v1`,
              },
            ),
          );
          if (Exit.isSuccess(exit)) return exit.value;
          const failure = Cause.findError(exit.cause);
          if (
            failure._tag === "Success" &&
            shouldRetryTask(request.policy, failure.success, contract)
          )
            throw new Error(failure.success.message);
          throw new NonRetryableError(Cause.pretty(exit.cause));
        },
      );
      if (request.requireApproval) {
        await step.do("record-waiting-v1", async () => {
          await agent.markTaskWaiting(key, event.instanceId);
          return null;
        });
        await step.waitForEvent("approval-v1", { type: "approve", timeout: "24 hours" });
      }
      await step.do("record-success-v1", async () => {
        await agent.settleTask(key, event.instanceId, "succeeded", output);
      });
      return output;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Task failed";
      await step.do("record-failure-v1", async () => {
        await agent.settleTask(key, event.instanceId, "failed", undefined, message);
      });
      throw new NonRetryableError(message);
    }
  }
}
