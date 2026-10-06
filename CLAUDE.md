# Multi-Agent Development Orchestrator

## What This Is

A universal AI agent platform (`orch`) that lets you compose any AI harness, API, framework, or CLI tool into workflows with shared memory, scheduling, and observability. Build agents using code (TypeScript SDK), descriptive files (.md with frontmatter), or YAML config -- the platform handles execution, coordination, and lifecycle management across heterogeneous runtimes.

Published as npm package: `dev-orchestrator`

## Quick Setup

```bash
# Install globally
npm install -g dev-orchestrator

# OR install as a dev dependency in your project
npm install --save-dev dev-orchestrator

# Initialize platform config in your project
cd /path/to/your/project
npx orch init
```

## Architecture (Four Layers)

```
Layer 4: User Surface     CLI, SDK, YAML Config, Agent Loader
Layer 3: Composition      DAG Scheduler, Pipeline Runner, Workflow Orchestrator, Middleware
Layer 2: Platform Core    Memory (KV + Document Store), Event Bus
Layer 1: Runtime Adapters Claude Code, API (OpenAI/Anthropic), CLI (shell)
```

Key source files:

- **Platform** (`src/platform/platform.ts`) — Top-level wiring, exposes `run()`, `runWorkflow()`, `runPipeline()`, `loadPlugin()`
- **Types** (`src/platform/types.ts`) — Core types: `AgentDefinition`, `ExecutionResult`, `Scope`, `Middleware`, `Plugin`
- **Config** (`src/platform/config/schema.ts`) — Zod schema for `platform.config.yaml`
- **Execution Engine** (`src/layer3-engine/execution/engine.ts`) — Dispatches to runtime adapters, streams events
- **DAG Scheduler** (`src/layer3-engine/composition/dag-scheduler.ts`) — Dependency graph with pluggable scheduler
- **Pipeline Runner** (`src/layer3-engine/composition/pipeline-runner.ts`) — Sequential step execution with `{{previous}}` interpolation
- **Workflow Orchestrator** (`src/layer3-engine/composition/workflow-orchestrator.ts`) — Drives DAG workflows with parallel dispatch
- **Middleware Chain** (`src/layer3-engine/middleware/chain.ts`) — Retry, timeout, logging middleware
- **Runtime Resolver** (`src/layer3-engine/runtime-resolver.ts`) — Capability matching + preference ordering
- **Memory Manager** (`src/layer2-core/memory/memory-manager.ts`) — 4-level scoped KV + document stores
- **Event Bus** (`src/layer2-core/events/event-bus.ts`) — Pub/sub with glob-style pattern matching
- **Adapter Registry** (`src/layer1-adapters/adapter-registry.ts`) — Registers Claude Code, API, CLI adapters
- **Agent Parser** (`src/layer4-surface/agent-loader/parser.ts`) — Loads agents from .yaml and .md files
- **SDK** (`src/layer4-surface/sdk/index.ts`) — `Agent.create()`, `Workflow.create()` fluent builders

### Runtime Adapters

| Adapter | Type | Capabilities | Source |
|---------|------|-------------|--------|
| Claude Code | `claude-code` | file-edit, shell, git, reasoning | `src/layer1-adapters/claude-code/adapter.ts` |
| API (HTTP) | `api` | text-generation, reasoning | `src/layer1-adapters/api/adapter.ts` |
| CLI (shell) | `cli` | shell, file-system, deployment | `src/layer1-adapters/cli/adapter.ts` |

### Memory Scopes

Four levels, from broadest to narrowest:
- **global** — Persists across all projects
- **project** — Persists for the lifetime of a project
- **workflow** — Shared between agents in one workflow execution (ephemeral)
- **agent** — Private to a single agent instance (ephemeral)

## Usage

### Platform Commands

