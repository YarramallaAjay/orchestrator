/**
 * Public SDK exports.
 *
 * Users import from '@platform/sdk' (or the package name).
 */

export { Agent } from './agent-builder.js';
export { Workflow } from './workflow-builder.js';
export { Events } from './types.js';
export type {
  AgentBuilder,
  AgentContext,
  MemoryConfig,
  PreferencesConfig,
  TriggerConfig,
  EventHandler,
  AgentEventType,
} from './types.js';

// Re-export core types users may need
export { Scope, AgentSource } from '../../platform/types.js';
export type {
  AgentDefinition,
  AgentStep,
  ExecutionResult,
  ExecutionMetrics,
} from '../../platform/types.js';

// Re-export adapter types for adapter authors
export type {
  RuntimeAdapter,
  RuntimeState,
  AdapterConfig,
  ExecutionInput,
  RuntimeEvent,
  RuntimeResult,
  RuntimeMetrics,
} from '../../layer1-adapters/types.js';
