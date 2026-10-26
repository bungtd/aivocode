import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ReasoningEffort } from "./config.js";

export type TeamId =
  | "fullstack"
  | "backend"
  | "frontend"
  | "android"
  | "blender3d"
  | "gamedev"
  | "autopilot";

export interface TeamRole {
  id: string;
  name: string;
  badge: string;
  description: string;
  readOnly: boolean;
  preferredTier: "flagship" | "coding" | "fast";
  preferredEffort: ReasoningEffort;
  instructions: string;
}

export interface WorkflowStage {
  id: string;
  title: string;
  roleId: string;
  objective: string;
  deliverable: string;
}

export interface AgentTeam {
  id: TeamId;
  name: string;
  shortLabel: string;
  description: string;
  systemPromptAddendum: string;
  roles: TeamRole[];
  workflowStages: WorkflowStage[];
}

export const AGENT_TEAMS: AgentTeam[] = [
  {
    id: "fullstack",
    name: "Full-Stack Engineering Team",
    shortLabel: "Full-Stack",
    description:
      "End-to-end web & cloud product team: System Architect + Backend API/DB Engineer + Frontend UI/UX Builder + QA & Anti-Slop Reviewer.",
    systemPromptAddendum: [
      "## Active Team: Full-Stack Engineering Workflow",
      "- Coordinate Database schema, Backend API contracts, and Frontend UI state cohesively.",
      "- Enforce strict type safety end-to-end (shared types/schemas, zero `any`, validated inputs).",
      "- Write unit/integration tests for backend routes and verify frontend components compile cleanly.",
      "- Reject generic AI-slop UI: use intentional spacing, clear visual hierarchy, and real data states (loading, empty, error, success).",
    ].join("\n"),
    roles: [
      {
        id: "fullstack-architect",
        name: "Full-Stack System Architect",
        badge: "ARCH",
        description: "Maps codebase, data models, API contracts, and file-by-file blueprint.",
        readOnly: true,
        preferredTier: "flagship",
        preferredEffort: "high",
        instructions:
          "Explore existing files first. Produce a concise file-by-file blueprint covering DB schema, API routes, types, and UI components.",
      },
      {
        id: "backend-engineer",
        name: "Backend & Database Engineer",
        badge: "BACK",
        description: "Implements database schemas, migrations, server endpoints, auth, and validation.",
        readOnly: false,
        preferredTier: "coding",
        preferredEffort: "medium",
        instructions:
          "Implement the backend models, migrations, services, and API endpoints following the architect's contract. Validate all inputs.",
      },
      {
        id: "frontend-engineer",
        name: "Frontend & UX Engineer",
        badge: "FRONT",
        description: "Builds responsive UI components, client state, routing, and API integration.",
        readOnly: false,
        preferredTier: "coding",
        preferredEffort: "medium",
        instructions:
          "Build clean, accessible, responsive UI components wired to the backend API. Handle loading, empty, and error states.",
      },
      {
        id: "qa-reviewer",
        name: "Full-Stack QA & Anti-Slop Reviewer",
        badge: "QA",
        description: "Runs tests, typechecks, and audits modified files for bugs or AI slop.",
        readOnly: false,
        preferredTier: "flagship",
        preferredEffort: "high",
        instructions:
          "Run tests and typechecks via run_shell, audit changed files for incomplete stubs or regressions, and fix any issues found.",
      },
    ],
    workflowStages: [
      {
        id: "arch",
        title: "1. Discovery & System Architecture",
        roleId: "fullstack-architect",
        objective: "Inspect existing repository structure and define DB, API, and UI contracts.",
        deliverable: "Concrete file-by-file implementation spec and interface contracts.",
      },
      {
        id: "backend",
        title: "2. Database & Backend Implementation",
        roleId: "backend-engineer",
        objective: "Implement schemas, business logic, and API endpoints.",
        deliverable: "Working, type-safe backend files.",
      },
      {
        id: "frontend",
        title: "3. Frontend UI & Integration",
        roleId: "frontend-engineer",
        objective: "Implement UI components and wire them to the backend.",
        deliverable: "Working, responsive frontend components.",
      },
      {
        id: "qa",
        title: "4. Verification, Tests & Anti-Slop Review",
        roleId: "qa-reviewer",
        objective: "Run test suite, typecheck, and verify zero placeholders or regressions.",
        deliverable: "All tests and typechecks passing with clean code.",
      },
    ],
  },
  {
    id: "backend",
    name: "Backend, API & Distributed Systems Team",
    shortLabel: "Backend",
    description:
      "High-reliability backend team: Distributed Architect + API/DB Implementer + Security, Egress & Performance Auditor.",
    systemPromptAddendum: [
      "## Active Team: Backend & Distributed Systems Workflow",
      "- Prioritize idempotency, transactional safety, constant-time secret comparison, and minimal DB egress (avoid `SELECT *` on hot paths).",
      "- Design clear error envelopes with stable machine-readable error codes and HTTP statuses.",
      "- Always verify with unit/integration tests and strict TypeScript/compiler checks.",
    ].join("\n"),
    roles: [
      {
        id: "system-architect",
        name: "Distributed Systems Architect",
        badge: "ARCH",
        description: "Designs API contracts, database indexes, caching, and concurrency invariants.",
        readOnly: true,
        preferredTier: "flagship",
        preferredEffort: "high",
        instructions:
          "Analyze existing routes, schemas, and concurrency patterns. Define exact function signatures, SQL queries, and error codes.",
      },
      {
        id: "api-implementer",
        name: "API & Database Implementer",
        badge: "IMPL",
        description: "Writes endpoints, database queries, queues, and unit tests.",
        readOnly: false,
        preferredTier: "coding",
        preferredEffort: "medium",
        instructions:
          "Implement the backend changes cleanly with TDD: write/update tests and production handlers with zero placeholders.",
      },
      {
        id: "security-perf-auditor",
        name: "Security & Performance Auditor",
        badge: "SEC",
        description: "Audits auth guards, injection risks, N+1 queries, and runs test suite.",
        readOnly: false,
        preferredTier: "flagship",
        preferredEffort: "high",
        instructions:
          "Audit all changed backend files for auth bypass, race conditions, N+1 queries, and run the test suite to confirm 100% green.",
      },
    ],
    workflowStages: [
      {
        id: "design",
        title: "1. Schema, API Contract & Invariant Design",
        roleId: "system-architect",
        objective: "Map blast radius, data model, and exact API/error contracts.",
        deliverable: "Technical specification and test plan.",
      },
      {
        id: "implement",
        title: "2. Core API & Database Implementation",
        roleId: "api-implementer",
        objective: "Write tests and implement endpoints, queries, and helpers.",
        deliverable: "Implemented backend modules and tests.",
      },
      {
        id: "audit",
        title: "3. Security, Performance & Test Verification",
        roleId: "security-perf-auditor",
        objective: "Verify tests pass and audit for security/egress/concurrency flaws.",
        deliverable: "Verified, hardened backend changes.",
      },
    ],
  },
  {
    id: "frontend",
    name: "Frontend, Design System & Web UX Team",
    shortLabel: "Frontend",
    description:
      "Craft-focused frontend team: UX Design Director + UI Component Builder + Accessibility, Performance & Visual QA.",
    systemPromptAddendum: [
      "## Active Team: Frontend & Web UX Workflow",
      "- Anti-AI-Slop Design Rule: avoid generic purple-on-dark gradients, cookie-cutter 3-card grids, and unstyled browser defaults.",
      "- Craft intentional typography, crisp spacing tokens, micro-interactions, keyboard navigation (`Tab`, `Esc`, `Enter`), and ARIA attributes.",
      "- Ensure responsive behavior across mobile, tablet, and desktop viewports.",
    ].join("\n"),
    roles: [
      {
        id: "ux-design-director",
        name: "UX & Design System Director",
        badge: "UX",
        description: "Defines visual hierarchy, color/typography tokens, states, and component tree.",
        readOnly: true,
        preferredTier: "flagship",
        preferredEffort: "medium",
        instructions:
          "Inspect existing styles/components and design a cohesive component structure, visual tokens, and interaction states.",
      },
      {
        id: "ui-component-builder",
        name: "Frontend Component Engineer",
        badge: "UI",
        description: "Implements components, hooks, state management, and animations.",
        readOnly: false,
        preferredTier: "coding",
        preferredEffort: "medium",
        instructions:
          "Implement the components, styles, and state logic with full TypeScript types and zero placeholder stubs.",
      },
      {
        id: "a11y-perf-reviewer",
        name: "Accessibility & Web Perf Reviewer",
        badge: "A11Y",
        description: "Checks ARIA, keyboard navigation, responsive layout, and build/test pass.",
        readOnly: false,
        preferredTier: "flagship",
        preferredEffort: "medium",
        instructions:
          "Verify build/typecheck passes, check keyboard & screen-reader accessibility, and polish any visual/UX rough edges.",
      },
    ],
    workflowStages: [
      {
        id: "ux-spec",
        title: "1. UX Flow & Design System Spec",
        roleId: "ux-design-director",
        objective: "Define component hierarchy, design tokens, and interactive states.",
        deliverable: "UX & component specification.",
      },
      {
        id: "ui-build",
        title: "2. Component & State Implementation",
        roleId: "ui-component-builder",
        objective: "Build components, hooks, and styling.",
        deliverable: "Production-ready UI components.",
      },
      {
        id: "a11y-qa",
        title: "3. Accessibility, Build & Anti-Slop Polish",
        roleId: "a11y-perf-reviewer",
        objective: "Run typecheck/tests and verify accessibility & responsive polish.",
        deliverable: "Verified frontend build.",
      },
    ],
  },
  {
    id: "android",
    name: "Android & Mobile Engineering Team",
    shortLabel: "Android",
    description:
      "Modern Android team: Clean Architecture Lead + Kotlin & Jetpack Compose Developer + Gradle, Lint & Lifecycle QA.",
    systemPromptAddendum: [
      "## Active Team: Android & Mobile Engineering Workflow (Kotlin / Jetpack Compose)",
      "- Follow modern Android architecture: unidirectional data flow (UDF), Kotlin Coroutines + `StateFlow`, ViewModel with `SavedStateHandle`, and Material 3 Compose components.",
      "- Handle lifecycle awareness (`collectAsStateWithLifecycle`), configuration changes, offline-first persistence (Room/DataStore), and runtime permissions cleanly.",
      "- Keep `build.gradle.kts`, `AndroidManifest.xml`, and ProGuard/R8 rules consistent and well-structured.",
    ].join("\n"),
    roles: [
      {
        id: "android-architect",
        name: "Android Clean Architecture Lead",
        badge: "ARCH",
        description: "Designs Gradle modules, navigation graph, UDF state contracts, and Room/API layers.",
        readOnly: true,
        preferredTier: "flagship",
        preferredEffort: "high",
        instructions:
          "Inspect Gradle configuration, package structure, and AndroidManifest. Define UiState, UiEvent, ViewModel, Repository, and Navigation contracts.",
      },
      {
        id: "compose-kotlin-developer",
        name: "Kotlin & Jetpack Compose Developer",
        badge: "KT",
        description: "Implements Compose screens, ViewModels, Coroutines/Flows, Room DAOs, and Manifest entries.",
        readOnly: false,
        preferredTier: "coding",
        preferredEffort: "medium",
        instructions:
          "Write idiomatic Kotlin and Jetpack Compose code with previews, stateless composables, proper state hoisting, and coroutine error handling.",
      },
      {
        id: "mobile-qa-profiler",
        name: "Android Lifecycle & Build QA",
        badge: "QA",
        description: "Audits lifecycle leaks, main-thread safety, Gradle build/unit tests, and lint.",
        readOnly: false,
        preferredTier: "flagship",
        preferredEffort: "high",
        instructions:
          "Check for main-thread blocking calls, memory/context leaks, missing manifest permissions, and run Gradle test/check tasks if available.",
      },
    ],
    workflowStages: [
      {
        id: "mobile-arch",
        title: "1. Mobile Architecture & UDF State Design",
        roleId: "android-architect",
        objective: "Define screens, navigation, ViewModels, and data layer contracts.",
        deliverable: "Android architecture & file plan.",
      },
      {
        id: "kotlin-compose",
        title: "2. Kotlin & Jetpack Compose Implementation",
        roleId: "compose-kotlin-developer",
        objective: "Implement Data/Domain/UI layers, Compose screens, and Gradle/Manifest updates.",
        deliverable: "Complete Kotlin & Compose source files.",
      },
      {
        id: "android-qa",
        title: "3. Lifecycle, Main-Thread & Build Verification",
        roleId: "mobile-qa-profiler",
        objective: "Audit main-thread safety, lifecycle collection, and run unit tests/build.",
        deliverable: "Verified Android build and unit tests.",
      },
    ],
  },
  {
    id: "blender3d",
    name: "3D Blender & Procedural Asset Team",
    shortLabel: "Blender 3D",
    description:
      "3D technical art team: Technical Art Director + Blender Python (`bpy`/`bmesh`) Engineer + Mesh/Material/Vision Validator.",
    systemPromptAddendum: [
      "## Active Team: 3D Blender & Procedural Pipeline Workflow (`bpy` / `bmesh`)",
      "- Write deterministic, idempotent Blender Python (`bpy`, `bmesh`, `mathutils`) scripts that can run both inside Blender and headlessly (`blender -b -P script.py`).",
      "- Enforce clean 3D engineering: real-world metric scale (1 unit = 1 meter), applied transforms (`scale = (1,1,1)`), named collections/materials, Principled BSDF PBR shader nodes, and three-point or HDRI lighting.",
      "- When Blender CLI is available, render a preview image and inspect it with `vision_analyze` to verify framing, silhouettes, and materials.",
    ].join("\n"),
    roles: [
      {
        id: "technical-art-director",
        name: "3D Technical Art Director",
        badge: "3D-ART",
        description: "Specifies scene hierarchy, proportions, topology budget, PBR materials, and camera/lighting.",
        readOnly: true,
        preferredTier: "flagship",
        preferredEffort: "high",
        instructions:
          "Define exact dimensions, mesh parts, modifiers/bmesh operations, Principled BSDF material parameters, camera transform, and lighting.",
      },
      {
        id: "bpy-script-engineer",
        name: "Blender Python (bpy/bmesh) Engineer",
        badge: "BPY",
        description: "Writes procedural `bpy`/`bmesh` scripts, Geometry Nodes, armatures, and GLTF/FBX exporters.",
        readOnly: false,
        preferredTier: "coding",
        preferredEffort: "high",
        instructions:
          "Write clean, modular Blender 3.x/4.x compatible Python (`bpy`, `bmesh`, `mathutils`) scripts without context-override deprecation errors.",
      },
      {
        id: "asset-vision-validator",
        name: "3D Mesh & Vision QA Validator",
        badge: "3D-QA",
        description: "Validates script syntax, non-manifold geometry, export paths, and visual render output.",
        readOnly: false,
        preferredTier: "flagship",
        preferredEffort: "medium",
        instructions:
          "Validate Python syntax, check `bpy` API compatibility, run headless Blender render/export if installed, and inspect output.",
      },
    ],
    workflowStages: [
      {
        id: "art-spec",
        title: "1. 3D Scene, Proportions & Material Spec",
        roleId: "technical-art-director",
        objective: "Design hierarchy, coordinates, mesh primitives/bmesh steps, and PBR shaders.",
        deliverable: "Technical 3D asset & scene specification.",
      },
      {
        id: "bpy-code",
        title: "2. Blender Python (bpy/bmesh) Implementation",
        roleId: "bpy-script-engineer",
        objective: "Generate procedural `bpy`/`bmesh` script with materials, lighting, and export.",
        deliverable: "Executable Blender Python script(s).",
      },
      {
        id: "mesh-qa",
        title: "3. Topology, Syntax & Render/Vision QA",
        roleId: "asset-vision-validator",
        objective: "Verify Python syntax, API correctness, and headless execution/render.",
        deliverable: "Validated 3D script and asset pipeline.",
      },
    ],
  },
  {
    id: "gamedev",
    name: "Game Development Team (Godot / Unity / Unreal / WebGL)",
    shortLabel: "GameDev",
    description:
      "Interactive game studio team: Systems Designer + Gameplay & Shader Programmer + Frame-Budget & Feel QA.",
    systemPromptAddendum: [
      "## Active Team: Game Development Workflow (Godot / Unity / Unreal / Three.js / WebGL)",
      "- Design decoupled game systems: state machines, event buses, component/node composition, and frame-rate independent physics (`delta` / `Time.deltaTime`).",
      "- Prioritize game feel ('juice'): responsive input buffering, coyote time, camera shake/smoothing, shader feedback, and object pooling to avoid GC spikes during gameplay.",
    ].join("\n"),
    roles: [
      {
        id: "game-systems-designer",
        name: "Lead Game Systems Designer",
        badge: "DESIGN",
        description: "Architects core loop, scene tree / ECS layout, collision layers, and state machines.",
        readOnly: true,
        preferredTier: "flagship",
        preferredEffort: "high",
        instructions:
          "Inspect the game project engine (Godot, Unity, Three.js, Phaser, etc.) and design the node/entity hierarchy, state machines, and physics parameters.",
      },
      {
        id: "gameplay-shader-programmer",
        name: "Gameplay & Shader Programmer",
        badge: "GAME",
        description: "Implements player controllers, AI, physics, shaders, UI HUD, and game loop.",
        readOnly: false,
        preferredTier: "coding",
        preferredEffort: "medium",
        instructions:
          "Implement responsive, delta-time-safe gameplay scripts, shaders, and scene/prefab files with zero allocation in hot update loops.",
      },
      {
        id: "game-balance-qa",
        name: "Frame-Budget & Playability QA",
        badge: "QA",
        description: "Audits update-loop allocations, collision edge cases, and build/test execution.",
        readOnly: false,
        preferredTier: "flagship",
        preferredEffort: "high",
        instructions:
          "Check for per-frame memory allocations, physics tunneling, null references, and verify the game builds/tests cleanly.",
      },
    ],
    workflowStages: [
      {
        id: "systems-design",
        title: "1. Core Loop, ECS/Scene Tree & Physics Spec",
        roleId: "game-systems-designer",
        objective: "Map entities/nodes, input actions, state machines, and tuning constants.",
        deliverable: "Game systems architecture spec.",
      },
      {
        id: "gameplay-code",
        title: "2. Gameplay, Controls & Shader Implementation",
        roleId: "gameplay-shader-programmer",
        objective: "Write gameplay scripts, shaders, and scene configurations.",
        deliverable: "Playable, well-tuned game code.",
      },
      {
        id: "frame-qa",
        title: "3. Frame-Budget, Physics & Build QA",
        roleId: "game-balance-qa",
        objective: "Audit hot-loop performance, edge cases, and verify build/tests.",
        deliverable: "Verified game implementation.",
      },
    ],
  },
  {
    id: "autopilot",
    name: "Guided Beginner Autopilot Team (No-IT-Background Friendly)",
    shortLabel: "Autopilot",
    description:
      "Turnkey assistant for non-technical users: translates everyday ideas into working software automatically and explains in plain language.",
    systemPromptAddendum: [
      "## Active Team: Beginner-Friendly Turnkey Autopilot",
      "- The user may not have an IT or programming background. Never overwhelm them with raw jargon.",
      "- Make sensible, modern technical choices automatically on their behalf, build the complete working solution end-to-end, install dependencies, and verify it runs.",
      "- Always conclude with a friendly, plain-language summary and 1-2 simple steps showing how to open or use what you built.",
    ].join("\n"),
    roles: [
      {
        id: "product-concierge",
        name: "Product Concierge",
        badge: "GUIDE",
        description: "Translates plain-language goals into a clear, practical product plan.",
        readOnly: true,
        preferredTier: "fast",
        preferredEffort: "low",
        instructions:
          "Understand what the user wants to achieve in plain terms and outline a simple, complete plan.",
      },
      {
        id: "turnkey-builder",
        name: "Turnkey Application Builder",
        badge: "BUILD",
        description: "Builds the complete application, UI, and sample data automatically.",
        readOnly: false,
        preferredTier: "coding",
        preferredEffort: "medium",
        instructions:
          "Build the entire working feature or app with polished visuals, helpful defaults, and zero unfinished parts.",
      },
      {
        id: "launch-verifier",
        name: "Launch Verifier & Guide",
        badge: "LAUNCH",
        description: "Tests that everything works and writes a jargon-free guide for the user.",
        readOnly: false,
        preferredTier: "fast",
        preferredEffort: "low",
        instructions:
          "Verify the application works and write a clear, friendly explanation in the user's language.",
      },
    ],
    workflowStages: [
      {
        id: "concierge",
        title: "1. Understand Goal & Product Blueprint",
        roleId: "product-concierge",
        objective: "Translate user request into a complete product plan.",
        deliverable: "Simple product blueprint.",
      },
      {
        id: "turnkey",
        title: "2. Automated End-to-End Build",
        roleId: "turnkey-builder",
        objective: "Create all files, UI, and logic automatically.",
        deliverable: "Working application.",
      },
      {
        id: "launch",
        title: "3. Verify & Plain-Language Guide",
        roleId: "launch-verifier",
        objective: "Verify everything runs and explain how to use it simply.",
        deliverable: "Verified app + simple user guide.",
      },
    ],
  },
];

