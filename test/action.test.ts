import { Effect, Result, Schema } from "effect";
import { describe, expect, it } from "vite-plus/test";
import { ActionError, defineAction, runAction } from "../src/core/action.js";

describe("runAction", () => {
  it("decodes input and validates the output's Type without transforming it", async () => {
    const action = defineAction({
      name: "numeric",
      input: Schema.NumberFromString,
      output: Schema.NumberFromString,
      run: (value) => Effect.succeed(value + 1),
    });
    expect(await Effect.runPromise(runAction(action, "41"))).toBe(42);
  });

  it("rejects invalid input before executing the action", async () => {
    let calls = 0;
    const action = defineAction({
      name: "validated",
      input: Schema.Number,
      output: Schema.Number,
      run: (value) =>
        Effect.sync(() => {
          calls++;
          return value;
        }),
    });
    const result = await Effect.runPromise(Effect.result(runAction(action, "42")));
    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result)) {
      expect(result.failure).toBeInstanceOf(ActionError);
      expect(result.failure.message).toContain("invalid input:");
    }
    expect(calls).toBe(0);
  });

  it("rejects an encoded output instead of decoding it", async () => {
    const action = defineAction({
      name: "bad-output",
      input: Schema.Void,
      output: Schema.NumberFromString,
      // Simulate an untyped provider returning the encoded representation.
      run: () => Effect.succeed("42" as unknown as number),
    });
    const result = await Effect.runPromise(Effect.result(runAction(action, undefined)));
    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result)) {
      expect(result.failure.message).toContain("invalid output:");
    }
  });

  it("retries transient errors up to maxRetries", async () => {
    let attempts = 0;
    const action = defineAction({
      name: "retry",
      input: Schema.Void,
      output: Schema.String,
      retry: { maxRetries: 2, backoffMs: 1 },
      run: () =>
        Effect.suspend(() => {
          attempts++;
          return attempts < 3
            ? Effect.fail(
                new ActionError({ action: "retry", message: "transient", retryable: true }),
              )
            : Effect.succeed("ok");
        }),
    });
    expect(await Effect.runPromise(runAction(action, undefined))).toBe("ok");
    expect(attempts).toBe(3);
  });

  it("stops retrying after the configured limit", async () => {
    let attempts = 0;
    const action = defineAction({
      name: "retry-limit",
      input: Schema.Void,
      output: Schema.String,
      retry: { maxRetries: 2, backoffMs: 1 },
      run: () =>
        Effect.suspend(() => {
          attempts++;
          return Effect.fail(
            new ActionError({ action: "retry-limit", message: "failed", retryable: true }),
          );
        }),
    });
    const result = await Effect.runPromise(Effect.result(runAction(action, undefined)));
    expect(Result.isFailure(result)).toBe(true);
    expect(attempts).toBe(3);
  });

  it("applies the timeout to the whole retry/backoff budget", async () => {
    let attempts = 0;
    const action = defineAction({
      name: "timeout",
      input: Schema.Void,
      output: Schema.String,
      timeoutMs: 10,
      retry: { maxRetries: 2, backoffMs: 10_000 },
      run: () =>
        Effect.suspend(() => {
          attempts++;
          return Effect.fail(
            new ActionError({ action: "timeout", message: "transient", retryable: true }),
          );
        }),
    });
    const result = await Effect.runPromise(Effect.result(runAction(action, undefined)));
    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result)) {
      expect(result.failure.message).toBe("timed out");
      expect(result.failure.phase).toBe("execution");
    }
    expect(attempts).toBe(1);
  });

  it("does not retry an unclassified provider error", async () => {
    let calls = 0;
    const action = defineAction({
      name: "permanent",
      input: Schema.Void,
      output: Schema.String,
      retry: { maxRetries: 2, backoffMs: 1 },
      run: () =>
        Effect.suspend(() => {
          calls++;
          return Effect.fail(new ActionError({ action: "permanent", message: "unauthorized" }));
        }),
    });
    const result = await Effect.runPromise(Effect.result(runAction(action, undefined)));
    expect(Result.isFailure(result)).toBe(true);
    expect(calls).toBe(1);
  });

  it("keeps schema failures out of default retries and preserves their phase", async () => {
    let calls = 0;
    const action = defineAction({
      name: "schema",
      input: Schema.Number,
      output: Schema.Number,
      timeoutMs: 100,
      retry: { maxRetries: 2, backoffMs: 10_000 },
      run: () =>
        Effect.sync(() => {
          calls++;
          return "bad" as unknown as number;
        }),
    });
    for (const [input, phase, count] of [
      ["bad", "input", 0],
      [1, "output", 1],
    ] as const) {
      const result = await Effect.runPromise(Effect.result(runAction(action, input)));
      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result)) expect(result.failure.phase).toBe(phase);
      expect(calls).toBe(count);
    }
  });

  it("allows a product to regenerate malformed output explicitly", async () => {
    let calls = 0;
    const action = defineAction({
      name: "regenerate",
      input: Schema.Void,
      output: Schema.String,
      retry: { maxRetries: 2, backoffMs: 1, shouldRetry: (error) => error.phase === "output" },
      run: () => Effect.sync(() => (++calls < 3 ? (42 as unknown as string) : "valid")),
    });
    expect(await Effect.runPromise(runAction(action, undefined))).toBe("valid");
    expect(calls).toBe(3);
  });
});
