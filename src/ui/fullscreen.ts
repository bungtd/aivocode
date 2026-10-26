import { emitKeypressEvents } from "node:readline";
import { stdin, stdout } from "node:process";
import { execSync } from "node:child_process";
import type { AivoWire, ExecutionStrategy, PermissionMode, ReasoningEffort } from "../config.js";
import { saveUserConfig } from "../config.js";
import { AGENT_TEAMS, getAgentTeam, type TeamId } from "../teams.js";
import { SLASH_COMMANDS } from "./select.js";
import {
  DEFAULT_AIVOKEY_CATALOG,
  formatMicroUsd,
  type KeyInspectStatus,
} from "../aivokey-client.js";
import type { TodoItem } from "../tools/index.js";
import { walkWorkspaceFiles } from "../tools/index.js";
import { buildSystemPrompt, estimateConversationTokens } from "../context.js";
import type { AivoAgent } from "../agent.js";
import {
  c,
  formatCompactTokens,
  getGitBranchLabel,
  modeBadge,
  padEndVisible,
  renderTodoBoard,
  renderToolCallCard,
  stripAnsi,
  visibleLength,
} from "./theme.js";
import { renderTerminalMarkdown, renderUnifiedDiff } from "./markdown.js";
import {
  applyComposerHotkeys,
  computeComposerSuggestions,
  type ComposerSuggestions,
} from "./composer.js";

import { handleSlashCommand } from "../repl.js";

