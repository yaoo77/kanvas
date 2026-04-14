/**
 * Standalone agent catalog for spawning coding-agent CLI processes.
 *
 * Extracted from cline-kanban's agent-catalog + agent-registry + session-adapters.
 * No external dependencies beyond Node.js built-ins.
 */

import { spawn, type ChildProcess } from "node:child_process";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type AgentId =
  | "claude"
  | "codex"
  | "cline"
  | "opencode"
  | "droid"
  | "kiro"
  | "gemini";

export interface AgentCatalogEntry {
  id: AgentId;
  label: string;
  /** CLI binary name (must be on PATH) */
  binary: string;
  /** Arguments always passed to the binary */
  baseArgs: string[];
  /** Extra arguments that enable fully-autonomous / no-approval mode */
  autonomousArgs: string[];
}

// ---------------------------------------------------------------------------
// Catalog
// ---------------------------------------------------------------------------

const AGENT_CATALOG: readonly AgentCatalogEntry[] = [
  {
    id: "claude",
    label: "Claude Code",
    binary: "claude",
    baseArgs: [],
    autonomousArgs: ["--dangerously-skip-permissions"],
  },
  {
    id: "codex",
    label: "OpenAI Codex",
    binary: "codex",
    baseArgs: [],
    autonomousArgs: ["--dangerously-bypass-approvals-and-sandbox"],
  },
  {
    id: "cline",
    label: "Cline",
    binary: "cline",
    baseArgs: [],
    autonomousArgs: ["--auto-approve-all"],
  },
  {
    id: "opencode",
    label: "OpenCode",
    binary: "opencode",
    baseArgs: [],
    autonomousArgs: [],
  },
  {
    id: "droid",
    label: "Factory Droid",
    binary: "droid",
    baseArgs: [],
    autonomousArgs: ["--auto", "high"],
  },
  {
    id: "kiro",
    label: "Kiro",
    binary: "kiro-cli",
    baseArgs: ["chat"],
    autonomousArgs: ["--trust-all-tools"],
  },
  {
    id: "gemini",
    label: "Gemini CLI",
    binary: "gemini",
    baseArgs: [],
    autonomousArgs: ["--yolo"],
  },
] as const;

// ---------------------------------------------------------------------------
// Lookup
// ---------------------------------------------------------------------------

/**
 * Get an agent's catalog entry by ID.
 * Returns `null` if the ID is unknown.
 */
export function getAgentConfig(id: AgentId): AgentCatalogEntry | null {
  return AGENT_CATALOG.find((entry) => entry.id === id) ?? null;
}

/**
 * Return the full catalog (read-only).
 */
export function getAllAgents(): readonly AgentCatalogEntry[] {
  return AGENT_CATALOG;
}

// ---------------------------------------------------------------------------
// Spawn
// ---------------------------------------------------------------------------

export interface SpawnAgentOptions {
  /** Agent configuration (obtain via `getAgentConfig`) */
  config: AgentCatalogEntry;
  /** Working directory (typically a git worktree) */
  cwd: string;
  /** The prompt / instruction to send to the agent */
  prompt: string;
  /** Enable the agent's autonomous / no-approval mode */
  autonomous?: boolean;
  /** Extra environment variables merged on top of `process.env` */
  env?: Record<string, string>;
}

/**
 * Spawn an agent CLI process and return the `ChildProcess`.
 *
 * The prompt is passed via the `-p` flag, which is the standard convention
 * for claude, codex, cline, gemini, droid, and kiro CLIs.
 *
 * The caller is responsible for attaching listeners to `stdout`, `stderr`,
 * and the `exit` event.
 */
export function spawnAgent(options: SpawnAgentOptions): ChildProcess {
  const { config, cwd, prompt, autonomous = false, env } = options;

  const args: string[] = [
    ...config.baseArgs,
    ...(autonomous ? config.autonomousArgs : []),
    "-p",
    prompt,
  ];

  const child = spawn(config.binary, args, {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, ...env },
  });

  return child;
}
