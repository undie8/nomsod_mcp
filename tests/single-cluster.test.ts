import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_CLUSTER_ID, resolveClusterId } from "../src/shared/single-cluster.js";

const original = process.env.NOMSOD_CLUSTER_ID;

afterEach(() => {
  if (original === undefined) delete process.env.NOMSOD_CLUSTER_ID;
  else process.env.NOMSOD_CLUSTER_ID = original;
});

describe("single cluster identity", () => {
  it("uses one stable default cluster id", () => {
    delete process.env.NOMSOD_CLUSTER_ID;
    expect(resolveClusterId()).toBe(DEFAULT_CLUSTER_ID);
    expect(DEFAULT_CLUSTER_ID).toBe("nomsod-main-v1");
  });

  it("allows an explicit pinned cluster id", () => {
    process.env.NOMSOD_CLUSTER_ID = "nomsod-main-v1";
    expect(resolveClusterId()).toBe("nomsod-main-v1");
  });

  it("rejects malformed cluster ids", () => {
    process.env.NOMSOD_CLUSTER_ID = "bad cluster id";
    expect(() => resolveClusterId()).toThrow(/unsupported/i);
  });
});
