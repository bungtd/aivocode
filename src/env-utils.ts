/**
 * Child-process environment hygiene.
 *
 * A coding agent inherits the user's full environment. Passing that environment
 * blindly to model-generated shell commands or third-party MCP servers leaks API
 * keys and other credentials. The default policy strips secret-looking variables
 * while leaving ordinary tooling variables (PATH, HOME, TEMP, ...) intact.
 */

const HARD_DENY_ENV = new Set(["AIVOKEY_API_KEY"]);

/**
 * Variables that match the credential pattern but carry no secret value.
 * SSH_AUTH_SOCK is deliberately NOT excepted: it is a capability that lets a
 * sandboxed process sign with the user's keys, so it must be allowlisted
 * explicitly via `permissions.env`.
 */
const SECRET_NAME_EXCEPTIONS = new Set([
  "TOKENIZERS_PARALLELISM",
  "AUTH_TYPE",
]);

/**
 * Matches variable names that commonly carry credentials. Boundaries keep
 * ordinary variables such as `TOKENIZERS_PARALLELISM` intact.
 */
const SECRET_ENV_NAME =
  /(^|_)(API_?KEY|ACCESS_?KEY|SECRET|TOKEN|PASSWORD|PASSWD|PRIVATE_?KEY|CREDENTIALS?|AUTH|KEY|CONNECTION_?STRING|DATABASE_?URL|DB_?URL|MONGO(?:DB)?_URI|REDIS_?URL|POSTGRES(?:QL)?_URL|MYSQL_?URL)(_|$)/i;

export function isSecretEnvName(name: string): boolean {
  if (SECRET_NAME_EXCEPTIONS.has(name.toUpperCase())) return false;
  return SECRET_ENV_NAME.test(name);
}

function wildcardToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp(`^${escaped}$`, "i");
}

export function envNameMatches(pattern: string, name: string): boolean {
  return wildcardToRegExp(pattern).test(name);
}

export interface BuildChildEnvOptions {
  /** Environment variable name patterns explicitly allowed through, e.g. `GITHUB_TOKEN`. */
  allow?: string[];
  /** Explicit values from a trusted config (MCP `env`, terminal policy, ...). */
  extra?: Record<string, string>;
  /** Extra hard-denied names (case-insensitive) in addition to AIVOKEY_API_KEY. */
  hardDeny?: Iterable<string>;
  /** Base environment, defaults to `process.env`. */
  base?: NodeJS.ProcessEnv;
}

/**
 * Builds a scrubbed environment for a child process.
 *
 * Precedence: base -> strip secrets unless allowed -> trusted `extra` overlay ->
 * hard deny (`AIVOKEY_API_KEY` and caller-supplied names) applied last, so even a
 * mistaken explicit value cannot leak the Aivocode credential.
 */
export function buildChildEnv(options: BuildChildEnvOptions = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...(options.base ?? process.env) };
  const allow = options.allow ?? [];
  const hardDeny = new Set(
    [...HARD_DENY_ENV, ...(options.hardDeny ?? [])].map((name) => name.toUpperCase()),
  );

  for (const key of Object.keys(env)) {
    if (hardDeny.has(key.toUpperCase())) {
      delete env[key];
      continue;
    }
    if (isSecretEnvName(key) && !allow.some((pattern) => envNameMatches(pattern, key))) {
      delete env[key];
    }
  }

  if (options.extra) {
    for (const [key, value] of Object.entries(options.extra)) {
      env[key] = value;
    }
  }

  for (const key of Object.keys(env)) {
    if (hardDeny.has(key.toUpperCase())) delete env[key];
  }
  return env;
}
