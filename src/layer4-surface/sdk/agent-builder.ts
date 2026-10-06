/**
 * Fluent agent builder.
 *
 * Usage:
 *   const agent = Agent.create('my-agent')
 *     .runtime('claude-code')
 *     .capability('file-edit', 'shell')
 *     .memory({ scope: 'workflow', access: 'read-write' })
 *     .build();
 */

import { nanoid } from 'nanoid';
import { Scope, AgentSource, type AgentDefinition, type AgentStep } from '../../platform/types.js';
import type {
  AgentBuilder,
  MemoryConfig,
  PreferencesConfig,
  TriggerConfig,
  EventHandler,
  AgentEventType,
} from './types.js';

class AgentBuilderImpl implements AgentBuilder {
  private _name: string;
  private _description?: string;
  private _runtime?: string;
  private _capabilities: string[] = [];
  private _memory: AgentDefinition['memory'] = {
    scope: Scope.AGENT,
    access: 'read-write',
  };
  private _preferences: AgentDefinition['preferences'] = {
    maxRetries: 2,
    timeoutMs: 300_000,
  };
  private _instructions?: string;
  private _steps?: AgentStep[];
  private _triggers?: AgentDefinition['triggers'];
  private _adapterConfig?: Record<string, unknown>;
  private _eventHandlers = new Map<string, EventHandler[]>();

  constructor(name: string) {
    this._name = name;
  }

  runtime(type: string): AgentBuilder {
    this._runtime = type;
    return this;
  }

  capability(...caps: string[]): AgentBuilder {
    this._capabilities.push(...caps);
    return this;
  }

  memory(config: MemoryConfig): AgentBuilder {
    const scopeMap: Record<string, Scope> = {
      global: Scope.GLOBAL,
      project: Scope.PROJECT,
      workflow: Scope.WORKFLOW,
      agent: Scope.AGENT,
    };
    this._memory = {
      scope: typeof config.scope === 'string' ? (scopeMap[config.scope] ?? Scope.AGENT) : config.scope,
      access: config.access,
      subscribe: config.subscribe,
    };
    return this;
  }

  preferences(config: PreferencesConfig): AgentBuilder {
    this._preferences = {
      fallbackRuntime: config.fallbackRuntime ?? this._preferences.fallbackRuntime,
      maxRetries: config.maxRetries ?? this._preferences.maxRetries,
      timeoutMs: config.timeoutMs ?? this._preferences.timeoutMs,
    };
    return this;
  }

  description(desc: string): AgentBuilder {
    this._description = desc;
    return this;
  }

  instructions(prompt: string): AgentBuilder {
    this._instructions = prompt;
    return this;
  }

  trigger(config: TriggerConfig): AgentBuilder {
    this._triggers = config;
    return this;
  }

  on(event: AgentEventType | string, handler: EventHandler): AgentBuilder {
    if (!this._eventHandlers.has(event)) {
      this._eventHandlers.set(event, []);
    }
    this._eventHandlers.get(event)!.push(handler);
    return this;
  }

  adapterConfig(config: Record<string, unknown>): AgentBuilder {
    this._adapterConfig = { ...this._adapterConfig, ...config };
    return this;
  }

  build(): AgentDefinition {
    const definition: AgentDefinition = {
      id: `agent_${nanoid(8)}`,
      name: this._name,
      description: this._description,
      source: AgentSource.CODE,
      runtime: this._runtime,
      capabilities: this._capabilities,
      memory: this._memory,
      preferences: this._preferences,
      instructions: this._instructions,
      steps: this._steps,
      triggers: this._triggers,
      adapterConfig: {
        ...this._adapterConfig,
        // Attach event handlers to adapter config so the execution engine can wire them
        _eventHandlers: Object.fromEntries(this._eventHandlers),
      },
    };

    return definition;
  }
}

/**
 * Entry point for the fluent agent builder.
 */
export const Agent = {
  create(name: string): AgentBuilder {
    return new AgentBuilderImpl(name);
  },
};
