#!/usr/bin/env node

/**
 * SessionStart hook for Claude Code auto-pickup.
 * Checks if orchestrator.config.yaml exists in the current directory.
 * If found, outputs context instructing Claude to operate in orchestrator mode.
 */

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

const cwd = process.cwd();
const configPaths = [
  resolve(cwd, 'orchestrator.config.yaml'),
  resolve(cwd, 'orchestrator.config.yml'),
];

const configFound = configPaths.find((p) => existsSync(p));

if (configFound) {
  const message = `[ORCHESTRATOR AVAILABLE]
This project has an orchestrator configured (${configFound} found).
The orchestrator autonomously decomposes requirements into tasks, assigns them to
agents, executes in parallel with isolated git worktrees, validates results, and
retries failures — all without user intervention.

You MUST ask the user: "This project has an orchestrator configured. Would you
like me to use the orchestrator to manage tasks for this session?"

If the user says yes:
- Create a .orchestrator/session-active marker file with JSON: {"activatedAt":"${new Date().toISOString()}","config":"orchestrator.config.yaml"}
- For EVERY user request from this point forward, route it through the orchestrator:
  1. Write the user's request to .orchestrator/requirements-<timestamp>.md
  2. Run: npx tsx src/cli/index.ts orchestrate .orchestrator/requirements-<timestamp>.md
  3. The orchestrator handles EVERYTHING autonomously (planning, scheduling, execution, validation, retries)
  4. Show the user the final results summary from the command output
- Do NOT run plan/run/status as separate commands. The "orchestrate" command is the single entry point.
- Do NOT ask the user for approval between planning and execution — the orchestrator handles it.

If the user says no:
- Proceed normally without the orchestrator
- Do NOT create the marker file`;

  process.stdout.write(message);
}
