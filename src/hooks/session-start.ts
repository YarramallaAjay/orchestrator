#!/usr/bin/env node

/**
 * SessionStart hook for Claude Code auto-pickup.
 * Checks if orchestrator.config.yaml exists in the current directory.
 * If found, outputs context prompting Claude to offer orchestrator mode.
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
  const message = `[ORCHESTRATOR DETECTED]
This project has an orchestrator configured (${configFound} found).
The orchestrator can decompose requirements into tasks, assign them to agents,
execute in parallel with isolated git worktrees, and validate results.

You MUST ask the user: "This project has an orchestrator configured. Would you
like me to use the orchestrator to manage tasks for this session?"

If the user says yes:
- Create a .orchestrator/session-active marker file with JSON: {"activatedAt":"<ISO timestamp>","config":"orchestrator.config.yaml"}
- For every user request, decompose it using the orchestrator CLI:
  1. Run: npx tsx src/cli/index.ts plan --dry-run (to show the plan)
  2. After user approval, run: npx tsx src/cli/index.ts run --orchestrate
  3. Show status via: npx tsx src/cli/index.ts status
- Always show task progress and results to the user

If the user says no:
- Proceed normally without the orchestrator
- Do NOT create the marker file`;

  process.stdout.write(message);
}
