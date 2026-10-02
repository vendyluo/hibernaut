import { describe, expect, it } from "vite-plus/test";
import { ActionError } from "../src/core/action.js";
import {
  currentTaskContract,
  getTaskPolicy,
  resolveTaskContract,
  shouldRetryTask,
} from "../src/core/task.js";

describe("task product policies", () => {
  it("binds legacy work to v1 and rejects unknown contracts instead of using current defaults", () => {
    expect(resolveTaskContract(undefined)).toEqual({ workflowVersion: 1, policyVersion: 1 });
    expect(getTaskPolicy(currentTaskContract, "transient-only")).toMatchObject({
      maxRetries: 2,
      retryInvalidOutput: false,
    });
    expect(() => resolveTaskContract({ workflowVersion: 2, policyVersion: 1 })).toThrow(
      "Unsupported task contract",
    );
    expect(() => getTaskPolicy({ workflowVersion: 1, policyVersion: 2 }, "regenerate")).toThrow(
      "Unsupported task contract",
    );
    const policy = getTaskPolicy(currentTaskContract, "regenerate");
    expect(() => Object.assign(policy, { maxRetries: 99 })).toThrow();
    expect(policy.maxRetries).toBe(2);
  });
  it("separates regenerable output from transient provider failures", () => {
    for (const policy of ["transient-only", "regenerate"] as const) {
      expect(
        shouldRetryTask(
          policy,
          new ActionError({
            action: "model",
            message: "bad input",
            phase: "input",
            retryable: true,
          }),
        ),
      ).toBe(false);
      expect(
        shouldRetryTask(
          policy,
          new ActionError({ action: "model", message: "unauthorized", phase: "execution" }),
        ),
      ).toBe(false);
      expect(
        shouldRetryTask(
          policy,
          new ActionError({
            action: "model",
            message: "overloaded",
            phase: "execution",
            retryable: true,
          }),
        ),
      ).toBe(true);
      expect(
        shouldRetryTask(
          policy,
          new ActionError({ action: "model", message: "malformed", phase: "output" }),
        ),
      ).toBe(policy === "regenerate");
    }
  });
});
