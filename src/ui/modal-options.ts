/**
 * Pure builders for the TUI's modal option lists.
 *
 * These used to be closures inside the 2,600-line interactive loop, which made
 * them impossible to test. They only transform data into `ModalOption[]`, so
 * they live here and the loop just assigns the result to `modal.items`.
 */
import { formatCompactTokens } from "./theme.js";
import { sanitizeTerminalText } from "./theme.js";
import type { AivoModelInfo, KeyInspectStatus } from "../aivokey-client.js";
import { filterEligibleModelsForAccount } from "../aivokey-client.js";
import type { BackgroundJob } from "../background-jobs.js";
import { AGENT_TEAMS, getAgentTeam, type TeamId } from "../teams.js";
import type { SubagentRunRecord } from "../agent.js";
import type { TodoItem } from "../tools/index.js";

export interface ModalOption {
  value: string;
  label: string;
  badge?: string;
  detail?: string;
}

/** Model picker rows, annotated with capabilities and price. */
export function buildModelOptions(
  catalog: AivoModelInfo[],
  keyStatus: KeyInspectStatus | null,
): ModalOption[] {
  const base = filterEligibleModelsForAccount(catalog, keyStatus);
  return base.map((m) => {
    const inUsd = (Number(m.inputMicroPer1M) / 1_000_000).toFixed(2);
    const outUsd = (Number(m.outputMicroPer1M) / 1_000_000).toFixed(2);
    const badges: string[] = [];
    if (m.supportsTools) badges.push("tools");
    if (m.supportsReasoning) badges.push("reasoning");
    if (m.supportsPromptCache) badges.push("cache");
    return {
      value: m.id,
      label: sanitizeTerminalText(m.id),
      badge: `[${badges.join("·")}]`,
      detail: `${formatCompactTokens(m.contextWindow)} ctx · $${inUsd}/$${outUsd}`,
    };
  });
}

/** Specialist team picker rows. */
export function buildTeamOptions(): ModalOption[] {
  return AGENT_TEAMS.map((t) => ({
    value: t.id as string,
    label: t.name,
    badge: `[${t.roles.map((r) => r.badge).join("→")}]`,
    detail: t.description.slice(0, 46),
  }));
}

/** Session rows, newest first, with the active one marked. */
export function buildSessionOptions(
  sessions: Array<{
    id: string;
    model: string;
    messageCount: number;
    totalCostMicro: string;
    updatedAt: string;
  }>,
  activeSessionId: string,
  formatCost: (micro: bigint) => string,
): ModalOption[] {
  return sessions.map((s) => ({
    value: s.id,
    label: `${s.id}${s.id === activeSessionId ? "  (current)" : ""}`,
    badge: `[${s.model}]`,
    detail: `${s.messageCount} msgs · ${formatCost(BigInt(s.totalCostMicro || "0"))} · ${s.updatedAt.slice(0, 16).replace("T", " ")}`,
  }));
}

/** Subagent run rows. */
export function buildSubagentOptions(runs: SubagentRunRecord[]): ModalOption[] {
  return runs.map((r) => ({
    value: r.id,
    label: `${r.id} · ${r.name}`,
    badge: `[${r.status.toUpperCase()} · ${r.model}]`,
    detail: r.description,
  }));
}

/** Background job rows. */
export function buildJobOptions(jobs: BackgroundJob[]): ModalOption[] {
  return jobs.map((j) => ({
    value: j.id,
    label: `${j.id} · ${j.command.slice(0, 40)}`,
    badge: `[${j.status.toUpperCase()}]`,
    detail: j.detectedUrl ?? "",
  }));
}

/** Sidebar task rows (max 5, as the pane is narrow). */
export function sidebarTaskRows(todos: TodoItem[]): Array<{ done: boolean; active: boolean; text: string }> {
  return todos.slice(0, 5).map((t) => ({
    done: t.status === "completed",
    active: t.status === "in_progress",
    text: sanitizeTerminalText(t.content),
  }));
}

/** Resolves the model configured for a subagent role. */
export function modelForRole(
  role: "explore" | "architect" | "builder" | "reviewer" | "all",
  config: {
    model: string;
    fastModel: string | null;
    architectModel?: string | null;
    builderModel?: string | null;
    reviewerModel?: string | null;
  },
): string {
  switch (role) {
    case "architect":
      return config.architectModel ?? config.model;
    case "builder":
      return config.builderModel ?? config.model;
    case "reviewer":
      return config.reviewerModel ?? config.model;
    default:
      return config.fastModel ?? config.model;
  }
}

/** Team summary used by the sidebar. */
export function teamSummary(team: TeamId | undefined): { label: string; badges: string } {
  const active = getAgentTeam(team ?? "fullstack");
  return {
    label: active?.shortLabel ?? "Full-Stack",
    badges: active?.roles.map((r) => r.badge).join("→") ?? "ARCH→QA",
  };
}
