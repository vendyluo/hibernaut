/** A failed commit can have an uncertain result; callers must inspect before retrying. */
export class TurnError extends Error {
  constructor(
    readonly stage: "execution" | "validation" | "commit" | "effects",
    readonly commitStatus: "not-committed" | "unknown" | "committed",
    cause: unknown,
  ) {
    super(`Turn failed during ${stage} (${commitStatus})`, { cause });
    this.name = "TurnError";
  }
}

/** Check the actual data, rather than JSON.stringify's lossy conversions. */
export function assertPortable(value: unknown, ancestors = new Set<object>()): void {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number" && Number.isFinite(value)) return;
  if (typeof value !== "object" || value === null) throw new Error("Expected portable JSON data");
  if (ancestors.has(value)) throw new Error("Cyclic data is not portable");
  if (Array.isArray(value) && Object.getPrototypeOf(value) !== Array.prototype)
    throw new Error("Expected a plain data array");
  if (
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) !== Object.prototype &&
    Object.getPrototypeOf(value) !== null
  )
    throw new Error("Expected a plain data object");
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      for (let index = 0; index < value.length; index++) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (!descriptor?.enumerable || !("value" in descriptor))
          throw new Error("Expected dense data arrays");
        assertPortable(descriptor.value, ancestors);
      }
      if (Reflect.ownKeys(value).length !== value.length + 1)
        throw new Error("Array properties are not portable");
    } else {
      for (const key of Reflect.ownKeys(value)) {
        if (typeof key !== "string") throw new Error("Symbol keys are not portable");
        const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
        if (!descriptor.enumerable || !("value" in descriptor))
          throw new Error("Expected data properties");
        assertPortable(descriptor.value, ancestors);
      }
    }
  } finally {
    ancestors.delete(value);
  }
}