export function getAgentTeam(id: string): AgentTeam | undefined {
  const clean = id.trim().toLowerCase();
  return AGENT_TEAMS.find((t) => t.id === clean);
}

/**
 * Automatically recommends the most suitable specialist team from a prompt and optional workspace path.
 */
export function detectRecommendedTeam(prompt: string, cwd?: string): TeamId {
  const p = prompt.toLowerCase();

  // Check for beginner / non-IT phrasing first
  if (
    /\b(tidak\s+(paham|mengerti|tahu)\s+(coding|it|program)|awam|no\s+coding|non-technical|buatkan\s+aplikasi\s+.*siap\s+pakai)\b/i.test(
      p,
    )
  ) {
    return "autopilot";
  }

  // Blender 3D
  if (/\b(blender|bpy|bmesh|\.blend|3d\s+model|rigging|armature|geometry\s+nodes|shader\s+nodes|gltf|fbx)\b/i.test(p)) {
    return "blender3d";
  }

  // Android
  if (
    /\b(android|jetpack\s+compose|kotlin\s+android|apk|gradle|room\s+database|androidmanifest|viewmodel)\b/i.test(
      p,
    ) ||
    (cwd && existsSync(join(cwd, "app", "src", "main", "AndroidManifest.xml")))
  ) {
    return "android";
  }

  // GameDev
  if (
    /\b(godot|gdscript|unity|unreal|three\.js|phaser|game\s+loop|platformer|rpg|npc|rigidbody|tilemap|shader|fps)\b/i.test(
      p,
    ) ||
    (cwd && existsSync(join(cwd, "project.godot")))
  ) {
    return "gamedev";
  }

  const hasBackendSignal =
    /\b(postgres|sql|drizzle|prisma|database|migration|endpoint|rest\s+api|graphql|webhook|worker|cron|queue|auth|jwt|rate\s+limit)\b/i.test(
      p,
    );
  const hasFrontendSignal =
    /\b(react|vue|svelte|tailwind|css|navbar|modal|landing\s+page|animasi|animation|responsive|ui|ux|component|halaman|tombol)\b/i.test(
      p,
    );

  if (hasBackendSignal && hasFrontendSignal) {
    return "fullstack";
  }
  if (hasBackendSignal) {
    return "backend";
  }
  if (hasFrontendSignal) {
    return "frontend";
  }

  return "fullstack";
}

