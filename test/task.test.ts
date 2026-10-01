import { describe, expect, it } from "vite-plus/test";
import { ActionError } from "../src/core/action.js";
import { shouldRetryTask } from "../src/core/task.js";

describe("task product policies", () => {
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
