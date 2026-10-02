import { describe, expect, it } from "vite-plus/test";
import { assertPortable } from "../src/core/commit.js";

describe("portable commit data", () => {
  it("rejects array subclasses without invoking inherited serialization", () => {
    let serializations = 0;
    class RewritingArray extends Array {
      toJSON() {
        serializations++;
        return "unexpected string";
      }
    }
    expect(() => assertPortable({ messages: new RewritingArray() })).toThrow();
    expect(serializations).toBe(0);
    expect(() => assertPortable({ messages: [] })).not.toThrow();
  });
  it.each([
    undefined,
    NaN,
    Infinity,
    1n,
    new Date(),
    Promise.resolve(1),
    { value: undefined },
    [undefined],
    {
      get value() {
        return 1;
      },
    },
  ])("rejects lossy or runtime-only data %#", (value) => {
    expect(() => assertPortable(value)).toThrow();
  });
  it("rejects cycles but allows shared plain values", () => {
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    expect(() => assertPortable(cyclic)).toThrow();
    const shared = { count: 1 };
    expect(() =>
      assertPortable({ a: shared, b: shared, list: [null, true, "text"] }),
    ).not.toThrow();
  });
  it("rejects sparse arrays, array accessors and properties that JSON would discard", () => {
    const sparse: unknown[] = [];
    sparse.length = 1;
    expect(() => assertPortable(sparse)).toThrow();
    expect(() => assertPortable(Object.assign([], { extra: () => 1 }))).toThrow();
    const accessor: unknown[] = [];
    Object.defineProperty(accessor, "0", { enumerable: true, get: () => 1 });
    expect(() => assertPortable(accessor)).toThrow();
  });
});