export interface CustomAgentDefinition {
  id: string;
  description: string;
  mode: "primary" | "subagent" | "all";
  model?: string;
  effort?: ReasoningEffort;
  readOnly?: boolean;
  systemPrompt: string;
}

/**
 * Discovers custom Markdown agent definitions from `.aivokey/agents/*.md` and `.opencode/agents/*.md`.
 */
export function loadCustomAgents(cwd: string): CustomAgentDefinition[] {
  const dirs = [join(cwd, ".aivokey", "agents"), join(cwd, ".opencode", "agents")];
  const results: CustomAgentDefinition[] = [];

  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    let files;
    try {
      files = readdirSync(dir).filter((f) => f.endsWith(".md"));
    } catch {
      continue;
    }
    for (const file of files) {
      try {
        const raw = readFileSync(join(dir, file), "utf8");
        const id = file.replace(/\.md$/i, "");
        const fm = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
        let description = `Custom agent ${id}`;
        let mode: "primary" | "subagent" | "all" = "subagent";
        let model: string | undefined;
        let readOnly = false;
        const body = fm ? (fm[2] ?? "").trim() : raw.trim();

        if (fm?.[1]) {
          for (const line of fm[1].split(/\r?\n/)) {
            const mDesc = line.match(/^description:\s*(.+)$/i);
            if (mDesc?.[1]) description = mDesc[1].trim();
            const mMode = line.match(/^mode:\s*(primary|subagent|all)$/i);
            if (mMode?.[1]) mode = mMode[1].toLowerCase() as "primary" | "subagent" | "all";
            const mModel = line.match(/^model:\s*(.+)$/i);
            if (mModel?.[1]) model = mModel[1].trim();
            if (/action:\s*edit[\s\S]*effect:\s*deny/i.test(fm[1])) {
              readOnly = true;
            }
          }
        }
        results.push({ id, description, mode, model, readOnly, systemPrompt: body });
      } catch {
        /* ignore */
      }
    }
  }
  return results;
}

