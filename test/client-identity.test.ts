import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { AIVO_CLIENT_VERSION, clientHeaders } from "../src/client-identity.js";
import { parseCliArgs } from "../src/cli.js";

describe("client identity", () => {
  it("keeps the header version in step with package.json", () => {
    const pkg = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8")) as {
      version: string;
    };
    expect(AIVO_CLIENT_VERSION).toBe(pkg.version);
  });

  it("identifies the client without exposing the key", () => {
    const headers = clientHeaders();
    expect(headers["x-aivo-client"]).toBe("aivo");
    expect(headers["x-aivo-client-version"]).toBe(AIVO_CLIENT_VERSION);
    expect(headers["x-aivo-client-runtime"]).toMatch(/^node-v\d+\./);
    expect(Object.keys(headers).some((k) => k.includes("authorization"))).toBe(false);
  });

  it("supports -v and --version", () => {
    expect(parseCliArgs(["-v"]).command).toBe("version");
    expect(parseCliArgs(["--version"]).command).toBe("version");
  });
});