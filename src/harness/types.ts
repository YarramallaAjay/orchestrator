import type { ChildProcess } from 'node:child_process';

/**
 * Configuration for launching a harness in wrap mode.
 */
export interface HarnessConfig {
  /** Working directory for the harness process */
  cwd: string;
  /** Orchestrator project ID */
  projectId: string;
  /** Additional environment variables to pass */
  env?: Record<string, string>;
  /** Model override */
  model?: string;
  /** Path to MCP config JSON to pass to the harness */
  mcpConfigPath?: string;
  /** Session ID to resume */
  resumeSession?: string;
  /** Additional CLI args to pass through */
  additionalArgs?: string[];
}

/**
 * Represents a running harness process.
 */
export interface HarnessProcess {
  /** Process ID of the spawned harness */
  pid: number;
  /** Reference to the child process */
  process: ChildProcess;
  /** Resolves when the process exits */
  exitPromise: Promise<HarnessSessionResult>;
}

/**
 * Result data from a completed harness session.
 */
export interface HarnessSessionResult {
  /** Exit code of the harness process */
  exitCode: number;
  /** Duration of the session in milliseconds */
  durationMs: number;
  /** Claude session ID if available */
  sessionId: string | null;
}

/**
 * Adapter interface for wrapping an AI coding harness.
 *
 * Unlike AgentRuntime (which is for programmatic execution with -p mode),
 * HarnessAdapter wraps an interactive CLI session where the user drives the TUI.
 */
export interface HarnessAdapter {
  /** Identifier for this harness type (e.g., 'claude-code') */
  readonly type: string;

  /** Check if this harness binary is available on the system */
  isAvailable(): Promise<boolean>;

  /** Start the harness as an interactive subprocess with stdio: 'inherit' */
  start(config: HarnessConfig): Promise<HarnessProcess>;

  /** Gracefully stop the running harness */
  stop(): Promise<void>;
}

/**
 * Options for the HarnessGateway launch method.
 */
export interface WrapOptions {
  /** Override model for the harness */
  model?: string;
  /** Disable MCP sidecar */
  disableMcp?: boolean;
  /** Disable hook injection */
  disableHooks?: boolean;
  /** Disable cross-session memory */
  disableMemory?: boolean;
  /** Resume a previous session */
  resumeSession?: string;
  /** Path to a workflow YAML file */
  workflowFile?: string;
  /** Maximum tokens for injected context (default: 8192) */
  tokenBudget?: number;
  /** Additional CLI args to pass through to the harness */
  additionalArgs?: string[];
}
