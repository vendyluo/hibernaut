import { Schema } from "effect";
import type { ActionError } from "./action.js";

export const TaskRequest = Schema.Struct({
  text: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4_000)),
  policy: Schema.Literals(["transient-only", "regenerate"]),
  requireApproval: Schema.Boolean,
});
export type TaskRequest = typeof TaskRequest.Type;
export const TaskOutput = Schema.Struct({
  text: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(8_000)),
});
export interface TaskParams {
  readonly version: 1;
  readonly owner: string;
  readonly key: string;
  readonly request: TaskRequest;
}
export type TaskStatus =
  | "submitting"
  | "queued"
  | "running"
  | "waiting"
  | "succeeded"
  | "failed"
  | "cancelled";
export interface TaskRecord {
  readonly key: string;
  readonly workflowId: string;
  readonly watcherId: string;
  readonly request: TaskRequest;
  readonly status: TaskStatus;
  readonly createdAt: number;
  readonly deadlineAt: number;
  readonly output?: { text: string };
  readonly error?: string;
  readonly termination?: "cancel" | "deadline";
}

export const isTerminal = (status: TaskStatus): boolean =>
  status === "succeeded" || status === "failed" || status === "cancelled";

/** Persist the policy name in the job; replace this versioned registry for another product. */
export const taskPolicies = {
  "transient-only": {
    maxRetries: 2,
    backoffMs: 1_000,
    timeoutMs: 25_000,
    retryInvalidOutput: false,
  },
  regenerate: { maxRetries: 2, backoffMs: 1_000, timeoutMs: 25_000, retryInvalidOutput: true },
} as const;

export const shouldRetryTask = (policy: TaskRequest["policy"], error: ActionError): boolean =>
  error.phase === "execution"
    ? error.retryable === true
    : error.phase === "output" && taskPolicies[policy].retryInvalidOutput;

export const taskKeyPattern = /^[a-zA-Z0-9_-]{1,64}$/;
