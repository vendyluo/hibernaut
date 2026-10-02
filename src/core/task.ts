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
export const TaskContract = Schema.Struct({
  workflowVersion: Schema.Literal(1),
  policyVersion: Schema.Literal(1),
});
export type TaskContract = typeof TaskContract.Type;
/** New defaults may change; retained contracts and their registries must remain available. */
const legacyTaskContract: TaskContract = Object.freeze({ workflowVersion: 1, policyVersion: 1 });
export const currentTaskContract: TaskContract = legacyTaskContract;
export const resolveTaskContract = (value: unknown): TaskContract => {
  // Jobs accepted before explicit contract binding used exactly this v1 contract.
  if (value === undefined) return legacyTaskContract;
  const result = Schema.decodeUnknownResult(TaskContract)(value);
  if (result._tag === "Failure") throw new Error("Unsupported task contract");
  return result.success;
};
export interface TaskParams {
  readonly version: 1;
  readonly contract?: TaskContract;
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
  /** Absent only on legacy v1 receipts. Never replace a stored contract with current defaults. */
  readonly contract?: TaskContract;
  readonly status: TaskStatus;
  readonly createdAt: number;
  readonly deadlineAt: number;
  readonly output?: { text: string };
  readonly error?: string;
  readonly termination?: "cancel" | "deadline";
}

export const isTerminal = (status: TaskStatus): boolean =>
  status === "succeeded" || status === "failed" || status === "cancelled";

/** Immutable v1 semantics. Add a new registry version when changing product policy. */
export const taskPolicies = Object.freeze({
  "transient-only": Object.freeze({
    maxRetries: 2,
    backoffMs: 1_000,
    timeoutMs: 25_000,
    retryInvalidOutput: false,
  }),
  regenerate: Object.freeze({
    maxRetries: 2,
    backoffMs: 1_000,
    timeoutMs: 25_000,
    retryInvalidOutput: true,
  }),
});

export const getTaskPolicy = (contract: unknown, name: TaskRequest["policy"]) => {
  const resolved = resolveTaskContract(contract);
  const registry = { 1: taskPolicies }[resolved.policyVersion];
  if (!Object.hasOwn(registry, name)) throw new Error("Unsupported task policy");
  const policy = registry[name];
  return policy;
};

export const shouldRetryTask = (
  policy: TaskRequest["policy"],
  error: ActionError,
  contract?: TaskContract,
): boolean => {
  const resolved = getTaskPolicy(contract, policy);
  return error.phase === "execution"
    ? error.retryable === true
    : error.phase === "output" && resolved.retryInvalidOutput;
};

export const taskKeyPattern = /^[a-zA-Z0-9_-]{1,64}$/;