```bash
npx orch init                              # Initialize platform config
npx orch run "<prompt>"                    # Execute an agent with a prompt
npx orch run "<prompt>" --agent backend    # Use a named agent from config
npx orch status                            # Show platform and project status
npx orch workflow run workflow.yaml        # Run a DAG workflow from file
npx orch agent list                        # List configured agents
npx orch agent inspect agent.yaml          # Inspect an agent definition file
npx orch agent runtimes                    # List available runtime adapters
```

### SDK Usage

```typescript
import { Agent, Workflow, Events } from 'dev-orchestrator/sdk';

// Define agents
const planner = Agent.create('planner')
  .runtime('api')
  .capability('text-generation')
  .build();

const builder = Agent.create('builder')
  .runtime('claude-code')
  .capability('file-edit', 'shell', 'git')
  .memory({ scope: 'workflow', access: 'read-write' })
  .build();

const deployer = Agent.create('deployer')
  .runtime('cli')
  .capability('deployment')
  .build();

// Build a workflow
const workflow = Workflow.create('deploy-app')
  .step('plan', planner, 'Create implementation plan')
  .parallel([
    { name: 'frontend', agent: builder, prompt: 'Build React frontend' },
    { name: 'backend', agent: builder, prompt: 'Build Node.js API' },
  ], { dependsOn: ['plan'] })
  .step('deploy', deployer, 'Deploy to production', {
    dependsOn: ['frontend', 'backend'],
  })
  .constraints({ maxConcurrent: 3, maxBudgetUsd: 20 })
  .build();
```

### Agent Definition Formats

**YAML (`agent.yaml`)**:
```yaml
name: backend-dev
runtime: claude-code
capabilities: [file-edit, shell, git]
memory:
  scope: workflow
  access: read-write
preferences:
  max_retries: 3
  timeout: 10m
```

**Markdown (`.md` with frontmatter)**:
```markdown
---
name: doc-writer
runtime: api
capabilities: [text-generation]
---

# Documentation Writer

Write documentation for the codebase.

## Steps

1. **Scan**: Analyze the project structure
2. **Write**: Generate docs for each module
3. **Review**: Self-review the output
```

### Plugin System

```typescript
const myPlugin: Plugin = {
  name: 'my-runtime',
  version: '1.0.0',
  adapters: [{
    type: 'custom-runtime',
    create: (config) => new MyCustomAdapter(config),
  }],
  middleware: [{
    name: 'custom-cache',
    execute: (ctx, next) => { /* ... */ return next(); },
  }],
};

await platform.loadPlugin(myPlugin);
```

## Build & Test

```bash
npm run build          # TypeScript compilation
npm run dev            # Watch mode
npx tsc --noEmit       # Type check only
npx vitest run         # Run all tests (128 tests)
npx vitest --watch     # Watch mode tests
```

### Test Structure

| Test File | Tests | Component |
|-----------|-------|-----------|
| `tests/unit/platform/dag-scheduler.test.ts` | 19 | DAG scheduler + default scheduler |
| `tests/unit/platform/middleware.test.ts` | 12 | Middleware chain, retry, timeout, logging |
| `tests/unit/platform/workflow-integration.test.ts` | 11 | Full workflow orchestrator integration |
| `tests/unit/platform/platform-integration.test.ts` | 11 | Platform wiring, plugins, runtime resolution |
| `tests/unit/platform/doc-store.test.ts` | 11 | Document store with scoping |
| `tests/unit/platform/kv-store.test.ts` | 11 | KV store with subscriptions |
| `tests/unit/platform/event-bus.test.ts` | 10 | Event bus with wildcard matching |
| `tests/unit/platform/agent-builder.test.ts` | 9 | Agent fluent builder |
| `tests/unit/platform/memory-manager.test.ts` | 8 | Memory manager with read-only enforcement |
| `tests/unit/platform/workflow-builder.test.ts` | 7 | Workflow builder with validation |
| `tests/unit/platform/runtime-resolver.test.ts` | 7 | Runtime capability matching |
| `tests/unit/platform/agent-parser.test.ts` | 6 | YAML + markdown agent parsing |
| `tests/unit/platform/config-loader.test.ts` | 6 | Config schema validation |

