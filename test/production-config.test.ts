import { describe, expect, it } from "vitest";
import { assertProductionConfiguration } from "../src/common/production-config.js";

describe("production configuration", () => {
  it("allows development to configure dependencies incrementally", () => {
    expect(() => assertProductionConfiguration({ NODE_ENV: "development" })).not.toThrow();
  });

  it("fails production startup instead of enabling local or missing dependencies", () => {
    expect(() => assertProductionConfiguration({ NODE_ENV: "production" })).toThrow("Missing required production configuration");
  });
});