export interface StageExecutionRecord {
  stageId: string;
  stageTitle: string;
  roleId: string;
  roleName: string;
  output: string;
}

export interface RunTeamWorkflowOptions {
  team: AgentTeam;
  goal: string;
  onStageStart?: (stage: WorkflowStage, role: TeamRole, index: number, total: number) => void;
  onStageComplete?: (record: StageExecutionRecord, index: number, total: number) => void;
  executeStageAgent: (
    stage: WorkflowStage,
    role: TeamRole,
    stagePrompt: string,
  ) => Promise<string>;
}

export interface RunTeamWorkflowResult {
  teamId: TeamId;
  goal: string;
  stageOutputs: StageExecutionRecord[];
  finalSummary: string;
}

/**
 * Orchestrates a multi-stage specialist team workflow sequentially, passing structured
 * handoff artifacts from earlier roles (e.g. Architect) to downstream roles (Builder -> QA).
 */
export async function runTeamWorkflow(
  opts: RunTeamWorkflowOptions,
): Promise<RunTeamWorkflowResult> {
  const { team, goal } = opts;
  const stageOutputs: StageExecutionRecord[] = [];
  const total = team.workflowStages.length;

  for (let i = 0; i < total; i++) {
    const stage = team.workflowStages[i]!;
    const role =
      team.roles.find((r) => r.id === stage.roleId) ?? team.roles[0]!;

    opts.onStageStart?.(stage, role, i, total);

    const priorHandoff =
      stageOutputs.length > 0
        ? [
            "## Handoff Reports from Earlier Team Stages",
            ...stageOutputs.map(
              (s) => `### ${s.stageTitle} (${s.roleName})\n${s.output.slice(0, 4000)}`,
            ),
          ].join("\n\n")
        : "";

    const stagePrompt = [
      `# Team Workflow: ${team.name}`,
      `**Your Role:** ${role.name} (${role.description})`,
      `**Stage (${i + 1}/${total}):** ${stage.title}`,
      `**Stage Objective:** ${stage.objective}`,
      `**Expected Deliverable:** ${stage.deliverable}`,
      `**Role Instructions:** ${role.instructions}`,
      "",
      `## Overall User Goal`,
      goal,
      ...(priorHandoff ? ["", priorHandoff] : []),
    ].join("\n");

    const output = await opts.executeStageAgent(stage, role, stagePrompt);
    const record: StageExecutionRecord = {
      stageId: stage.id,
      stageTitle: stage.title,
      roleId: role.id,
      roleName: role.name,
      output,
    };
    stageOutputs.push(record);
    opts.onStageComplete?.(record, i, total);
  }

  const finalSummary = [
    `## Team Workflow Completed: ${team.name}`,
    ...stageOutputs.map(
      (s) => `### ${s.stageTitle} — *${s.roleName}*\n${s.output}`,
    ),
  ].join("\n\n");

  return {
    teamId: team.id,
    goal,
    stageOutputs,
    finalSummary,
  };
}

export interface ParallelSubagentTask {
  id: string;
  agent: "explore" | "general";
  description: string;
  prompt: string;
}

export interface ParallelSubagentResult {
  id: string;
  description: string;
  output: string;
  isError?: boolean;
}

/**
 * Dispatches multiple independent subagents in parallel (`Promise.all`) to maximize speed.
 */
export async function runParallelSubagents(
  tasks: ParallelSubagentTask[],
  runner: (task: ParallelSubagentTask) => Promise<string>,
): Promise<ParallelSubagentResult[]> {
  return Promise.all(
    tasks.map(async (task) => {
      try {
        const output = await runner(task);
        return {
          id: task.id,
          description: task.description,
          output,
        };
      } catch (err) {
        return {
          id: task.id,
          description: task.description,
          output: `Subagent failed: ${err instanceof Error ? err.message : String(err)}`,
          isError: true,
        };
      }
    }),
  );
}
