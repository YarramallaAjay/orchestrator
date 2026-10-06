/**
 * Platform instance -- the top-level object that wires all layers together.
 *
 * Users and CLI commands interact with this.
 */

import { nanoid } from 'nanoid';
import type { PlatformConfig } from './config/schema.js';
import type { AgentDefinition, ExecutionResult, Scope, Plugin } from './types.js';
import { AgentSource } from './types.js';
import { AdapterRegistry, createDefaultRegistry } from '../layer1-adapters/adapter-registry.js';
import { InMemoryKVStore } from '../layer2-core/memory/kv-store.js';
import { PlatformEventBus, createEvent } from '../layer2-core/events/event-bus.js';
import { EventTypes } from '../layer2-core/events/types.js';
import type { EventBus } from '../layer2-core/events/types.js';
import { ExecutionEngine } from '../layer3-engine/execution/engine.js';
import type { ExecutionRequest } from '../layer3-engine/execution/types.js';
import { DefaultMemoryManager } from '../layer2-core/memory/memory-manager.js';
import { WorkflowOrchestrator, type WorkflowDefinition, type WorkflowResult } from '../layer3-engine/composition/workflow-orchestrator.js';
import { PipelineRunner, type PipelineConfig, type PipelineResult } from '../layer3-engine/composition/pipeline-runner.js';
import { MiddlewareChain, RetryMiddleware, LoggingMiddleware, TimeoutMiddleware } from '../layer3-engine/middleware/chain.js';
import { RuntimeResolver, type RuntimePreference } from '../layer3-engine/runtime-resolver.js';

export class Platform {
  readonly config: PlatformConfig;
  readonly adapters: AdapterRegistry;
  readonly eventBus: EventBus;
  readonly kv: InMemoryKVStore;
  readonly engine: ExecutionEngine;
  readonly memoryManager: DefaultMemoryManager;
  readonly runtimeResolver: RuntimeResolver;
  readonly middlewareChain: MiddlewareChain;
  readonly workflowOrchestrator: WorkflowOrchestrator;
  readonly pipelineRunner: PipelineRunner;

  private plugins: Plugin[] = [];

  private constructor(
    config: PlatformConfig,
    adapters: AdapterRegistry,
    eventBus: EventBus,
    kv: InMemoryKVStore,
    engine: ExecutionEngine,
    memoryManager: DefaultMemoryManager,
    runtimeResolver: RuntimeResolver,
    middlewareChain: MiddlewareChain,
  ) {
    this.config = config;
    this.adapters = adapters;
    this.eventBus = eventBus;
    this.kv = kv;
    this.engine = engine;
    this.memoryManager = memoryManager;
    this.runtimeResolver = runtimeResolver;
    this.middlewareChain = middlewareChain;
    this.workflowOrchestrator = new WorkflowOrchestrator(engine, eventBus, memoryManager, middlewareChain);
    this.pipelineRunner = new PipelineRunner(engine, eventBus);
  }

  /**
   * Create and initialize a Platform instance from config.
   */
  static async create(config: PlatformConfig): Promise<Platform> {
    const adapters = createDefaultRegistry();
    const eventBus = new PlatformEventBus();
    const kv = new InMemoryKVStore();
    const memoryManager = new DefaultMemoryManager(kv);
    const engine = new ExecutionEngine(adapters, eventBus);

    // Build runtime preferences from config
    const preferences: RuntimePreference[] = config.runtimes.map((rt) => ({
      name: rt.name,
      type: rt.type,
      priority: rt.priority,
      capabilities: rt.capabilities ?? [],
    }));
    const runtimeResolver = new RuntimeResolver(adapters, preferences);

    // Build middleware chain
    const middlewareChain = new MiddlewareChain();
    middlewareChain.add(new LoggingMiddleware(eventBus));
    middlewareChain.add(new TimeoutMiddleware());
    if (config.execution.auto_retry) {
      middlewareChain.add(new RetryMiddleware(eventBus));
    }

    return new Platform(config, adapters, eventBus, kv, engine, memoryManager, runtimeResolver, middlewareChain);
  }

  /**
   * Load a plugin. Plugins can register adapters and middleware.
   */
  async loadPlugin(plugin: Plugin): Promise<void> {
    this.plugins.push(plugin);

    // Register adapters from the plugin
    if (plugin.adapters) {
      for (const factory of plugin.adapters) {
        this.adapters.register(factory.type, (config) => factory.create(config as unknown as Record<string, unknown>));
      }
    }

    // Register middleware from the plugin
    if (plugin.middleware) {
      for (const mw of plugin.middleware) {
        this.middlewareChain.add(mw);
      }
    }

    // Initialize the plugin
    if (plugin.initialize) {
      await plugin.initialize({
        projectId: this.config.project.name,
        config: this.config as unknown as Record<string, unknown>,
        getKV: () => this.kv.scoped({ scope: 'project' as Scope, id: this.config.project.name }),
        getDocStore: () => this.memoryManager.docs({ scope: 'project' as Scope, id: this.config.project.name }),
        getEventBus: () => ({
          publish: (event) => this.eventBus.publish(event),
          subscribe: (pattern, handler) => this.eventBus.subscribe(pattern, handler),
        }),
      });
    }
  }

