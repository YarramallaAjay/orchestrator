/**
 * Core platform types shared across all layers.
 */

// ─── Identifiers ────────────────────────────────────────────────────────────

export type AgentId = string;
export type WorkflowId = string;
export type ProjectId = string;
export type ExecutionId = string;

// ─── Scoping ────────────────────────────────────────────────────────────────

/**
 * Memory and context scope levels, from broadest to narrowest.
 */
export enum Scope {
  /** Persists across all projects (org-level conventions). */
  GLOBAL = 'global',
  /** Persists for the lifetime of a project. */
  PROJECT = 'project',
  /** Shared between agents in one workflow execution. Ephemeral. */
  WORKFLOW = 'workflow',
  /** Private to a single agent instance. Ephemeral. */
  AGENT = 'agent',
}

// ─── Agent Definition ───────────────────────────────────────────────────────

/**
 * Source type of an agent definition.
 */
export enum AgentSource {
  /** Defined programmatically via the SDK. */
  CODE = 'code',
  /** Defined as a .md file with frontmatter + instructions. */
  DESCRIPTIVE = 'descriptive',
  /** Defined via agent.yaml config file. */
  YAML = 'yaml',
  /** An externally-hosted agent triggered and coordinated by the platform. */
  EXTERNAL = 'external',
}

/**
 * Unified agent definition -- the platform-internal representation
 * regardless of how the agent was defined (code, .md, .yaml, external).
 */
export interface AgentDefinition {
  id: AgentId;
  name: string;
  description?: string;
  source: AgentSource;

  /** Which runtime adapter to use. If omitted, resolved via preferences. */
  runtime?: string;
  /** Capabilities this agent needs (used for runtime matching). */
  capabilities: string[];

  /** Memory configuration. */
  memory: {
    scope: Scope;
    access: 'read-only' | 'read-write';
    subscribe?: string[];
  };

  /** Execution preferences. */
  preferences: {
    fallbackRuntime?: string;
    maxRetries: number;
    timeoutMs: number;
  };

  /** The prompt / instructions to send to the runtime. */
  instructions?: string;

  /** Structured steps (from .md ## Steps or agent.yaml). */
  steps?: AgentStep[];

  /** Event triggers. */
  triggers?: {
    onEvent?: string;
    onSchedule?: string;
  };

  /** Raw config for passthrough to the runtime adapter. */
  adapterConfig?: Record<string, unknown>;
}

export interface AgentStep {
  name: string;
  description: string;
  runtime?: string;
  dependsOn?: string[];
}

// ─── Execution ──────────────────────────────────────────────────────────────

export enum ExecutionStatus {
  PENDING = 'pending',
  RUNNING = 'running',
  COMPLETED = 'completed',
  FAILED = 'failed',
  CANCELLED = 'cancelled',
  RETRYING = 'retrying',
}

export interface ExecutionResult {
  status: ExecutionStatus;
  output?: string;
  artifacts?: Record<string, unknown>;
  error?: string;
  metrics?: ExecutionMetrics;
}

export interface ExecutionMetrics {
  durationMs: number;
  costUsd?: number;
  inputTokens?: number;
  outputTokens?: number;
  toolCalls?: number;
  turns?: number;
}

// ─── Middleware ──────────────────────────────────────────────────────────────

/**
 * Middleware context passed through the chain for each execution.
 */
export interface MiddlewareContext {
  executionId: ExecutionId;
  agent: AgentDefinition;
  input: string;
  workflowId?: WorkflowId;
  projectId?: ProjectId;
  metadata: Record<string, unknown>;
}

export type NextFn = () => Promise<ExecutionResult>;

export interface Middleware {
  name: string;
  execute(ctx: MiddlewareContext, next: NextFn): Promise<ExecutionResult>;
}

// ─── Plugin ─────────────────────────────────────────────────────────────────

export interface Plugin {
  name: string;
  version: string;

  /** Called once when the plugin is loaded. */
  initialize?(platform: PlatformContext): Promise<void>;

  /** Runtime adapters this plugin provides. */
  adapters?: RuntimeAdapterFactory[];

  /** Middleware this plugin provides. */
  middleware?: Middleware[];
}

/**
 * Minimal platform context exposed to plugins.
 */
export interface PlatformContext {
  projectId: string;
  config: Record<string, unknown>;
  getKV(scope: Scope): KVStoreHandle;
  getDocStore(scope: Scope): DocStoreHandle;
  getEventBus(): EventBusHandle;
}

// Forward-declared handles (implemented in their respective modules)
export interface KVStoreHandle {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
  list(prefix?: string): Promise<string[]>;
  subscribe(key: string, callback: (value: string | null) => void): () => void;
}

export interface DocStoreHandle {
  get(key: string): Promise<DocumentEntry | null>;
  set(entry: Omit<DocumentEntry, 'id' | 'createdAt' | 'updatedAt'>): Promise<DocumentEntry>;
  list(category?: string): Promise<DocumentEntry[]>;
  delete(key: string): Promise<void>;
}

export interface DocumentEntry {
  id: string;
  key: string;
  category: string;
  title: string;
  content: string;
  createdAt: string;
  updatedAt: string;
  updatedBy?: string;
}

export interface EventBusHandle {
  publish(event: PlatformEvent): Promise<void>;
  subscribe(pattern: string, handler: (event: PlatformEvent) => void): () => void;
}

export interface PlatformEvent {
  id: string;
  type: string;
  source: string;
  timestamp: string;
  payload: Record<string, unknown>;
}

// ─── Runtime Adapter Factory ────────────────────────────────────────────────

export interface RuntimeAdapterFactory {
  type: string;
  create(config: Record<string, unknown>): RuntimeAdapterInstance;
}

/** Alias for use in Plugin definitions -- same shape as RuntimeAdapter. */
export type RuntimeAdapterInstance = import('../layer1-adapters/types.js').RuntimeAdapter;