const BRAILLE_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export async function startFullScreenTui(
  agent: AivoAgent,
  initialKeyStatus: KeyInspectStatus | null,
  fetchFn: typeof fetch = fetch,
): Promise<void> {
  if (!stdin.isTTY || !stdout.isTTY) {
    return;
  }

  let keyStatus = initialKeyStatus;
  let workspaceFiles = walkWorkspaceFiles(agent.config.cwd);
  let gitBranch = getGitBranchLabel(agent.config.cwd);
  let showSidebar = true;

  const transcriptLines: string[] = [
    `${c.cyan("◆")} ${c.bold("Welcome to AivoCode Full-Screen Studio")} ${c.slate("(Native AivoKey Harness)")}`,
    `  ${c.slate("• Type")} ${c.cyan("/")} ${c.slate("for commands,")} ${c.cyan("@")} ${c.slate("to attach files,")} ${c.cyan("!cmd")} ${c.slate("for shell.")}`,
    `  ${c.slate("• Hotkeys:")} ${c.amber("Shift+Tab")} Mode · ${c.amber("Ctrl+K")} Model Picker · ${c.amber("Ctrl+E")} Effort · ${c.amber("Ctrl+B")} Toggle Sidebar · ${c.amber("PgUp/PgDn")} Scroll`,
    "",
  ];

  let buffer = "";
  let cursorPos = 0;
  let selectedSuggestionIdx = 0;
  let scrollOffset = 0;
  let notice: string | null = null;
  let busyBaseLabel: string | null = null;
  let busyStartedAt = 0;
  let spinnerFrameIdx = 0;
  let spinnerTimer: ReturnType<typeof setInterval> | null = null;
  let activeAbort: AbortController | null = null;
  let modal: FullScreenModalState | null = null;
  let pendingConfirmResolve: ((allowed: boolean) => void) | null = null;
  const history: string[] = [];
  let historyIdx = 0;

  // Live streaming accumulators for the active assistant turn
  let streamingAssistantLineIdx: number | null = null;
  let streamingAssistantBuffer = "";
  let streamingReasoningLineIdx: number | null = null;
  let streamingReasoningBuffer = "";
  let streamingToolProgressLineIdx: number | null = null;
  let lastProgressRenderAt = 0;
  let pendingStrategyResolve: ((choice: "subagent-driven" | "native") => void) | null = null;

  const computeState = (): FullScreenTuiState => {
    const sysPrompt = buildSystemPrompt(agent.config.cwd, agent.config.mode);
    const usedCtx = estimateConversationTokens(sysPrompt, agent.session.messages);
    const modelInfo = agent.getActiveModelInfo();
    const maxCtx = modelInfo?.contextWindow ?? 1_000_000;
    const totalPrompt = agent.session.totalInputTokens + agent.session.totalCacheReadTokens;
    const cacheHitPct =
      totalPrompt > 0
        ? Math.round((agent.session.totalCacheReadTokens / totalPrompt) * 100)
        : 0;

    let formattedBusy: string | null = null;
    if (busyBaseLabel) {
      const frame = BRAILLE_FRAMES[spinnerFrameIdx % BRAILLE_FRAMES.length]!;
      const elapsed = ((Date.now() - busyStartedAt) / 1000).toFixed(1);
      formattedBusy = `${frame} ${busyBaseLabel} (${elapsed}s · Esc to interrupt)`;
    }

    return {
      cols: stdout.columns || 110,
      rows: stdout.rows || 30,
      showSidebar,
      version: "0.4.0",
      cwd: agent.config.cwd,
      gitBranch,
      gatewayUrl: agent.config.baseUrl,
      model: agent.config.model,
      fastModel: agent.config.fastModel,
      wire: agent.config.wire,
      effort: agent.config.reasoningEffort,
      mode: agent.config.mode,
      team: agent.config.team ?? "fullstack",
      sessionId: agent.session.id,
      usedContextTokens: usedCtx,
      maxContextTokens: maxCtx,
      cacheHitPct,
      sessionCostMicro: BigInt(agent.session.totalCostMicro || "0"),
      balanceMicro: keyStatus?.balanceMicro ?? null,
      keyStatus,
      todos: agent.todos,
      modifiedFiles: agent.checkpoints.listModifiedFiles(),
      transcriptLines,
      scrollOffset,
      busyLabel: formattedBusy,
      buffer,
      cursorPos,
      suggestions: modal
        ? { kind: "none", query: "", items: [] }
        : computeComposerSuggestions(
            buffer,
            workspaceFiles,
            (agent.catalog.length > 0 ? agent.catalog : DEFAULT_AIVOKEY_CATALOG).map((m) => m.id),
          ),
      selectedSuggestionIdx,
      modal,
      notice,
    };
  };

  const render = () => {
    const frame = renderFullScreenViewport(computeState());
    // Move cursor to top-left (1,1) and paint full screen without flicker
    stdout.write(`\x1b[H${frame}`);
  };

  const startBusy = (label: string) => {
    busyBaseLabel = label;
    busyStartedAt = Date.now();
    spinnerFrameIdx = 0;
    if (!spinnerTimer) {
      spinnerTimer = setInterval(() => {
        spinnerFrameIdx++;
        render();
      }, 100);
    }
    render();
  };

  const stopBusy = () => {
    busyBaseLabel = null;
    if (spinnerTimer) {
      clearInterval(spinnerTimer);
      spinnerTimer = null;
    }
    render();
  };

  // Wire agent callbacks into the full-screen transcript pane
  (agent as unknown as { callbacks: Record<string, unknown> }).callbacks = {
    onReasoningDelta: (delta: string) => {
      busyBaseLabel = `Thinking with ${agent.config.model}`;
      if (streamingReasoningLineIdx === null) {
        transcriptLines.push(`${c.slate(`╭─ 💭 Thinking (${agent.config.reasoningEffort}) ───`)}`);
        streamingReasoningLineIdx = transcriptLines.length;
        streamingReasoningBuffer = "";
        transcriptLines.push("");
      }
      streamingReasoningBuffer += delta;
      const previewLines = streamingReasoningBuffer
        .split(/\r?\n/)
        .slice(-6)
        .map((l) => `${c.slate("│")} ${c.dim(l)}`);
      transcriptLines.splice(
        streamingReasoningLineIdx,
        transcriptLines.length - streamingReasoningLineIdx,
        ...previewLines,
      );
      scrollOffset = 0;
      render();
    },
    onTextDelta: (delta: string) => {
      busyBaseLabel = `Streaming from ${agent.config.model}`;
      if (streamingReasoningLineIdx !== null) {
        transcriptLines.push(`${c.slate("╰─ End Thinking ───")}`);
        streamingReasoningLineIdx = null;
      }
      if (streamingAssistantLineIdx === null) {
        transcriptLines.push(`${c.emerald("◆")} ${c.bold(agent.config.model)}`);
        streamingAssistantLineIdx = transcriptLines.length;
        streamingAssistantBuffer = "";
        transcriptLines.push("");
      }
      streamingAssistantBuffer += delta;
      const formatted = renderTerminalMarkdown(streamingAssistantBuffer)
        .split("\n")
        .map((l) => `  ${l}`);
      transcriptLines.splice(
        streamingAssistantLineIdx,
        transcriptLines.length - streamingAssistantLineIdx,
        ...formatted,
      );
      scrollOffset = 0;
      render();
    },
    onToolCall: (name: string, args: Record<string, unknown>) => {
      streamingAssistantLineIdx = null;
      streamingReasoningLineIdx = null;
      streamingToolProgressLineIdx = null;
      busyBaseLabel = `Running ${name}`;
      void args;
      render();
    },
    onToolCallProgress: (
      target: string,
      bytes: number,
      lines: number,
      preview: string,
    ) => {
      const kb = (bytes / 1024).toFixed(1);
      busyBaseLabel = `Streaming ${target} · ${lines} lines (${kb} KB)`;
      const now = Date.now();
      if (now - lastProgressRenderAt < 80) return;
      lastProgressRenderAt = now;

      if (streamingReasoningLineIdx !== null) {
        transcriptLines.push(`${c.slate("╰─ End Thinking ───")}`);
        streamingReasoningLineIdx = null;
      }
      if (streamingToolProgressLineIdx === null) {
        streamingToolProgressLineIdx = transcriptLines.length;
        transcriptLines.push("");
      }
      const previewRow = `${c.cyan("◌")} ${c.bold(target)} ${c.emerald(`${lines} lines`)} ${c.slate(`(${kb} KB)`)} ${c.dim(preview.slice(-60))}`;
      transcriptLines.splice(
        streamingToolProgressLineIdx,
        transcriptLines.length - streamingToolProgressLineIdx,
        previewRow,
      );
      scrollOffset = 0;
      render();
    },
    onToolResult: (
      name: string,
      _output: string,
      isError?: boolean,
      details?: { durationMs?: number; summary?: string; diff?: { filePath: string; before: string; after: string } },
      args?: Record<string, unknown>,
    ) => {
      if (streamingToolProgressLineIdx !== null) {
        transcriptLines.splice(
          streamingToolProgressLineIdx,
          transcriptLines.length - streamingToolProgressLineIdx,
        );
        streamingToolProgressLineIdx = null;
      }
      const card = renderToolCallCard({
        name,
        args: args ?? {},
        status: isError ? "error" : "ok",
        durationMs: details?.durationMs,
        summary: details?.summary,
      });
      transcriptLines.push(card);
      if (!isError && details?.diff) {
        const diffLines = renderUnifiedDiff(
          details.diff.filePath,
          details.diff.before,
          details.diff.after,
          2,
        ).split("\n");
        transcriptLines.push(...diffLines);
      }
      if (!isError && name === "todo_write") {
        transcriptLines.push(...renderTodoBoard(agent.todos).split("\n"));
      }
      scrollOffset = 0;
      render();
    },
    onTodoUpdate: () => {
      render();
    },
    onNotice: (msg: string) => {
      notice = msg;
      transcriptLines.push(`  ${c.amber(`⚡ ${msg}`)}`);
      render();
    },
    chooseStrategy: async (decision: {
      teamName: string;
      recommendedMode: "subagent-driven" | "native";
    }) => {
      stopBusy();
      modal = {
        id: "strategy",
        title: `Choose Execution Strategy — ${decision.teamName}`,
        filter: "",
        selectedIdx: decision.recommendedMode === "subagent-driven" ? 0 : 1,
        items: [
          {
            value: "subagent-driven",
            label: "Subagent-Driven Team Workflow",
            badge: "[Recommended]",
            detail: `Multi-stage specialist workflow (${decision.teamName}: Architect → Builder → QA)`,
          },
          {
            value: "native",
            label: "Native Direct Execution",
            badge: "[Fast]",
            detail: "Implement directly in this session + automated Review & Fix gate",
          },
        ],
      };
      render();
      return new Promise<"subagent-driven" | "native">((resStrategy) => {
        pendingStrategyResolve = resStrategy;
      });
    },
    confirmAction: async (description: string) => {
      stopBusy();
      modal = {
        id: "confirm",
        title: `Allow ${description}?`,
        filter: "",
        selectedIdx: 0,
        items: [
          { value: "yes", label: "Yes, allow once", detail: "Execute this tool call now" },
          { value: "always", label: "Always allow in session", detail: "Switch session to AUTO mode" },
          { value: "no", label: "No, decline", detail: "Skip this action" },
        ],
      };
      render();
      return new Promise<boolean>((resConfirm) => {
        pendingConfirmResolve = resConfirm;
      });
    },
  };

  let activeSubagentRoleTarget: "explore" | "architect" | "builder" | "reviewer" | "all" = "explore";

  const getAvailableCatalog = () =>
    agent.catalog.length > 0 ? agent.catalog : DEFAULT_AIVOKEY_CATALOG;

  const buildModelModalItems = (): ModalOption[] =>
    getAvailableCatalog().map((m) => {
      const inUsd = (Number(m.inputMicroPer1M) / 1_000_000).toFixed(2);
      const outUsd = (Number(m.outputMicroPer1M) / 1_000_000).toFixed(2);
      const badges: string[] = [];
      if (m.supportsTools) badges.push("tools");
      if (m.supportsReasoning) badges.push("reasoning");
      if (m.supportsPromptCache) badges.push("cache");
      return {
        value: m.id,
        label: m.id,
        badge: `[${badges.join("·")}]`,
        detail: `${formatCompactTokens(m.contextWindow)} ctx · $${inUsd}/$${outUsd}`,
      };
    });

  const openModelModal = () => {
    const items = buildModelModalItems();
    const curIdx = Math.max(
      0,
      items.findIndex((i) => i.value === agent.config.model),
    );
    modal = {
      id: "model",
      title: `Select Primary AivoKey Model (${items.length} models · Ctrl+K)`,
      filter: "",
      selectedIdx: curIdx,
      items,
    };
    render();
  };

  const openSubagentModelModal = (
    role: "explore" | "architect" | "builder" | "reviewer" | "all",
  ) => {
    activeSubagentRoleTarget = role;
    const items = buildModelModalItems();
    const curModel =
      role === "architect"
        ? (agent.config.architectModel ?? agent.config.model)
        : role === "builder"
          ? (agent.config.builderModel ?? agent.config.model)
          : role === "reviewer"
            ? (agent.config.reviewerModel ?? agent.config.model)
            : (agent.config.fastModel ?? agent.config.model);
    const curIdx = Math.max(
      0,
      items.findIndex((i) => i.value === curModel),
    );
    modal = {
      id: "subagent_model",
      title: `Select Model for ${role.toUpperCase()} Subagent`,
      filter: "",
      selectedIdx: curIdx,
      items,
    };
    render();
  };

  const openSubagentEffortModal = () => {
    const efforts: Array<{ value: ReasoningEffort; detail: string }> = [
      { value: "off", detail: "No thinking delay on subagents" },
      { value: "minimal", detail: "Very brief thinking" },
      { value: "low", detail: "Light reasoning (recommended for fast subagents)" },
      { value: "medium", detail: "Balanced reasoning" },
      { value: "high", detail: "Deep reasoning for Architect/QA subagents" },
      { value: "xhigh", detail: "Extended reasoning" },
      { value: "max", detail: "Maximum thinking budget" },
    ];
    const cur = agent.config.subagentEffort ?? "low";
    modal = {
      id: "subagent_effort",
      title: "Select Subagent Reasoning Effort",
      filter: "",
      selectedIdx: Math.max(0, efforts.findIndex((e) => e.value === cur)),
      items: efforts.map((e) => ({ value: e.value, label: e.value, detail: e.detail })),
    };
    render();
  };

  const openSubagentRoleModal = () => {
    const cfg = agent.config;
    modal = {
      id: "subagent_role",
      title: "Configure Subagent & Specialist Role Models (Ctrl+G)",
      filter: "",
      selectedIdx: 0,
      items: [
        {
          value: "explore",
          label: "Explore / Fast Subagent",
          badge: `[${cfg.fastModel ?? `${cfg.model} (inherit)`}]`,
          detail: "Fast read-only codebase search subagent",
        },
        {
          value: "architect",
          label: "Architect Role (Stage 1)",
          badge: `[${cfg.architectModel ?? `${cfg.model} (inherit)`}]`,
          detail: "System, UX, Android, 3D & Game Systems Architect",
        },
        {
          value: "builder",
          label: "Builder Role (Stage 2)",
          badge: `[${cfg.builderModel ?? `${cfg.model} (inherit)`}]`,
          detail: "Backend, Frontend, Kotlin, Blender BPY & Gameplay Builder",
        },
        {
          value: "reviewer",
          label: "QA & Reviewer Role (Stage 3/4)",
          badge: `[${cfg.reviewerModel ?? `${cfg.model} (inherit)`}]`,
          detail: "Security, Accessibility, Anti-Slop & Test Reviewer",
        },
        {
          value: "all",
          label: "Set All Subagent Roles Together",
          badge: "[sync all]",
          detail: "Assign one model across Explore, Architect, Builder & Reviewer",
        },
        {
          value: "effort",
          label: "Subagent Reasoning Effort",
          badge: `[${cfg.subagentEffort ?? "low"}]`,
          detail: "Configure thinking effort used by child subagents",
        },
      ],
    };
    render();
  };

  const openStrategyConfigModal = () => {
    const cur = agent.config.strategy ?? "auto";
    const items: Array<{ value: ExecutionStrategy; detail: string }> = [
      {
        value: "auto",
        label: "auto",
        detail: "Auto-detect team, seed live tasks & run build + Review-Fix gate",
      } as unknown as { value: ExecutionStrategy; detail: string },
      {
        value: "subagent-driven",
        detail: "Always run multi-stage Architect → Builder → QA team workflow",
      },
      {
        value: "native",
        detail: "Always run fast single-session build + automated Review-Fix gate",
      },
      {
        value: "ask",
        detail: "Ask me to choose Subagent-Driven vs Native before substantial builds",
      },
    ];
    modal = {
      id: "strategy_config",
      title: "Select Execution Strategy (/strategy)",
      filter: "",
      selectedIdx: Math.max(0, items.findIndex((i) => i.value === cur)),
      items: items.map((i) => ({ value: i.value, label: i.value, detail: i.detail })),
    };
    render();
  };

  const openConfigModal = () => {
    const cfg = agent.config;
    modal = {
      id: "config",
      title: "AivoCode Settings & Configuration Center (/config · Ctrl+O)",
      filter: "",
      selectedIdx: 0,
      items: [
        {
          value: "model",
          label: "Primary Agent Model",
          badge: `[${cfg.model}]`,
          detail: "Main model for conversation & coding",
        },
        {
          value: "subagent_explore",
          label: "Explore Subagent Model",
          badge: `[${cfg.fastModel ?? `${cfg.model} (inherit)`}]`,
          detail: "Fast model for read-only explore subagents",
        },
        {
          value: "subagent_architect",
          label: "Architect Role Model",
          badge: `[${cfg.architectModel ?? `${cfg.model} (inherit)`}]`,
          detail: "Model for Stage 1 Architecture & Design",
        },
        {
          value: "subagent_builder",
          label: "Builder Role Model",
          badge: `[${cfg.builderModel ?? `${cfg.model} (inherit)`}]`,
          detail: "Model for Stage 2 Code Implementation",
        },
        {
          value: "subagent_reviewer",
          label: "QA Reviewer Role Model",
          badge: `[${cfg.reviewerModel ?? `${cfg.model} (inherit)`}]`,
          detail: "Model for Stage 3/4 QA, Security & Anti-Slop Review",
        },
        {
          value: "subagent_all",
          label: "Sync All Subagent Models",
          badge: "[all roles]",
          detail: "Set one model for Explore, Architect, Builder & Reviewer",
        },
        {
          value: "strategy",
          label: "Execution Strategy",
          badge: `[${cfg.strategy ?? "auto"}]`,
          detail: "auto · subagent-driven · native · ask",
        },
        {
          value: "team",
          label: "Specialist Agent Team",
          badge: `[${cfg.team ?? "fullstack"}]`,
          detail: "fullstack · backend · frontend · android · blender3d · gamedev · autopilot",
        },
        {
          value: "mode",
          label: "Permission Mode",
          badge: `[${cfg.mode.toUpperCase()}]`,
          detail: "auto (Build) · plan (Read-only) · safe (Confirm)",
        },
        {
          value: "effort",
          label: "Primary Reasoning Effort",
          badge: `[${cfg.reasoningEffort}]`,
          detail: "off · minimal · low · medium · high · xhigh · max",
        },
        {
          value: "subagent_effort",
          label: "Subagent Reasoning Effort",
          badge: `[${cfg.subagentEffort ?? "low"}]`,
          detail: "off · minimal · low · medium · high · xhigh · max",
        },
        {
          value: "wire",
          label: "Protocol Wire",
          badge: `[${cfg.wire}]`,
          detail: "chat (/v1/chat/completions) · messages (/v1/messages) · responses (/v1/responses)",
        },
        {
          value: "autoReviewFix",
          label: "Automated Review & Fix Gate",
          badge: `[${cfg.autoReviewFix !== false ? "ON" : "OFF"}]`,
          detail: "Toggle automatic post-edit verification & review-fix pass",
        },
      ],
    };
    render();
  };

  const openEffortModal = () => {
    const efforts: Array<{ value: ReasoningEffort; detail: string }> = [
      { value: "off", detail: "Fastest direct streaming (no thinking delay)" },
      { value: "minimal", detail: "Very brief thinking before answer" },
      { value: "low", detail: "Light reasoning for quick code edits" },
      { value: "medium", detail: "Balanced reasoning for multi-file tasks" },
      { value: "high", detail: "Deep architectural reasoning" },
      { value: "xhigh", detail: "Extended reasoning for hard bugs" },
      { value: "max", detail: "Maximum thinking budget" },
    ];
    modal = {
      id: "effort",
      title: "Select Reasoning Effort Level",
      filter: "",
      selectedIdx: Math.max(0, efforts.findIndex((e) => e.value === agent.config.reasoningEffort)),
      items: efforts.map((e) => ({ value: e.value, label: e.value, detail: e.detail })),
    };
    render();
  };

  const openModeModal = () => {
    const modes: Array<{ value: PermissionMode; detail: string }> = [
      { value: "auto", detail: "Full autonomous coding agent (read, edit, write, shell)" },
      { value: "plan", detail: "Read-only Architect Mode (explores & plans only)" },
      { value: "safe", detail: "Confirm before every file edit or shell command" },
    ];
    modal = {
      id: "mode",
      title: "Select Agent Permission Mode",
      filter: "",
      selectedIdx: Math.max(0, modes.findIndex((m) => m.value === agent.config.mode)),
      items: modes.map((m) => ({ value: m.value, label: m.value.toUpperCase(), detail: m.detail })),
    };
    render();
  };

  const openWireModal = () => {
    const wires: Array<{ value: AivoWire; detail: string }> = [
      { value: "chat", detail: "POST /v1/chat/completions (OpenAI Chat Completions)" },
      { value: "messages", detail: "POST /v1/messages (Anthropic Messages + ephemeral cache)" },
      { value: "responses", detail: "POST /v1/responses (OpenAI Responses wire)" },
    ];
    modal = {
      id: "wire",
      title: "Select AivoKey Protocol Wire",
      filter: "",
      selectedIdx: Math.max(0, wires.findIndex((w) => w.value === agent.config.wire)),
      items: wires.map((w) => ({ value: w.value, label: w.value, detail: w.detail })),
    };
    render();
  };

  const openTeamModal = () => {
    const curTeam = agent.config.team ?? "fullstack";
    modal = {
      id: "team",
      title: "Select Specialist Agent Team & Workflow (Ctrl+A)",
      filter: "",
      selectedIdx: Math.max(0, AGENT_TEAMS.findIndex((t) => t.id === curTeam)),
      items: AGENT_TEAMS.map((t) => ({
        value: t.id,
        label: t.id,
        badge: `[${t.roles.map((r) => r.badge).join("→")}]`,
        detail: `${t.name} — ${t.description.slice(0, 46)}`,
      })),
    };
    render();
  };

  const openCommandPaletteModal = () => {
    modal = {
      id: "command",
      title: "AivoCode Command Palette (Ctrl+P)",
      filter: "",
      selectedIdx: 0,
      items: SLASH_COMMANDS.map((s) => ({
        value: s.cmd,
        label: s.cmd,
        detail: s.description,
      })),
    };
    render();
  };

  const executePromptOrCommand = async (rawLine: string) => {
    const line = rawLine.trim();
    if (!line) return;
    if (history[history.length - 1] !== line) {
      history.push(line);
    }
    historyIdx = history.length;

    if (line.startsWith("!")) {
      const shellCmd = line.slice(1).trim();
      transcriptLines.push(`${c.amber("$")} ${c.bold(shellCmd)}`);
      if (shellCmd) {
        try {
          const out = execSync(shellCmd, {
            cwd: agent.config.cwd,
            encoding: "utf8",
            stdio: "pipe",
          });
          if (out) {
            transcriptLines.push(...out.trimEnd().split(/\r?\n/).map((l) => `  ${c.slate(l)}`));
          }
        } catch (err) {
          transcriptLines.push(
            `  ${c.rose(`Command failed: ${err instanceof Error ? err.message : String(err)}`)}`,
          );
        }
        gitBranch = getGitBranchLabel(agent.config.cwd);
      }
      scrollOffset = 0;
      render();
      return;
    }

    if (line.startsWith("/")) {
      const cmdOnly = line.toLowerCase();
      if (cmdOnly === "/model" || cmdOnly === "/models") {
        openModelModal();
        return;
      }
      if (cmdOnly === "/subagent" || cmdOnly === "/subagent-model" || cmdOnly === "/fast-model") {
        openSubagentRoleModal();
        return;
      }
      if (cmdOnly === "/config" || cmdOnly === "/settings") {
        openConfigModal();
        return;
      }
      if (cmdOnly === "/strategy") {
        openStrategyConfigModal();
        return;
      }
      if (cmdOnly === "/effort") {
        openEffortModal();
        return;
      }
      if (cmdOnly === "/mode") {
        openModeModal();
        return;
      }
      if (cmdOnly === "/wire") {
        openWireModal();
        return;
      }
      if (cmdOnly === "/team" || cmdOnly === "/agents") {
        openTeamModal();
        return;
      }
      const res = await handleSlashCommand(line, agent, keyStatus, fetchFn, false);
      if (res.updatedKeyStatus !== undefined) {
        keyStatus = res.updatedKeyStatus;
      }
      if (cmdOnly === "/clear" || cmdOnly === "/new") {
        transcriptLines.length = 0;
      }
      transcriptLines.push(...res.output.split("\n"));
      transcriptLines.push("");
      scrollOffset = 0;
      render();
      if (res.shouldExit) {
        cleanupAndExit();
      }
      return;
    }

    // Standard user prompt to LLM agent
    transcriptLines.push(`${c.cyan("❯")} ${c.bold(c.white(line))}`);
    streamingAssistantLineIdx = null;
    streamingReasoningLineIdx = null;
    scrollOffset = 0;

    activeAbort = new AbortController();
    startBusy(`Connecting to ${agent.config.model}`);

    try {
      const turnRes = await agent.runUserPrompt(line, activeAbort.signal);
      stopBusy();
      workspaceFiles = walkWorkspaceFiles(agent.config.cwd);
      gitBranch = getGitBranchLabel(agent.config.cwd);

      const totalIn = turnRes.turnUsage.inputTokens + turnRes.turnUsage.cacheReadTokens;
      const cachePct =
        totalIn > 0 ? Math.round((turnRes.turnUsage.cacheReadTokens / totalIn) * 100) : 0;
      const savedTag =
        turnRes.turnCacheSavedMicro > 0n
          ? ` · saved ${formatMicroUsd(turnRes.turnCacheSavedMicro)}`
          : "";

      transcriptLines.push(
        c.slate(
          `  ↳ in=${turnRes.turnUsage.inputTokens.toLocaleString("en-US")} · cache=${turnRes.turnUsage.cacheReadTokens.toLocaleString("en-US")} (${cachePct}%) · out=${turnRes.turnUsage.outputTokens.toLocaleString("en-US")} · cost=${formatMicroUsd(turnRes.turnCostMicro)}${savedTag}`,
        ),
      );
      transcriptLines.push("");
      scrollOffset = 0;
      render();
    } catch (err) {
      stopBusy();
      if (activeAbort.signal.aborted) {
        transcriptLines.push(`  ${c.amber("⚠ Generation interrupted by user (Esc).")}`);
      } else if (
        err &&
        typeof (err as { formatUserAdvice?: unknown }).formatUserAdvice === "function"
      ) {
        transcriptLines.push(
          `  ${c.rose("✗")} ${c.bold((err as { formatUserAdvice(): string }).formatUserAdvice())}`,
        );
      } else {
        transcriptLines.push(
          `  ${c.rose("✗")} ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      transcriptLines.push("");
      scrollOffset = 0;
      render();
    } finally {
      activeAbort = null;
      streamingAssistantLineIdx = null;
      streamingReasoningLineIdx = null;
    }
  };

  let exitResolve: (() => void) | null = null;
  let cleanedUp = false;

  const cleanupAndExit = () => {
    if (cleanedUp) return;
    cleanedUp = true;
    if (spinnerTimer) clearInterval(spinnerTimer);
    stdout.off("resize", onResize);
    stdin.off("keypress", onKeypress);
    if (stdin.isTTY) stdin.setRawMode(false);
    // Restore normal screen buffer and cursor
    stdout.write("\x1b[?25h\x1b[?1049l");
    exitResolve?.();
  };

  const onResize = () => {
    render();
  };

  const onKeypress = (
    str: string | undefined,
    key: { name?: string; ctrl?: boolean; shift?: boolean; meta?: boolean } | undefined,
  ) => {
    // 1. If a centered modal is open, handle modal navigation
    if (modal) {
      const m = modal;
      const filtered = m.filter.trim()
        ? m.items.filter(
            (it) =>
              it.label.toLowerCase().includes(m.filter.toLowerCase()) ||
              (it.badge ?? "").toLowerCase().includes(m.filter.toLowerCase()) ||
              (it.detail ?? "").toLowerCase().includes(m.filter.toLowerCase()),
          )
        : m.items;

      if (key?.name === "escape" || (key?.ctrl && key?.name === "c")) {
        if (m.id === "strategy" && pendingStrategyResolve) {
          const fn = pendingStrategyResolve;
          pendingStrategyResolve = null;
          modal = null;
          render();
          fn("native");
          return;
        }
        if (m.id === "confirm" && pendingConfirmResolve) {
          const fn = pendingConfirmResolve;
          pendingConfirmResolve = null;
          modal = null;
          render();
          fn(false);
          return;
        }
        modal = null;
        render();
        return;
      }

      if (key?.name === "up") {
        m.selectedIdx =
          filtered.length > 0 ? (m.selectedIdx - 1 + filtered.length) % filtered.length : 0;
        render();
        return;
      }
      if (key?.name === "down") {
        m.selectedIdx =
          filtered.length > 0 ? (m.selectedIdx + 1) % filtered.length : 0;
        render();
        return;
      }
      if (key?.name === "backspace") {
        m.filter = m.filter.slice(0, -1);
        m.selectedIdx = 0;
        render();
        return;
      }
      if (key?.name === "return" || key?.name === "enter") {
        const chosen = filtered[m.selectedIdx];
        const modalId = m.id;
        modal = null;
        if (modalId === "strategy" && pendingStrategyResolve) {
          const fn = pendingStrategyResolve;
          pendingStrategyResolve = null;
          render();
          fn(chosen?.value === "subagent-driven" ? "subagent-driven" : "native");
          return;
        }
        if (modalId === "confirm" && pendingConfirmResolve) {
          const fn = pendingConfirmResolve;
          pendingConfirmResolve = null;
          if (chosen?.value === "always") {
            agent.config.mode = "auto";
            saveUserConfig({ mode: "auto" }, agent.config.globalConfigPath);
            render();
            fn(true);
          } else {
            render();
            fn(chosen?.value === "yes");
          }
          return;
        }
        if (chosen) {
          if (modalId === "model") {
            agent.config.model = chosen.value;
            agent.session.model = chosen.value;
            saveUserConfig({ model: chosen.value }, agent.config.globalConfigPath);
            notice = `Primary model switched to ${chosen.value}`;
          } else if (modalId === "subagent_role") {
            if (chosen.value === "effort") {
              openSubagentEffortModal();
              return;
            }
            openSubagentModelModal(
              chosen.value as "explore" | "architect" | "builder" | "reviewer" | "all",
            );
            return;
          } else if (modalId === "subagent_model") {
            const role = activeSubagentRoleTarget;
            if (role === "explore") {
              agent.config.fastModel = chosen.value;
              saveUserConfig({ fastModel: chosen.value }, agent.config.globalConfigPath);
            } else if (role === "architect") {
              agent.config.architectModel = chosen.value;
              saveUserConfig({ architectModel: chosen.value }, agent.config.globalConfigPath);
            } else if (role === "builder") {
              agent.config.builderModel = chosen.value;
              saveUserConfig({ builderModel: chosen.value }, agent.config.globalConfigPath);
            } else if (role === "reviewer") {
              agent.config.reviewerModel = chosen.value;
              saveUserConfig({ reviewerModel: chosen.value }, agent.config.globalConfigPath);
            } else if (role === "all") {
              agent.config.fastModel = chosen.value;
              agent.config.architectModel = chosen.value;
              agent.config.builderModel = chosen.value;
              agent.config.reviewerModel = chosen.value;
              saveUserConfig(
                {
                  fastModel: chosen.value,
                  architectModel: chosen.value,
                  builderModel: chosen.value,
                  reviewerModel: chosen.value,
                },
                agent.config.globalConfigPath,
              );
            }
            notice = `Set ${role} subagent model to ${chosen.value}`;
          } else if (modalId === "subagent_effort") {
            agent.config.subagentEffort = chosen.value as ReasoningEffort;
            saveUserConfig(
              { subagentEffort: chosen.value as ReasoningEffort },
              agent.config.globalConfigPath,
            );
            notice = `Subagent reasoning effort set to ${chosen.value}`;
          } else if (modalId === "strategy_config") {
            agent.config.strategy = chosen.value as ExecutionStrategy;
            saveUserConfig(
              { strategy: chosen.value as ExecutionStrategy },
              agent.config.globalConfigPath,
            );
            notice = `Execution strategy set to ${chosen.value}`;
          } else if (modalId === "config") {
            switch (chosen.value) {
              case "model":
                openModelModal();
                return;
              case "subagent_explore":
                openSubagentModelModal("explore");
                return;
              case "subagent_architect":
                openSubagentModelModal("architect");
                return;
              case "subagent_builder":
                openSubagentModelModal("builder");
                return;
              case "subagent_reviewer":
                openSubagentModelModal("reviewer");
                return;
              case "subagent_all":
                openSubagentModelModal("all");
                return;
              case "strategy":
                openStrategyConfigModal();
                return;
              case "team":
                openTeamModal();
                return;
              case "mode":
                openModeModal();
                return;
              case "effort":
                openEffortModal();
                return;
              case "subagent_effort":
                openSubagentEffortModal();
                return;
              case "wire":
                openWireModal();
                return;
              case "autoReviewFix": {
                const nextVal = agent.config.autoReviewFix === false;
                agent.config.autoReviewFix = nextVal;
                saveUserConfig({ autoReviewFix: nextVal }, agent.config.globalConfigPath);
                notice = `Auto Review & Fix Gate: ${nextVal ? "ON" : "OFF"}`;
                openConfigModal();
                return;
              }
            }
          } else if (modalId === "effort") {
            agent.config.reasoningEffort = chosen.value as ReasoningEffort;
            saveUserConfig(
              { reasoningEffort: chosen.value as ReasoningEffort },
              agent.config.globalConfigPath,
            );
            notice = `Reasoning effort set to ${chosen.value}`;
          } else if (modalId === "mode") {
            agent.config.mode = chosen.value as PermissionMode;
            saveUserConfig({ mode: chosen.value as PermissionMode }, agent.config.globalConfigPath);
            notice = `Mode switched to ${chosen.value.toUpperCase()}`;
          } else if (modalId === "wire") {
            agent.config.wire = chosen.value as AivoWire;
            agent.session.wire = chosen.value as AivoWire;
            saveUserConfig({ wire: chosen.value as AivoWire }, agent.config.globalConfigPath);
            notice = `Protocol wire set to ${chosen.value}`;
          } else if (modalId === "team") {
            agent.config.team = chosen.value as TeamId;
            saveUserConfig({ team: chosen.value as TeamId }, agent.config.globalConfigPath);
            const t = getAgentTeam(chosen.value);
            notice = `Specialist Team: ${t?.name ?? chosen.value}`;
          } else if (modalId === "command") {
            render();
            void executePromptOrCommand(chosen.value);
            return;
          }
        }
        render();
        return;
      }
      if (str && str.length === 1 && str >= " " && !key?.ctrl && !key?.meta) {
        m.filter += str;
        m.selectedIdx = 0;
        render();
      }
      return;
    }

    // 2. If agent is busy streaming, Esc or Ctrl+C interrupts the stream
    if (activeAbort) {
      if (key?.name === "escape" || (key?.ctrl && key?.name === "c")) {
        activeAbort.abort();
      }
      return;
    }

    // 3. Global Hotkeys in Composer
    const hotkeyNext = applyComposerHotkeys(
      {
        mode: agent.config.mode,
        effort: agent.config.reasoningEffort,
        wire: agent.config.wire,
      },
      key,
    );
    if (hotkeyNext) {
      agent.config.mode = hotkeyNext.mode;
      agent.config.reasoningEffort = hotkeyNext.effort;
      agent.config.wire = hotkeyNext.wire;
      agent.session.wire = hotkeyNext.wire;
      saveUserConfig(
        {
          mode: hotkeyNext.mode,
          reasoningEffort: hotkeyNext.effort,
          wire: hotkeyNext.wire,
        },
        agent.config.globalConfigPath,
      );
      notice = `Mode=${hotkeyNext.mode.toUpperCase()} · Effort=${hotkeyNext.effort} · Wire=${hotkeyNext.wire}`;
      render();
      return;
    }

    // Ctrl+K -> Open Primary Model Switcher Modal
    if (key?.ctrl && key.name === "k") {
      openModelModal();
      return;
    }

    // Ctrl+G -> Open Subagent & Role Model Picker Modal
    if (key?.ctrl && key.name === "g") {
      openSubagentRoleModal();
      return;
    }

    // Ctrl+O -> Open Settings & Configuration Center Modal
    if (key?.ctrl && key.name === "o") {
      openConfigModal();
      return;
    }

    // Ctrl+A -> Open Specialist Agent Team Modal
    if (key?.ctrl && key.name === "a") {
      openTeamModal();
      return;
    }

    // Ctrl+P -> Open Command Palette Modal
    if (key?.ctrl && key.name === "p") {
      openCommandPaletteModal();
      return;
    }

    // F2 -> Cycle through top fast/flagship models
    if (key?.name === "f2" && agent.catalog.length > 0) {
      const idx = agent.catalog.findIndex((m) => m.id === agent.config.model);
      const next = agent.catalog[(idx + 1) % agent.catalog.length]!;
      agent.config.model = next.id;
      agent.session.model = next.id;
      saveUserConfig({ model: next.id }, agent.config.globalConfigPath);
      notice = `Cycled model to ${next.id}`;
      render();
      return;
    }

    // Ctrl+B -> Toggle Right Sidebar
    if (key?.ctrl && key.name === "b") {
      showSidebar = !showSidebar;
      notice = showSidebar ? "Sidebar shown" : "Sidebar hidden";
      render();
      return;
    }

    // PageUp / PageDown -> Scroll Transcript
    if (key?.name === "pageup") {
      scrollOffset += 8;
      render();
      return;
    }
    if (key?.name === "pagedown") {
      scrollOffset = Math.max(0, scrollOffset - 8);
      render();
      return;
    }

    // Ctrl+C / Ctrl+D -> Clear buffer or exit
    if (key?.ctrl && (key.name === "c" || key.name === "d")) {
      if (buffer.length > 0) {
        buffer = "";
        cursorPos = 0;
        notice = "Cleared input (press Ctrl+C again to exit)";
        render();
        return;
      }
      cleanupAndExit();
      return;
    }

    if (key?.name === "escape") {
      buffer = "";
      cursorPos = 0;
      scrollOffset = 0;
      notice = null;
      render();
      return;
    }

    const catalogIds = getAvailableCatalog().map((m) => m.id);
    const suggestions = computeComposerSuggestions(buffer, workspaceFiles, catalogIds);

    // Up / Down arrows: navigate suggestion dropdown or prompt history
    if (key?.name === "up") {
      if (suggestions.items.length > 0) {
        selectedSuggestionIdx =
          (selectedSuggestionIdx - 1 + suggestions.items.length) %
          suggestions.items.length;
        render();
        return;
      }
      if (history.length > 0 && historyIdx > 0) {
        historyIdx--;
        buffer = history[historyIdx] ?? "";
        cursorPos = buffer.length;
        render();
      }
      return;
    }

    if (key?.name === "down") {
      if (suggestions.items.length > 0) {
        selectedSuggestionIdx =
          (selectedSuggestionIdx + 1) % suggestions.items.length;
        render();
        return;
      }
      if (historyIdx < history.length - 1) {
        historyIdx++;
        buffer = history[historyIdx] ?? "";
        cursorPos = buffer.length;
        render();
      } else if (historyIdx === history.length - 1) {
        historyIdx = history.length;
        buffer = "";
        cursorPos = 0;
        render();
      }
      return;
    }

    if (key?.name === "left") {
      cursorPos = Math.max(0, cursorPos - 1);
      render();
      return;
    }
    if (key?.name === "right") {
      cursorPos = Math.min(buffer.length, cursorPos + 1);
      render();
      return;
    }
    if (key?.name === "home" || (key?.ctrl && key.name === "a")) {
      cursorPos = 0;
      render();
      return;
    }
    if (key?.name === "end") {
      cursorPos = buffer.length;
      scrollOffset = 0;
      render();
      return;
    }

    // Tab: complete highlighted `/` command, argument, or `@file`
    if (key?.name === "tab" && !key.shift) {
      const chosen = suggestions.items[selectedSuggestionIdx];
      if (chosen) {
        if (suggestions.kind === "slash") {
          buffer = `${chosen.value} `;
          cursorPos = buffer.length;
          selectedSuggestionIdx = 0;
        } else if (suggestions.kind === "arg") {
          buffer = chosen.value;
          cursorPos = buffer.length;
          selectedSuggestionIdx = 0;
        } else if (suggestions.kind === "file") {
          buffer = buffer.replace(/(^|\s)@([^\s]*)$/, `$1@${chosen.value} `);
          cursorPos = buffer.length;
          selectedSuggestionIdx = 0;
        }
        render();
      }
      return;
    }

    // Enter / Return
    if (key?.name === "return" || key?.name === "enter") {
      if (suggestions.kind === "file" && suggestions.items.length > 0) {
        const chosen = suggestions.items[selectedSuggestionIdx];
        if (chosen) {
          buffer = buffer.replace(/(^|\s)@([^\s]*)$/, `$1@${chosen.value} `);
          cursorPos = buffer.length;
          selectedSuggestionIdx = 0;
          render();
          return;
        }
      }
      if (
        (suggestions.kind === "slash" || suggestions.kind === "arg") &&
        suggestions.items.length > 0
      ) {
        const chosen = suggestions.items[selectedSuggestionIdx];
        if (chosen && buffer.trim() !== chosen.value) {
          buffer = chosen.value;
          cursorPos = buffer.length;
          if (chosen.value.endsWith(" ")) {
            selectedSuggestionIdx = 0;
            render();
            return;
          }
        }
      }
      const lineToRun = buffer.trim();
      buffer = "";
      cursorPos = 0;
      selectedSuggestionIdx = 0;
      notice = null;
      render();
      if (lineToRun) {
        void executePromptOrCommand(lineToRun);
      }
      return;
    }

    if (key?.name === "backspace") {
      if (cursorPos > 0) {
        buffer = buffer.slice(0, cursorPos - 1) + buffer.slice(cursorPos);
        cursorPos--;
        selectedSuggestionIdx = 0;
        notice = null;
        render();
      }
      return;
    }

    if (key?.name === "delete") {
      if (cursorPos < buffer.length) {
        buffer = buffer.slice(0, cursorPos) + buffer.slice(cursorPos + 1);
        selectedSuggestionIdx = 0;
        render();
      }
      return;
    }

    if (str && !key?.ctrl && !key?.meta) {
      const clean = str.replace(/[\r\n]+/g, " ");
      if (clean.length > 0 && clean >= " ") {
        buffer = buffer.slice(0, cursorPos) + clean + buffer.slice(cursorPos);
        cursorPos += clean.length;
        selectedSuggestionIdx = 0;
        notice = null;
        render();
      }
    }
  };

  // Enter Alternate Screen Buffer + Hide hardware cursor (we draw our own `▏` cursor inside the composer!)
  emitKeypressEvents(stdin);
  if (stdin.isTTY) stdin.setRawMode(true);
  stdin.resume();
  stdout.write("\x1b[?1049h\x1b[?25l\x1b[2J\x1b[H");

  stdout.on("resize", onResize);
  stdin.on("keypress", onKeypress);
  render();

  return new Promise<void>((resPromise) => {
    exitResolve = resPromise;
  });
}

export interface ModalOption {
  value: string;
  label: string;
  badge?: string;
  detail?: string;
}

export interface FullScreenModalState {
  id?:
    | "model"
    | "subagent_role"
    | "subagent_model"
    | "subagent_effort"
    | "strategy_config"
    | "config"
    | "effort"
    | "mode"
    | "wire"
    | "team"
    | "command"
    | "sessions"
    | "confirm"
    | "strategy";
  title: string;
  filter: string;
  selectedIdx: number;
  items: ModalOption[];
}

export interface FullScreenTuiState {
  cols: number;
  rows: number;
  showSidebar: boolean;
  version: string;
  cwd: string;
  gitBranch: string;
  gatewayUrl: string;
  model: string;
  fastModel?: string | null;
  wire: AivoWire;
  effort: ReasoningEffort;
  mode: PermissionMode;
  team?: TeamId;
  sessionId: string;
  usedContextTokens: number;
  maxContextTokens: number;
  cacheHitPct: number;
  sessionCostMicro: bigint;
  balanceMicro?: bigint | null;
  keyStatus: KeyInspectStatus | null;
  todos: TodoItem[];
  modifiedFiles: string[];
  transcriptLines: string[];
  scrollOffset: number;
  busyLabel: string | null;
  buffer: string;
  cursorPos: number;
  suggestions: ComposerSuggestions;
  selectedSuggestionIdx: number;
  modal: FullScreenModalState | null;
  notice: string | null;
}

/**
 * Truncate or pad an ANSI-styled line to an exact visible column width.
 */
export function fitLineToWidth(line: string, width: number): string {
  if (width <= 0) return "";
  const vis = visibleLength(line);
  if (vis === width) return line;
  if (vis < width) return line + " ".repeat(width - vis);

  // Truncate while preserving ANSI escape sequences
  let visibleCount = 0;
  let result = "";
  let i = 0;
  const maxVis = Math.max(0, width - 1);
  while (i < line.length && visibleCount < maxVis) {
    if (line[i] === "\x1b" && line[i + 1] === "[") {
      const endSeq = line.indexOf("m", i);
      if (endSeq !== -1) {
        result += line.slice(i, endSeq + 1);
        i = endSeq + 1;
        continue;
      }
    }
    result += line[i];
    visibleCount++;
    i++;
  }
  result += "\x1b[0m" + (width >= 1 ? "…" : "");
  return padEndVisible(result, width);
}

/**
 * Word-wraps plain or styled text lines so they fit inside `maxWidth` columns.
 */
export function wrapTranscriptLines(lines: string[], maxWidth: number): string[] {
  if (maxWidth <= 8) return lines;
  const wrapped: string[] = [];
  for (const raw of lines) {
    const subLines = raw.split(/\r?\n/);
    for (const line of subLines) {
      if (visibleLength(line) <= maxWidth) {
        wrapped.push(line);
      } else {
        // If line has ANSI codes, fit or wrap plain text
        const plain = stripAnsi(line);
        const hasAnsi = plain.length !== line.length;
        if (hasAnsi) {
          wrapped.push(fitLineToWidth(line, maxWidth));
        } else {
          let rest = plain;
          while (rest.length > maxWidth) {
            wrapped.push(rest.slice(0, maxWidth));
            rest = "  " + rest.slice(maxWidth);
          }
          if (rest.length > 0) wrapped.push(rest);
        }
      }
    }
  }
  return wrapped;
}

function buildSidebarLines(state: FullScreenTuiState, width: number, height: number): string[] {
  const inner = Math.max(10, width - 2);
  const rows: string[] = [];

  const addSection = (title: string) => {
    const hdr = `${c.cyan("◆")} ${c.bold(title)}`;
    rows.push(fitLineToWidth(hdr, inner));
  };
  const addRow = (text: string) => {
    rows.push(fitLineToWidth(`  ${text}`, inner));
  };
  const addDivider = () => {
    rows.push(c.slate("─".repeat(inner)));
  };

  addSection("AivoKey Telemetry");
  const modeStr =
    state.keyStatus?.mode === "plan" && state.keyStatus.plan
      ? `${c.violet(state.keyStatus.plan.name)}`
      : c.cyan("PAYG");
  const balStr =
    state.balanceMicro !== null && state.balanceMicro !== undefined
      ? c.emerald(formatMicroUsd(state.balanceMicro))
      : c.amber("unverified");
  addRow(`${c.slate("Account :")} ${modeStr}`);
  addRow(`${c.slate("Balance :")} ${balStr}`);
  const ctxPct =
    state.maxContextTokens > 0
      ? Math.round((state.usedContextTokens / state.maxContextTokens) * 100)
      : 0;
  addRow(
    `${c.slate("Context :")} ${c.white(`${formatCompactTokens(state.usedContextTokens)}/${formatCompactTokens(state.maxContextTokens)}`)} ${c.slate(`(${ctxPct}%)`)}`,
  );
  addRow(
    `${c.slate("Cache   :")} ${c.teal(`${state.cacheHitPct}% hit`)} · ${c.white(formatMicroUsd(state.sessionCostMicro))}`,
  );

  if (state.keyStatus && state.keyStatus.freeTokens.length > 0) {
    const freeTotal = state.keyStatus.freeTokens.reduce((a, b) => a + b.remainingTokens, 0n);
    addRow(`${c.slate("Faucet  :")} ${c.amber(`${formatCompactTokens(Number(freeTotal))} free`)}`);
  }

  addDivider();
  addSection("Engine & Agent Team");
  const activeTeam = getAgentTeam(state.team ?? "fullstack");
  addRow(
    `${c.slate("Team    :")} ${c.amber(c.bold(activeTeam?.shortLabel ?? "Full-Stack"))} ${c.slate(`[${activeTeam?.roles.map((r) => r.badge).join("→") ?? "ARCH→QA"}]`)}`,
  );
  addRow(`${c.slate("Primary :")} ${c.emerald(c.bold(state.model))}`);
  if (state.fastModel) {
    addRow(`${c.slate("Explorer:")} ${c.teal(state.fastModel)}`);
  }
  addRow(`${c.slate("Wire    :")} ${c.cyan(state.wire)} · ${c.slate("Effort:")} ${c.violet(state.effort)}`);
  addRow(`${c.slate("Session :")} ${c.dim(state.sessionId.slice(0, 18))}`);

  addDivider();
  const doneCount = state.todos.filter((t) => t.status === "completed").length;
  addSection(`Tasks (${doneCount}/${state.todos.length})`);
  if (state.todos.length === 0) {
    addRow(c.dim("No active tasks"));
  } else {
    for (const t of state.todos.slice(0, 5)) {
      const icon =
        t.status === "completed"
          ? c.emerald("✓")
          : t.status === "in_progress"
            ? c.amber("▸")
            : c.slate("○");
      addRow(`${icon} ${t.content}`);
    }
  }

  addDivider();
  addSection(`Touched Files (${state.modifiedFiles.length})`);
  if (state.modifiedFiles.length === 0) {
    addRow(c.dim("No edits in session"));
  } else {
    for (const f of state.modifiedFiles.slice(-5)) {
      const shortF = f.replace(/\\/g, "/").split("/").slice(-3).join("/");
      addRow(`${c.emerald("•")} ${c.white(shortF)}`);
    }
  }

  while (rows.length < height) {
    rows.push(" ".repeat(inner));
  }
  return rows.slice(0, height);
}

/**
 * Pure function that renders the entire Full-Screen Terminal Viewport (`rows` lines × `cols` columns).
 */
export function renderFullScreenViewport(state: FullScreenTuiState): string {
  const cols = Math.max(60, state.cols || 100);
  const rows = Math.max(16, state.rows || 28);

  const hasSidebar = state.showSidebar && cols >= 95;
  const sidebarWidth = hasSidebar ? Math.min(36, Math.max(28, Math.floor(cols * 0.28))) : 0;
  const mainWidth = hasSidebar ? cols - sidebarWidth - 1 : cols;

  // Layout row allocation:
  // Row 0: Top Header Bar (1 row)
  // Row 1: Top Separator (1 row)
  // Middle Body: bodyHeight = rows - 6
  // Bottom Composer: 3 rows (top border, input line, bottom border) + 1 bottom status bar = 4 rows
  const bodyHeight = Math.max(6, rows - 6);

  // ── 1. Top Header Bar (Row 0 & Row 1) ─────────────────────────────────────
  const shortCwd =
    state.cwd.length > 34 ? "…" + state.cwd.slice(state.cwd.length - 33) : state.cwd;
  const gitPart = state.gitBranch ? ` ${c.violet(`(⎇ ${state.gitBranch})`)}` : "";
  const leftHdr = ` ${c.cyan(c.bold("◆ AIVO CODE"))} ${c.slate(`v${state.version}`)} ${c.slate("│")} ${c.white(shortCwd)}${gitPart}`;
  const rightHdr = `${modeBadge(state.mode)} ${c.slate("│")} ${c.emerald(c.bold(state.model))} `;
  const hdrGap = Math.max(1, cols - visibleLength(leftHdr) - visibleLength(rightHdr));
  const row0 = fitLineToWidth(`${leftHdr}${" ".repeat(hdrGap)}${rightHdr}`, cols);

  const row1 = hasSidebar
    ? `${c.slate("─".repeat(mainWidth))}${c.slate("┬")}${c.slate("─".repeat(sidebarWidth))}`
    : c.slate("─".repeat(cols));

  // ── 2. Main Transcript Pane + Optional Right Sidebar ─────────────────────
  const mainInnerWidth = Math.max(20, mainWidth - 2);
  const wrappedTranscript = wrapTranscriptLines(state.transcriptLines, mainInnerWidth);

  const reservedBusyRows = state.busyLabel ? 1 : 0;
  const availTranscriptRows = Math.max(1, bodyHeight - reservedBusyRows);

  const totalLines = wrappedTranscript.length;
  const maxScroll = Math.max(0, totalLines - availTranscriptRows);
  const clampedScroll = Math.min(maxScroll, Math.max(0, state.scrollOffset));
  const endIdx = totalLines - clampedScroll;
  const startIdx = Math.max(0, endIdx - availTranscriptRows);
  const visibleSlice = wrappedTranscript.slice(startIdx, endIdx);

  const leftRows: string[] = [];
  for (const line of visibleSlice) {
    leftRows.push(fitLineToWidth(` ${line}`, mainWidth));
  }
  while (leftRows.length < availTranscriptRows) {
    leftRows.push(" ".repeat(mainWidth));
  }

  if (state.busyLabel) {
    const busyLine = ` ${c.cyan("⠋")} ${c.amber(state.busyLabel)}`;
    leftRows.push(fitLineToWidth(busyLine, mainWidth));
  }

  // Overlay floating `/` or `@` suggestion dropdown at the bottom of `leftRows` if active
  if (!state.modal && state.suggestions.kind !== "none" && state.suggestions.items.length > 0) {
    const maxItems = Math.min(6, state.suggestions.items.length, Math.max(2, bodyHeight - 2));
    const popRows: string[] = [];
    const title =
      state.suggestions.kind === "slash"
        ? "Slash Commands (↑/↓ navigate · Enter/Tab select · Esc close)"
        : "Workspace Files (↑/↓ navigate · Enter/Tab attach · Esc close)";
    popRows.push(
      fitLineToWidth(` ${c.cyan("╭─")} ${c.bold(title)} ${c.cyan("─".repeat(20))}`, mainWidth),
    );
    const itemsSlice = state.suggestions.items.slice(0, maxItems);
    itemsSlice.forEach((it, idx) => {
      const sel = idx === state.selectedSuggestionIdx;
      const ptr = sel ? c.cyan("❯") : " ";
      const lbl = sel ? c.bold(c.cyan(it.label.padEnd(24))) : c.white(it.label.padEnd(24));
      const desc = sel ? c.white(it.description) : c.slate(it.description);
      popRows.push(fitLineToWidth(` ${c.cyan("│")} ${ptr} ${lbl} ${desc}`, mainWidth));
    });
    popRows.push(fitLineToWidth(` ${c.cyan("╰" + "─".repeat(Math.max(10, mainWidth - 4)))}`, mainWidth));

    const replaceStart = Math.max(0, leftRows.length - popRows.length);
    for (let i = 0; i < popRows.length && replaceStart + i < leftRows.length; i++) {
      leftRows[replaceStart + i] = popRows[i]!;
    }
  }

  const rightRows = hasSidebar
    ? buildSidebarLines(state, sidebarWidth, bodyHeight)
    : [];

  const bodyLines: string[] = [];
  for (let r = 0; r < bodyHeight; r++) {
    const leftCell = leftRows[r] ?? " ".repeat(mainWidth);
    if (hasSidebar) {
      const rightCell = rightRows[r] ?? " ".repeat(sidebarWidth - 2);
      bodyLines.push(`${leftCell}${c.slate("│")} ${fitLineToWidth(rightCell, sidebarWidth - 1)}`);
    } else {
      bodyLines.push(leftCell);
    }
  }

  // Overlay Centered Modal if `state.modal` is open
  if (state.modal) {
    const m = state.modal;
    const filtered = m.filter.trim()
      ? m.items.filter(
          (it) =>
            it.label.toLowerCase().includes(m.filter.toLowerCase()) ||
            (it.badge ?? "").toLowerCase().includes(m.filter.toLowerCase()) ||
            (it.detail ?? "").toLowerCase().includes(m.filter.toLowerCase()),
        )
      : m.items;

    const modalW = Math.min(cols - 6, 78);
    const maxList = Math.min(10, Math.max(3, bodyHeight - 5));
    const modalLines: string[] = [];
    const innerModalW = modalW - 4;

    modalLines.push(c.cyan(`╭─ ${m.title} ${"─".repeat(Math.max(2, modalW - m.title.length - 5))}╮`));
    const filterText = `Search: ${m.filter ? c.white(m.filter) : c.dim("type to filter…")} (${filtered.length} items · ↑/↓ · Enter · Esc)`;
    modalLines.push(`${c.cyan("│")} ${padEndVisible(fitLineToWidth(filterText, innerModalW), innerModalW)} ${c.cyan("│")}`);
    modalLines.push(c.cyan(`├${"─".repeat(modalW - 2)}┤`));

    const selIdx = Math.min(Math.max(0, m.selectedIdx), Math.max(0, filtered.length - 1));
    const half = Math.floor(maxList / 2);
    let listStart = Math.max(0, selIdx - half);
    const listEnd = Math.min(filtered.length, listStart + maxList);
    if (listEnd - listStart < maxList) {
      listStart = Math.max(0, listEnd - maxList);
    }

    if (filtered.length === 0) {
      modalLines.push(
        `${c.cyan("│")} ${padEndVisible(c.rose("No matching items."), innerModalW)} ${c.cyan("│")}`,
      );
    } else {
      for (let i = listStart; i < listEnd; i++) {
        const item = filtered[i]!;
        const isCur = i === selIdx;
        const ptr = isCur ? c.cyan("❯") : " ";
        const lbl = isCur
          ? c.bold(c.emerald(item.label.padEnd(23).slice(0, 23)))
          : c.white(item.label.padEnd(23).slice(0, 23));
        const bdg = item.badge ? ` ${c.cyan(item.badge)}` : "";
        const dtl = item.detail ? ` ${c.slate(item.detail)}` : "";
        const rowContent = fitLineToWidth(`${ptr} ${lbl}${bdg}${dtl}`, innerModalW);
        modalLines.push(`${c.cyan("│")} ${rowContent} ${c.cyan("│")}`);
      }
    }
    modalLines.push(c.cyan(`╰${"─".repeat(modalW - 2)}╯`));

    const startRow = Math.max(0, Math.floor((bodyHeight - modalLines.length) / 2));
    for (let i = 0; i < modalLines.length && startRow + i < bodyLines.length; i++) {
      bodyLines[startRow + i] = fitLineToWidth(`  ${modalLines[i]!}`, cols);
    }
  }

  // ── 3. Bottom Docked Composer Box (3 rows) + Bottom Hotkey/Status Ribbon (1 row) ──
  const borderColor =
    state.mode === "plan" ? c.violet : state.mode === "safe" ? c.amber : c.cyan;
  const modeLabel =
    state.mode === "plan"
      ? "PLAN · ARCHITECT (Read-Only)"
      : state.mode === "safe"
        ? "SAFE · CONFIRM EDITS"
        : "AUTO · BUILD AGENT";

  const scrollTag =
    clampedScroll > 0 ? ` · ↑ Scrolled +${clampedScroll} lines (PgDn/End)` : "";
  const noticeTag = state.notice ? ` · ⚡ ${state.notice}` : "";
  const compHeader = `─ ◆ ${modeLabel}${scrollTag}${noticeTag} `;
  const compTopDash = Math.max(2, cols - 2 - compHeader.length);
  const compTop = fitLineToWidth(
    borderColor(`╭${compHeader}${"─".repeat(compTopDash)}╮`),
    cols,
  );

  const glyph =
    state.mode === "plan"
      ? c.violet("❯ ")
      : state.mode === "safe"
        ? c.amber("❯ ")
        : c.cyan("❯ ");

  const innerCompW = Math.max(10, cols - 4);
  let inputContent: string;
  if (!state.buffer) {
    inputContent = `${glyph}${c.white("▏")}${c.dim("Ask anything, @file to attach, / for commands, !cmd for shell…")}`;
  } else {
    const before = state.buffer.slice(0, state.cursorPos);
    const after = state.buffer.slice(state.cursorPos);
    const rawStr = `${before}▏${after}`;
    const maxInputChars = innerCompW - 3;
    const clipped =
      rawStr.length > maxInputChars
        ? "…" + rawStr.slice(rawStr.length - (maxInputChars - 1))
        : rawStr;
    inputContent = `${glyph}${c.white(clipped)}`;
  }

  const compMid = `${borderColor("│")} ${fitLineToWidth(inputContent, innerCompW)} ${borderColor("│")}`;
  const compBot = borderColor(`╰${"─".repeat(Math.max(2, cols - 2))}╯`);

  const footerBar = fitLineToWidth(
    ` ${c.bold("Shift+Tab:")} Mode ${c.slate("│")} ${c.bold("Ctrl+K:")} Model ${c.slate("│")} ${c.bold("Ctrl+G:")} Subagents ${c.slate("│")} ${c.bold("Ctrl+O:")} Config ${c.slate("│")} ${c.bold("Ctrl+A:")} Team(${c.amber(state.team ?? "fullstack")}) ${c.slate("│")} ${c.bold("Ctrl+P:")} Palette ${c.slate("│")} ${c.bold("/:")} Cmds`,
    cols,
  );

  const allRows = [row0, row1, ...bodyLines, compTop, compMid, compBot, footerBar];
  return allRows.slice(0, rows).join("\n");
}
