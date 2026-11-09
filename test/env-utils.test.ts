import { describe, expect, it } from "vitest";
import { buildChildEnv, envNameMatches, isSecretEnvName } from "../src/env-utils.js";

describe("child environment secret isolation", () => {
  it("classifies common credential names without stripping ordinary tooling vars", () => {
    for (const name of [
      "AIVOKEY_API_KEY",
      "OPENAI_API_KEY",
      "GITHUB_TOKEN",
      "AWS_SECRET_ACCESS_KEY",
      "DATABASE_URL",
      "NPM_TOKEN",
      "MY_PRIVATE_KEY",
    ]) {
      expect(isSecretEnvName(name), name).toBe(true);
    }
    for (const name of [
      "PATH",
      "PATHEXT",
      "HOME",
      "USERPROFILE",
      "TEMP",
      "TMPDIR",
      "NODE_OPTIONS",
      "NODE_ENV",
      "TOKENIZERS_PARALLELISM",
      "LANG",
      "TERM",
      "CI",
    ]) {
      expect(isSecretEnvName(name), name).toBe(false);
    }
  });

  it("strips secrets by default and allows explicit names or globs", () => {
    const base = {
      PATH: "/usr/bin",
      HOME: "/home/dev",
      AIVOKEY_API_KEY: "sk-aivo",
      GITHUB_TOKEN: "ghp_1",
      AWS_SECRET_ACCESS_KEY: "aws",
      NPM_TOKEN: "npm",
      ORDINARY: "value",
    };
    const scrubbed = buildChildEnv({ base });
    expect(scrubbed.PATH).toBe("/usr/bin");
    expect(scrubbed.HOME).toBe("/home/dev");
    expect(scrubbed.ORDINARY).toBe("value");
    expect(scrubbed.AIVOKEY_API_KEY).toBeUndefined();
    expect(scrubbed.GITHUB_TOKEN).toBeUndefined();
    expect(scrubbed.AWS_SECRET_ACCESS_KEY).toBeUndefined();
    expect(scrubbed.NPM_TOKEN).toBeUndefined();

    const allowed = buildChildEnv({ base, allow: ["GITHUB_TOKEN", "AWS_*"] });
    expect(allowed.GITHUB_TOKEN).toBe("ghp_1");
    expect(allowed.AWS_SECRET_ACCESS_KEY).toBe("aws");
    expect(allowed.NPM_TOKEN).toBeUndefined();
    expect(allowed.AIVOKEY_API_KEY).toBeUndefined();
  });

  it("lets trusted extras set explicit values but never overrides the Aivocode key ban", () => {
    const env = buildChildEnv({
      base: { PATH: "/bin" },
      extra: {
        MCP_CUSTOM: "yes",
        GITHUB_TOKEN: "explicit-token",
        AIVOKEY_API_KEY: "must-not-leak",
      },
    });
    expect(env.MCP_CUSTOM).toBe("yes");
    expect(env.GITHUB_TOKEN).toBe("explicit-token");
    expect(env.AIVOKEY_API_KEY).toBeUndefined();
  });

  it("matches allowlist patterns case-insensitively with glob support", () => {
    expect(envNameMatches("GITHUB_TOKEN", "github_token")).toBe(true);
    expect(envNameMatches("AWS_*", "AWS_ACCESS_KEY_ID")).toBe(true);
    expect(envNameMatches("AWS_*", "GCP_KEY")).toBe(false);
  });
});
