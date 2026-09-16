# Orchestrator Architecture

## Overview

The Orchestrator is a multi-agent development automation system that decomposes requirements into a task graph, schedules tasks onto Claude Code agents, executes them autonomously (optionally in parallel using git worktrees), validates results, and retries failures. It integrates with Claude Code via hooks and provides a CLI + web dashboard for management and monitoring.

**Version**: 0.2.1 | **Runtime**: Node.js >=18 (ESM) | **Language**: TypeScript ES2022 | **Database**: SQLite (via better-sqlite3 + Drizzle ORM)

---

## System Architecture

```
┌──────────────────────────────────────────────────────────────────────┐
│                         CLI Layer (Commander.js)                     │
│  orchestrate | plan | run | task | status | agent | worktree | ...   │
└──────────────┬───────────────────────────────────────────────────────┘
               │
┌──────────────▼───────────────────────────────────────────────────────┐
│                      Core Orchestration Engine                       │
│  ┌──────────┐  ┌──────────┐  ┌───────────┐  ┌───────────┐          │
│  │ Planner  │→ │Scheduler │→ │ Executor  │→ │ Validator │          │
│  └──────────┘  └──────────┘  └───────────┘  └───────────┘          │
│       ↕              ↕             ↕              ↕                  │
│  ┌──────────────────────────────────────────────────────┐           │
│  │              SessionManager (state persistence)       │           │
│  └──────────────────────────────────────────────────────┘           │
│       ↕              ↕             ↕              ↕                  │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐           │
│  │ArtifactEx│  │ConflictDe│  │SessionAna│  │ProjectSca│           │
│  │tractor   │  │tector    │  │lytics    │  │nner      │           │
│  └──────────┘  └──────────┘  └──────────┘  └──────────┘           │
└──────────────────────────────────────────────────────────────────────┘
               │                     │                │
┌──────────────▼──────┐  ┌───────────▼──────┐  ┌──────▼──────────────┐
│    Agent System     │  │   Task System    │  │  Context System     │
│ ┌─────────────────┐ │  │ ┌──────────────┐ │  │ ┌────────────────┐ │
│ │  AgentManager   │ │  │ │TaskRepository│ │  │ │ ContextStore   │ │
│ │  AgentRegistry  │ │  │ │  TaskGraph   │ │  │ │ObservationStore│ │
│ │ ContextBuilder  │ │  │ └──────────────┘ │  │ └────────────────┘ │
│ └─────────────────┘ │  └────────────────┘ │  └────────────────────┘
│ ┌─────────────────┐ │         │                       │
│ │    Runtimes     │ │         │                       │
│ │ ┌─────────────┐ │ │  ┌──────▼──────────┐  ┌────────▼─────────┐
│ │ │ claude-sdk  │ │ │  │   Git System    │  │  Event System    │
│ │ │ claude-cli  │ │ │  │ WorktreeManager │  │   EventBus       │
│ │ │ api         │ │ │  │ MergeCoordinator│  │   EventStore     │
│ │ └─────────────┘ │ │  └─────────────────┘  └──────────────────┘
│ └─────────────────┘ │
└─────────────────────┘         │
                         ┌──────▼──────────┐
                         │  Database Layer  │
                         │   SQLite + ORM   │
                         │   14 tables      │
                         └─────────────────┘
```

---

## Feature Inventory

