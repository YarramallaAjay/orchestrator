#!/usr/bin/env node

/**
 * SessionStart hook for Claude Code auto-pickup.
 * Checks if orchestrator.config.yaml exists in the current directory.
 * If found, outputs context instructing Claude to operate in orchestrator mode.
 */

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

// Skip when running inside an orchestrator agent subprocess
if (process.env.ORCH_AGENT_MODE === '1') {
  process.exit(0);
}

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
retries failures.

You MUST ask the user: "This project has an orchestrator configured. Would you
like me to use the orchestrator to manage tasks for this session?"

If the user says yes:
- Create a .orchestrator/session-active marker file with JSON: {"activatedAt":"${new Date().toISOString()}","config":"orchestrator.config.yaml"}
- For EVERY user request from this point forward, route it through the orchestrator:
  1. Write the user's request to .orchestrator/requirements-<timestamp>.md
  2. Run: npx orch orchestrate .orchestrator/requirements-<timestamp>.md
  3. The orchestrator will plan the tasks and then WAIT for user approval before executing
  4. The CLI will show the task plan and prompt "Approve this plan? (y/n)" — let this run interactively
  5. After approval, the orchestrator executes autonomously (scheduling, execution, validation, retries)
  6. Show the user the final results summary including metrics (cost, tokens, tool calls, turns)
- Do NOT run plan/run/status as separate commands. The "orchestrate" command is the single entry point.
- To skip approval for automated workflows, use: --auto-approve flag
- To view performance metrics: npx orch metrics
- To view session details: npx orch metrics sessions

If the user says no:
- Proceed normally without the orchestrator
- Do NOT create the marker file`;

  process.stdout.write(message);
}
