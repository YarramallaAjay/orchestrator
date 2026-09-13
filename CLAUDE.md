# Multi-Agent Development Orchestrator

## What This Is

A CLI tool that autonomously decomposes user requirements into tasks, assigns them to Claude Code agents running in isolated git worktrees, executes them in parallel, validates results, and retries failures. It includes human-in-the-loop plan approval and detailed performance metrics tracking.

## Quick Setup

```bash
# 1. Install dependencies
npm install

# 2. Build
npm run build

# 3. Initialize in your project directory
cd /path/to/your/project
npx tsx /path/to/orchestrator/src/cli/index.ts init

# 4. Install Claude Code hooks (auto-pickup)
npx tsx /path/to/orchestrator/src/cli/index.ts hooks install
```

## Claude Code Integration

### How Hooks Work

After running `hooks install`, two hooks are registered in your Claude Code settings:

1. **SessionStart hook** — When you open Claude Code in a project with `orchestrator.config.yaml`, Claude detects the orchestrator and asks if you want to use it.

2. **UserPromptSubmit hook** — When orchestrator mode is active, every request is automatically routed through the orchestrator pipeline.

### Manual Hook Installation

If automatic installation doesn't work, add these to `~/.claude/settings.json`:

```json
{
  "hooks": {
    "SessionStart": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "npx tsx /path/to/orchestrator/src/hooks/session-start.ts"
          }
        ]
      }
    ],
    "UserPromptSubmit": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "npx tsx /path/to/orchestrator/src/hooks/prompt-intercept.ts"
          }
        ]
      }
    ]
  }
}
```

Replace `/path/to/orchestrator` with the actual path to this repository.

## Usage

### Single Command Pipeline

```bash
# From requirements file (interactive plan approval)
orch orchestrate requirements.md

# Inline requirements
orch orchestrate --inline "Add user authentication with JWT"

# Skip approval (for CI/automation)
orch orchestrate --auto-approve requirements.md

# Run multiple agents in parallel
orch orchestrate --max-concurrent 3 requirements.md

# Resume an interrupted session
orch orchestrate --resume
```

### Plan Approval Flow

1. You provide requirements
2. The orchestrator plans and decomposes into tasks
3. A task table is shown with all planned tasks
4. You are prompted: `Approve this plan and start execution? (y/n)`
5. On approval, execution proceeds autonomously
6. On rejection, no tasks are executed

### Performance Metrics

```bash
# Project-level summary (all sessions aggregated)
orch metrics

# List all sessions
orch metrics sessions

# Detailed session view with per-task breakdown
orch metrics session <session-id>

# Per-task metrics for a session
orch metrics tasks <session-id>
```

Metrics tracked per task and per session:
- Cost (USD)
- Input/output tokens
- Tool calls
- Turns (iterations)
- Duration

### Other Commands

```bash
orch task list              # List all tasks
orch task show <id>         # Show task details
orch status                 # Project status overview
orch agent list             # List configured agents
orch context list           # List shared context entries
orch worktree list          # List git worktrees
orch serve                  # Start web dashboard
orch eval run               # Run evaluation scenarios
orch hooks status           # Check hook installation status
```

## Architecture

- **Orchestrator** (`src/core/orchestrator.ts`) — Main pipeline: plan -> approve -> schedule -> execute -> validate
- **Executor** (`src/core/executor.ts`) — Runs a single task on an agent
- **TaskGraph** (`src/task/task-graph.ts`) — DAG-based task scheduling with dependency resolution
- **ClaudeCliRuntime** (`src/agent/runtimes/claude-cli-runtime.ts`) — Spawns Claude CLI subprocesses
- **SessionManager** (`src/core/session-manager.ts`) — Tracks session state for resume capability
- **EventBus** (`src/events/event-bus.ts`) — Pub/sub event system for real-time updates

## Build & Test

```bash
npm run build          # TypeScript compilation
npm run dev            # Watch mode
npx tsc --noEmit       # Type check only
npx vitest run         # Run all tests
npx vitest --watch     # Watch mode tests
```

## Database

SQLite via Drizzle ORM. Database file: `.orchestrator/orchestrator.db`

Key tables: `projects`, `tasks`, `task_dependencies`, `agents`, `events`, `context_entries`, `orchestrator_sessions`, `task_metrics`, `eval_runs`