  /**
   * Run a single agent with a prompt.
   */
  async run(options: {
    prompt: string;
    agent?: AgentDefinition;
    agentName?: string;
    cwd?: string;
    context?: string;
  }): Promise<ExecutionResult> {
    const agent = this.resolveAgent(options);
    const cwd = options.cwd ?? this.config.project.root_path;

    // Resolve runtime if not explicitly set
    if (!agent.runtime) {
      agent.runtime = this.runtimeResolver.resolve(agent);
    }

    const request: ExecutionRequest = {
      id: `exec_${nanoid(8)}`,
      agent,
      prompt: options.prompt,
      cwd,
      context: options.context,
      attempt: 1,
      projectId: this.config.project.name,
    };

    return this.engine.execute(request);
  }

  /**
   * Run with streaming -- yields events as they happen.
   */
  async *runStreaming(options: {
    prompt: string;
    agent?: AgentDefinition;
    agentName?: string;
    cwd?: string;
    context?: string;
  }) {
    const agent = this.resolveAgent(options);
    const cwd = options.cwd ?? this.config.project.root_path;

    if (!agent.runtime) {
      agent.runtime = this.runtimeResolver.resolve(agent);
    }

    const request: ExecutionRequest = {
      id: `exec_${nanoid(8)}`,
      agent,
      prompt: options.prompt,
      cwd,
      context: options.context,
      attempt: 1,
      projectId: this.config.project.name,
    };

    yield* this.engine.executeStreaming(request);
  }

  /**
   * Run a DAG workflow.
   */
  async runWorkflow(definition: WorkflowDefinition): Promise<WorkflowResult> {
    if (!definition.cwd) {
      definition.cwd = this.config.project.root_path;
    }
    if (!definition.projectId) {
      definition.projectId = this.config.project.name;
    }

    // Resolve runtimes for all nodes
    for (const node of definition.nodes) {
      if (!node.agent.runtime) {
        node.agent.runtime = this.runtimeResolver.resolve(node.agent);
      }
    }

    return this.workflowOrchestrator.run(definition);
  }

  /**
   * Run a pipeline (sequential steps).
   */
  async runPipeline(config: PipelineConfig): Promise<PipelineResult> {
    if (!config.cwd) {
      config.cwd = this.config.project.root_path;
    }
    if (!config.projectId) {
      config.projectId = this.config.project.name;
    }

    // Resolve runtimes for all steps
    for (const step of config.steps) {
      if (!step.agent.runtime) {
        step.agent.runtime = this.runtimeResolver.resolve(step.agent);
      }
    }

    return this.pipelineRunner.run(config);
  }

  /**
   * Get all configured agents as AgentDefinitions.
   */
  getAgents(): AgentDefinition[] {
    return this.config.agents.map((a) => this.configToDefinition(a));
  }

  /**
   * Get loaded plugins.
   */
  getPlugins(): Plugin[] {
    return [...this.plugins];
  }

  // ─── Internal ───────────────────────────────────────────────────────────

  private resolveAgent(options: {
    agent?: AgentDefinition;
    agentName?: string;
  }): AgentDefinition {
    if (options.agent) return options.agent;

    if (options.agentName) {
      const agentConfig = this.config.agents.find(
        (a) => a.name === options.agentName,
      );
      if (!agentConfig) {
        throw new Error(`Agent '${options.agentName}' not found in config.`);
      }
      return this.configToDefinition(agentConfig);
    }

    // Default agent
    return {
      id: `agent_${nanoid(8)}`,
      name: 'default',
      source: AgentSource.CODE,
      runtime: 'claude-code',
      capabilities: [],
      memory: { scope: 'agent' as Scope, access: 'read-write' as const },
      preferences: {
        maxRetries: this.config.execution.max_retries,
        timeoutMs: 300_000,
      },
    };
  }

  private configToDefinition(config: PlatformConfig['agents'][number]): AgentDefinition {
    return {
      id: `agent_${nanoid(8)}`,
      name: config.name,
      description: config.description,
      source: AgentSource.YAML,
      runtime: config.runtime,
      capabilities: config.capabilities,
      memory: {
        scope: config.memory.scope as Scope,
        access: config.memory.access,
        subscribe: config.memory.subscribe,
      },
      preferences: {
        fallbackRuntime: config.preferences.fallback_runtime,
        maxRetries: config.preferences.max_retries,
        timeoutMs: parseTimeout(config.preferences.timeout ?? '300s'),
      },
      instructions: config.instructions ?? config.system_prompt,
      triggers: {
        onEvent: config.triggers.on_event,
        onSchedule: config.triggers.on_schedule,
      },
      adapterConfig: {
        model: config.model,
        maxTurns: config.max_turns,
        maxBudgetUsd: config.max_budget_usd,
        allowedTools: config.allowed_tools,
        permissionMode: config.permission_mode,
      },
    };
  }
}

function parseTimeout(timeout: string): number {
  const match = timeout.match(/^(\d+)(s|m|h)$/);
  if (!match || !match[1] || !match[2]) return 300_000;
  const value = parseInt(match[1], 10);
  switch (match[2]) {
    case 's': return value * 1000;
    case 'm': return value * 60 * 1000;
    case 'h': return value * 60 * 60 * 1000;
    default: return 300_000;
  }
}
