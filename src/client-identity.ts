import { platform, arch } from "node:os";

/**
 * The CLI's own version. Kept in one place so the client-identity header, the
 * `--version` output, and `package.json` cannot drift (a unit test pins them).
 */
export const AIVO_CLIENT_VERSION = "1.0.1";

/** Stable slug the gateway allowlists to attribute usage to AivoCode. */
export const AIVO_CLIENT_SLUG = "aivo";

/**
 * Headers every AivoKey request carries so the gateway can attribute usage to
 * this CLI (and this version) without inspecting prompts or session files.
 * They are advisory only: the gateway clips and allowlists them, and never uses
 * them for authorization.
 */
export function clientHeaders(): Record<string, string> {
  return {
    "x-aivo-client": AIVO_CLIENT_SLUG,
    "x-aivo-client-version": AIVO_CLIENT_VERSION,
    "x-aivo-client-runtime": `node-v${process.versions.node}-${platform()}-${arch()}`,
  };
}