### 1. Requirement Decomposition (Planner)
- LLM-powered decomposition of natural language requirements into a structured task DAG
- System prompt enforces strict JSON-only output with explicit "CRITICAL: respond with ONLY a valid JSON object" instruction
- Task schema: title, description, classification, priority, dependencies, tags, acceptance criteria, validation script, effort estimate
- **Retry logic** (configurable `maxRetries`, default 2): if LLM returns invalid JSON, retries with a dedicated `RETRY_PROMPT` that re-emphasizes raw JSON requirement
- **JSON extraction fallback**: tries markdown code fences (```` ```json ````), then raw `{...}` regex extraction before parsing
- Dependency resolution by task title, mapped to internal temp IDs
- Session analytics injection — historical failure patterns and cost-by-effort data fed into planner prompt via `SessionAnalytics.formatForPlannerPrompt()`

### 2. Task Management (TaskRepository + TaskGraph)
- Full CRUD for tasks with SQLite persistence
- State machine with 8 states: PENDING → READY → RUNNING → COMPLETED/FAILED
- Dependency tracking via taskDependencies table (BLOCKS/SOFT types)
- In-memory DAG with topological sort (Kahn's algorithm), cycle detection (DFS), critical path analysis
- Cascade cancellation of downstream tasks
- Automatic promotion of tasks to READY when all dependencies complete

### 3. Agent Scheduling (Scheduler)
- Priority-based scheduling (lower number = higher priority)
- Capability matching: task tags scored against agent capability levels (basic=1, proficient=2, expert=3)
- Role-based keyword matching (backend-developer, frontend-developer, etc.)
- Cost-aware model selection via EFFORT_MODEL_MAP (trivial→haiku, medium→sonnet, xlarge→opus)
- File conflict prediction: regex extraction of file paths from task descriptions, prevents concurrent modification
- Default agent fallback when no templates defined

### 4. Agent Execution (Executor + Runtimes)
- Three runtime backends:
  - **claude-sdk**: Uses `@anthropic-ai/claude-agent-sdk` query() — structured, no subprocess. Sets `ORCH_AGENT_MODE=1` to prevent hook recursion. Strips `CLAUDE_CODE` and `CLAUDE_CODE_ENTRYPOINT` env vars.
  - **claude-cli**: Spawns `claude -p <prompt> --output-format stream-json` as child process. Uses `buildChildEnv()` to strip `CLAUDE_CODE`/`CLAUDE_CODE_ENTRYPOINT` env vars and set `ORCH_AGENT_MODE=1`. Multi-strategy binary discovery: local node_modules → `which claude` → global paths → bare fallback.
  - **api**: Direct HTTP to Anthropic Messages API (requires ANTHROPIC_API_KEY). Single-turn only.
- AsyncGenerator pattern: yields AgentMessage events during execution, returns AgentRunResult on completion
- **Token/cost tracking** (v0.2.1): Both SDK and CLI runtimes extract cost from `total_cost_usd` (not `cost_usd`), tokens from nested `usage.input_tokens`/`usage.output_tokens`, and aggregate across all models via `modelUsage` object (includes Task subagents, sidechains, and auxiliary calls). SDK runtime extracts metrics from both success and error result events.
- Prompt building: task description + acceptance criteria + input context + shared project context + worktree path + retry feedback
- Event streaming to EventBus during execution

### 5. Validation (Validator)
- 5 validation checks run after each task:
  1. Agent execution success (exit code / result.success)
  2. Custom validation script (`sh -c <script>` with 2-min timeout)
  3. TypeScript type check (`tsc --noEmit` if tsconfig.json exists)
  4. ESLint check (if eslint config detected)
  5. Acceptance criteria presence check
- Retry with feedback: failed validation produces markdown feedback injected into task's inputContext._retryFeedback
- Configurable via `orchestrator.validationEnabled` and `orchestrator.autoRetry`

### 6. Git Worktree Isolation (WorktreeManager + MergeCoordinator)
- Each task can execute in an isolated git worktree (separate branch + directory)
- Branch naming: `{branchPrefix}{slug}-{taskId}`
- Worktree path: `.orchestrator/worktrees/{slug}-{taskId}`
- Merge via `git merge --no-ff` with conflict detection
- MergeCoordinator: plans merge order, executes sequential integration, stops on conflict (configurable)
- Cleanup: removes MERGED/ABANDONED worktrees + prunes git refs

### 7. Context System (ContextStore + ObservationStore + ProjectScanner)
- **ContextStore**: Key-value store with 6 categories (REQUIREMENTS, ARCHITECTURE, API_CONTRACT, DECISION, CONVENTION, DEPENDENCY). Version history tracked. Content injected into all agent prompts via `buildAgentContext()`.
- **ProjectScanner**: Auto-scans project at orchestration start. Detects package manager, language, framework, build tool, test framework, conventions. Stores as ARCHITECTURE context entry.
- **ObservationStore**: Agents' implicit observations (patterns, conventions, warnings, discoveries) extracted from output via regex. Matched to downstream tasks by file relevance + tags. Confidence scored (0.6–0.8).

### 8. Artifact Passing (ArtifactExtractor)
- After task completion, scans agent messages for Write/Edit tool calls → extracts files created/modified
- Detects decisions from assistant text ("I decided", "Chose", "Using")
- Formats artifacts as markdown context for downstream tasks
- Enables cross-task awareness: dependent tasks know what upstream tasks produced

### 9. Conflict Detection (ConflictDetector)
- Pre-execution: regex-based file path prediction from task descriptions
- Post-execution: tracks actual files touched per task, detects overlaps via pairwise comparison
- Scheduler uses predictions to prevent scheduling conflicting tasks in same batch

### 10. Session Management (SessionManager)
- State persisted to `.orchestrator/sessions/{sessionId}.json`
- Tracks: completed/failed tasks, agent sessions, accumulated metrics (cost, tokens, tool calls, turns)
- Resume capability: `--resume` flag reloads last interrupted session
- Session metrics also persisted to orchestratorSessions table in SQLite

### 11. Session Analytics (SessionAnalytics)
- Queries historical `orchestratorSessions` and `taskMetrics` tables to compute: total sessions, avg duration, avg cost, avg tasks planned, completion rate, failure patterns (grouped by status), cost/duration by effort level (joins tasks table)
- `formatForPlannerPrompt()` produces markdown summary injected into planner's requirements prompt — includes avg cost per session, task completion rate, cost-by-effort breakdown, and failure warnings
- Planner calls `sessionAnalytics.analyze()` before decomposition if analytics instance is provided via config

### 12. Event System (EventBus + EventStore)
- In-process pub/sub with glob pattern matching (minimatch)
- Event types: task.state_changed, task.created, agent.message, agent.status_changed, context.updated, validation.*
- EventStore persists all events to SQLite asynchronously
- Queryable: filter by projectId, type, timestamp, with pagination

### 13. Claude Code Integration (Hooks)
- **SessionStart hook**: Detects `orchestrator.config.yaml` → offers orchestrator mode to user
- **UserPromptSubmit hook**: If `.orchestrator/session-active` marker exists → routes user requests through orchestrate command with timestamp-unique requirements file
- **Hook recursion guard** (v0.2.0): Both hooks check `process.env.ORCH_AGENT_MODE === '1'` at the top and `process.exit(0)` immediately, preventing recursive hook injection into agent subprocesses. Both runtimes (SDK + CLI) set this env var before spawning agents.
- Install/uninstall via `npx orch hooks install|uninstall`

### 14. Web Dashboard
- Fastify server on configurable port (default 3847)
- REST routes for tasks, agents, context, worktrees, events, metrics, evals
- WebSocket support for real-time event streaming

### 15. Evaluation Framework
- Built-in + custom evaluation scenarios (YAML-defined)
- EvalRunner executes scenarios as mini-orchestrations
- Report generator: table, JSON, comparison formats
- History tracking in evalRuns table
- CLI: `npx orch eval run|list|history|report|compare`

### 16. Metrics & Observability
- Per-task metrics: cost (`total_cost_usd`), tokens (input/output via `usage` + `modelUsage` aggregation), tool calls, turns, duration, attempt number
- `modelUsage` aggregation (v0.2.1): sums token counts across all models used during a task, including Task subagents, sidechains, and auxiliary calls — provides comprehensive accounting beyond the main loop
- Per-session aggregates: total cost, total tokens, success rate
- CLI: `npx orch metrics`, `npx orch metrics sessions`, `npx orch metrics session <id>`
- Stored in taskMetrics and orchestratorSessions tables

---

## Orchestration Pipeline (End-to-End Flow)

```
User submits requirements
        │
        ▼
┌─ Phase 1: PROJECT SCANNING ──────────────────────────┐
│  ProjectScanner.scan(rootPath)                        │
│  → Detects: pkg manager, language, framework, etc.    │
│  → Stores result as ARCHITECTURE context entry        │
└───────────────────────────────────────────────────────┘
        │
        ▼
┌─ Phase 2: PLANNING ──────────────────────────────────┐
│  Planner.decompose(requirements)                      │
│  → Fetches session analytics (if available)           │
│  → Sends requirements + system prompt to LLM agent    │
│  → Parses JSON task graph from response               │
│  → Resolves inter-task dependencies by title          │
│  → Creates tasks in DB (2-pass: create, then edges)   │
│  → Validates DAG (cycle detection)                    │
│  → Promotes tasks with met deps to READY              │
└───────────────────────────────────────────────────────┘
        │
        ▼
┌─ Phase 3: PLAN APPROVAL (optional) ──────────────────┐
│  onPlanReady callback displays task table              │
│  User approves or rejects plan                        │
│  If rejected: session ends with "Plan rejected"       │
└───────────────────────────────────────────────────────┘
        │
        ▼
┌─ Phase 4: EXECUTION LOOP ────────────────────────────┐
│  while (tasks remain):                                │
│    1. Get READY tasks from DB                         │
│    2. Check file conflict predictions                 │
│    3. Scheduler.schedule() → assignments              │
│       - Priority sort                                 │
│       - Capability matching                           │
│       - Cost-aware model selection                    │
│       - Conflict avoidance                            │
│    4. For each assignment:                            │
│       a. Transition task → RUNNING                    │
│       b. Build context (AgentContextBuilder)          │
│          - Task description + criteria                │
│          - Upstream artifacts (_upstreamArtifacts)     │
│          - Shared project context                     │
│          - Agent observations                         │
│          - Retry feedback (if retry)                  │
│       c. Executor.execute(task, agent, context)       │
│          - Runtime.run() → stream messages            │
│          - Publish messages to EventBus               │
│       d. Validator.validate(task, result, cwd)        │
│          - Agent success check                        │
│          - Validation script check                    │
│          - TypeScript type check                      │
│          - ESLint check                               │
│          - Acceptance criteria check                  │
│       e. If validation fails & retries remain:        │
│          - Build feedback from failures               │
│          - Store in task.inputContext._retryFeedback   │
│          - Transition task → READY (for retry)        │
│       f. If validation passes:                        │
│          - Extract artifacts (files, exports, decisions)│
│          - Inject artifacts into dependent tasks      │
│          - Extract observations from agent output     │
│          - Transition task → COMPLETED                │
│          - Promote downstream tasks to READY          │
│       g. Persist task metrics to DB                   │
│    5. Wait for running tasks if no READY tasks        │
│    6. Break if deadlock (pending but none ready/running)│
└───────────────────────────────────────────────────────┘
        │
        ▼
┌─ Phase 5: RESULTS ───────────────────────────────────┐
│  Collect final task statuses                          │
│  Persist session metrics to DB                        │
│  Return OrchestratorResult:                           │
│    success, tasks, completed, failed, cancelled,      │
│    totalCostUsd, durationMs, sessionId, summary,      │
│    metrics (tokens, tool calls, turns)                │
└───────────────────────────────────────────────────────┘
```

---

## Task State Machine

```
                    ┌─────────────┐
         ┌────────→│   BLOCKED   │←────────┐
         │         └──────┬──────┘         │
         │                │ (deps met)     │
         │                ▼                │
    ┌────┴────┐    ┌──────────────┐   ┌────┴─────┐
    │ PENDING │───→│    READY     │←──│  FAILED  │
    └────┬────┘    └──────┬───────┘   └────┬─────┘
         │                │ (assigned)      │ (retry)
         │                ▼                 │
         │         ┌──────────────┐         │
         │         │   RUNNING    │─────────┘
         │         └──┬────┬───┬──┘
         │            │    │   │
         │            ▼    │   ▼
         │    ┌────────┐   │  ┌───────────────────┐
         │    │COMPLETED│  │  │WAITING_FOR_HUMAN   │
         │    └────────┘   │  └───────┬───────────┘
         │                 │          │ (resume)
         │                 │          ▼
         │                 │     Back to RUNNING
         │                 ▼
         │          ┌───────────┐
         └─────────→│ CANCELLED │
                    └───────────┘

Terminal states: COMPLETED, CANCELLED
```

---

## Database Schema (14 Tables)

| Table | Purpose | Key Columns |
|-------|---------|-------------|
| `projects` | Project registry | id, name, rootPath, configPath |
| `tasks` | Task records | id, projectId, title, description, status, classification, priority, assignedAgentId, worktreeId, attempt, maxRetries, inputContext (JSON), outputArtifacts (JSON), acceptanceCriteria (JSON), validationScript, tags (JSON), estimatedEffort |
| `taskDependencies` | Task DAG edges | taskId, dependsOnTaskId, type (BLOCKS\|SOFT) |
| `agentTemplates` | Agent configurations | id, name, role, runtimeType, capabilities (JSON), model, maxTurns, systemPrompt, allowedTools (JSON), permissionMode |
| `agentInstances` | Running agent state | id, templateId, status, currentTaskId, sessionId, totalCostUsd, turnsUsed |
| `contextEntries` | Shared project context | id, projectId, key (unique per project), category, title, content, version |
| `contextHistory` | Context version history | id, entryId, version, content, updatedBy |
| `observations` | Inter-agent knowledge | id, projectId, taskId, agentId, type, content, relevantFiles (JSON), confidence |
| `events` | Event audit trail | id, type, source, projectId, payload (JSON), timestamp |
| `worktrees` | Git worktree state | id, projectId, path, branch, taskId, agentId, status (ACTIVE\|MERGED\|ABANDONED) |
| `orchestratorSessions` | Session-level metrics | id, projectId, requirements, status, tasksPlanned/Completed/Failed, totalCostUsd, totalTokens, durationMs |
| `taskMetrics` | Per-task execution metrics | id, sessionId, taskId, agentId, costUsd, inputTokens, outputTokens, toolCalls, turns, durationMs, attempt, status |
| `evalRuns` | Evaluation results | id, scenarioName, projectId, status, metrics (JSON), config (JSON) |
| `mcpServers` | MCP server configs | id, name, type, command, args (JSON), url, env (JSON) |

**Indexes**: tasks(projectId, status), tasks(assignedAgentId), events(projectId, type), events(timestamp), evalRuns(startedAt)

---

## Agent Runtime Comparison

| Feature | claude-sdk | claude-cli | api |
|---------|-----------|------------|-----|
| Subprocess? | No (in-process) | Yes (child_process.spawn) | No (HTTP fetch) |
| Auth | Claude Code subscription | Claude Code subscription | ANTHROPIC_API_KEY |
| Tool use | Full (multi-turn) | Full (multi-turn) | None (single-turn) |
| Streaming | Via event callbacks | Via stdout JSON stream | No |
| Env sanitization | Strips CLAUDE_CODE + CLAUDE_CODE_ENTRYPOINT, sets ORCH_AGENT_MODE=1 | Strips CLAUDE_CODE + CLAUDE_CODE_ENTRYPOINT via buildChildEnv(), sets ORCH_AGENT_MODE=1 | N/A |
| Cost tracking | `total_cost_usd` + `modelUsage` aggregation (includes subagents) | `total_cost_usd` + `modelUsage` aggregation (includes subagents) | Estimated from token counts |
| Token tracking | `usage.input_tokens`/`output_tokens` with `modelUsage` fallback | `usage.input_tokens`/`output_tokens` with `modelUsage` fallback | From API response |
| Session resume | Via session ID | Via --resume flag | No |
| Error handling | Structured exceptions; extracts metrics from error results too | Exit code + stderr | HTTP status codes |
| Binary discovery | N/A (in-process) | Local node_modules → `which` → global paths → bare fallback | N/A |

---

## Configuration Schema

```yaml
project:
  name: string                          # Required
  rootPath: string                      # Default: "."

orchestrator:
  maxConcurrentAgents: number           # Default: 3
  maxTotalBudgetUsd: number             # Default: 10.0
  autoRetry: boolean                    # Default: true
  maxRetries: number                    # Default: 2
  validationEnabled: boolean            # Default: true

database:
  path: string                          # Default: ".orchestrator/data.db"

agents:
  templates:                            # Default: []
    - id: string
      name: string
      role: string                      # backend-developer, frontend-developer, etc.
      runtimeType: claude-sdk|claude-cli|api
      capabilities:
        - name: string
          level: basic|proficient|expert
      model: string                     # Optional: claude-sonnet-4-6, claude-haiku-4-5, etc.
      maxTurns: number                  # Optional
      maxBudgetUsd: number              # Optional
      systemPrompt: string              # Optional
      allowedTools: string[]            # Optional
      permissionMode: default|auto|acceptEdits  # Default: default
      mcpServers: string[]              # Optional

git:
  integrationBranch: string             # Default: "main"
  worktreeDir: string                   # Default: ".orchestrator/worktrees"
  branchPrefix: string                  # Default: "orch/"

web:
  port: number                          # Default: 3847
  host: string                          # Default: "localhost"
```

---

## CLI Command Reference

| Command | Description |
|---------|-------------|
| `orch init` | Initialize orchestrator in current directory |
| `orch orchestrate <file>` | Full pipeline: plan → approve → execute → validate |
| `orch plan <file>` | Decompose requirements into task graph (no execution) |
| `orch run` | Execute ready tasks (--task for single, --orchestrate for full loop) |
| `orch task add\|list\|show\|cancel` | Task CRUD |
| `orch status` | Project-level progress overview |
| `orch agent list\|inspect\|add\|remove` | Agent template management |
| `orch context set\|get\|list\|delete\|history` | Shared context management |
| `orch worktree list\|clean\|merge\|remove\|integrate` | Git worktree management |
| `orch config show\|get` | View configuration |
| `orch metrics [sessions\|session\|tasks]` | Performance metrics |
| `orch eval run\|list\|history\|report\|compare` | Evaluation framework |
| `orch hooks install\|uninstall\|status` | Claude Code hook management |
| `orch serve` | Start web dashboard |

---

## Component Handoff Map

This shows how data flows between components during orchestration:

```
Requirements (string)
    │
    ├──→ ProjectScanner.scan() ──→ ContextStore.set(ARCHITECTURE)
    │
    ├──→ SessionAnalytics.analyze() ──→ Planner (system prompt enrichment)
    │
    └──→ Planner.decompose()
              │
              └──→ CreateTaskInput[] ──→ TaskRepository.create()
                                              │
                                              └──→ TaskGraph (in-memory DAG)
                                                       │
                                              ┌────────┘
                                              ▼
                                    Scheduler.schedule()
                                              │
                                    ┌─────────┘
                                    ▼
                    ┌──→ AgentContextBuilder.build()
                    │         │
                    │         ├── ContextStore.buildAgentContext()
                    │         ├── ObservationStore.findRelevant()
                    │         └── task.inputContext._upstreamArtifacts
                    │
                    └──→ Executor.execute()
                              │
                              ├──→ Runtime.run() ──→ AgentMessage stream ──→ EventBus
                              │
                              └──→ AgentRunResult
                                       │
                              ┌────────┘
                              ▼
                    Validator.validate()
                              │
                    ┌─────────┴──────────┐
                    ▼                    ▼
              (passes)              (fails)
                    │                    │
                    ▼                    ▼
        ArtifactExtractor     Validator.buildFeedback()
              │                         │
              ├──→ outputArtifacts      └──→ inputContext._retryFeedback
              ├──→ dependent tasks           │
              │    inputContext              ▼
              │    ._upstreamArtifacts  Task → READY (retry)
              │
              └──→ ObservationStore.extractFromResult()
                         │
                         └──→ observations table
```

---

## Known Issues & Bug Fix History

### Fixed in v0.2.0
1. **~~Recursive hook injection~~** (FIXED): SessionStart and UserPromptSubmit hooks fired inside agent subprocesses, causing agents to respond to orchestrator instructions instead of their task. **Fix**: Both hooks now check `ORCH_AGENT_MODE=1` and exit immediately. Both runtimes set this env var in subprocess environments.

2. **~~CLAUDECODE nesting block~~** (FIXED): Subprocess agents inherited `CLAUDECODE=1` env var → claude CLI refused to start → empty stdout → JSON parse failure. **Fix**: `buildChildEnv()` strips `CLAUDE_CODE` and `CLAUDE_CODE_ENTRYPOINT` from child process environment.

### Fixed in v0.2.1
3. **~~Planner JSON compliance~~** (IMPROVED): The planner agent sometimes returned human-readable summaries instead of JSON. **Fix**: Strengthened system prompt with "CRITICAL: respond with ONLY a valid JSON object", added retry loop (up to `maxRetries`, default 2) with dedicated `RETRY_PROMPT`, and added JSON extraction fallback (markdown code fences → raw `{...}` regex).

4. **~~Zero token/cost tracking~~** (FIXED): CLI runtime read `event.cost_usd` but CLI outputs `total_cost_usd`. CLI runtime read flat `event.input_tokens` but CLI outputs nested `event.usage.input_tokens`. **Fix**: Corrected field names in both runtimes. Added `modelUsage` aggregation — sums `inputTokens`/`outputTokens` across all models for comprehensive accounting that includes Task subagents, sidechains, and auxiliary calls. SDK runtime now extracts cost/turns/session_id from both success and error result events.

### Open Issues
5. **Single-page app context**: For large projects, the project scanner's 2-level directory tree may be insufficient context for agents.

6. **No merge strategy intelligence**: Worktree merges use simple `--no-ff`. No semantic understanding of whether parallel changes are compatible beyond git's text-level conflict detection.

7. **Planner JSON not guaranteed**: Despite retry logic and prompt strengthening, there is no hard guarantee the LLM will produce valid JSON. The retry + extraction fallback chain reduces failure rate but doesn't eliminate it entirely.

---

## File Index

```
src/
├── index.ts                           # CLI entry point
├── cli/
│   ├── index.ts                       # Command registration
│   ├── helpers.ts                     # loadProjectContext()
│   ├── formatters.ts                  # Task/status formatting
│   └── commands/
│       ├── init.ts                    # orch init
│       ├── orchestrate.ts             # orch orchestrate
│       ├── plan.ts                    # orch plan
│       ├── run.ts                     # orch run
│       ├── task.ts                    # orch task *
│       ├── status.ts                  # orch status
│       ├── agent.ts                   # orch agent *
│       ├── context.ts                 # orch context *
│       ├── worktree.ts               # orch worktree *
│       ├── config.ts                  # orch config *
│       ├── metrics.ts                 # orch metrics *
│       ├── eval.ts                    # orch eval *
│       ├── hooks.ts                   # orch hooks *
│       └── serve.ts                   # orch serve
├── core/
│   ├── orchestrator.ts                # Main orchestration engine
│   ├── planner.ts                     # LLM-powered task decomposition
│   ├── executor.ts                    # Task execution on agent runtimes
│   ├── scheduler.ts                   # Task→agent assignment with scoring
│   ├── validator.ts                   # Multi-check validation (tsc, eslint, scripts)
│   ├── session-manager.ts            # Session state persistence + resume
│   ├── artifact-extractor.ts         # Extract files/exports from agent output
│   ├── conflict-detector.ts          # File conflict prediction + detection
│   └── session-analytics.ts          # Historical session insights
├── agent/
│   ├── types.ts                       # AgentConfig, AgentStatus, AgentInstance
│   ├── agent-manager.ts              # Agent instance lifecycle
│   ├── agent-registry.ts             # Agent template storage + capability matching
│   ├── context-builder.ts            # Build task-specific agent prompts
│   └── runtimes/
│       ├── runtime.ts                 # AgentRuntime interface, AgentMessage, AgentRunResult
│       ├── claude-sdk-runtime.ts     # @anthropic-ai/claude-agent-sdk runtime
│       ├── claude-cli-runtime.ts     # Claude CLI subprocess runtime
│       └── api-runtime.ts            # Direct Anthropic API runtime
├── task/
│   ├── types.ts                       # TaskStatus, Task, CreateTaskInput, VALID_TRANSITIONS
│   ├── task-repository.ts            # Task CRUD + state machine
│   └── task-graph.ts                 # In-memory DAG (topo sort, cycle detect, critical path)
├── context/
│   ├── types.ts                       # ContextCategory, ContextEntry
│   ├── context-store.ts              # High-level context operations
│   ├── context-repository.ts         # Context persistence + versioning
│   ├── observation-store.ts          # Inter-agent observation sharing
│   └── project-scanner.ts           # Auto-detect project structure
├── events/
│   ├── types.ts                       # Event type definitions
│   ├── event-bus.ts                  # In-process pub/sub with glob matching
│   └── event-store.ts               # Event persistence to SQLite
├── git/
│   ├── git-utils.ts                  # Git command helpers
│   ├── worktree-manager.ts           # Worktree CRUD + merge
│   └── merge-coordinator.ts          # Multi-worktree integration planning
├── db/
│   ├── schema.ts                     # Drizzle ORM table definitions (14 tables)
│   └── connection.ts                 # SQLite connection (WAL mode)
├── config/
│   ├── types.ts                      # Zod schemas for all config
│   ├── defaults.ts                   # Default config values
│   └── loader.ts                     # YAML loading + env interpolation
├── hooks/
│   ├── session-start.ts              # Claude Code SessionStart hook
│   └── prompt-intercept.ts           # Claude Code UserPromptSubmit hook
├── web/
│   ├── server.ts                     # Fastify server setup
│   └── routes/                       # REST API routes
├── eval/
│   ├── types.ts                      # EvalScenario, EvalResult
│   ├── eval-runner.ts                # Scenario execution
│   ├── report-generator.ts           # Output formatting
│   ├── builtin-scenarios.ts          # Built-in eval scenarios
│   └── metrics-collector.ts          # Eval metrics collection
├── mcp/
│   ├── mcp-registry.ts              # MCP server configuration
│   ├── mcp-manager.ts               # MCP server lifecycle
│   └── tool-router.ts               # Tool call routing to MCP servers
└── util/
    ├── id.ts                         # nanoid-based ID generation
    ├── logger.ts                     # Pino logger setup
    └── errors.ts                     # Error class hierarchy
```
