#!/usr/bin/env node

/**
 * UserPromptSubmit hook for Claude Code orchestrator mode.
 * When orchestrator mode is active (session-active marker exists),
 * injects context to route requests through the autonomous orchestrator pipeline.
 */

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

const cwd = process.cwd();
const markerPath = resolve(cwd, '.orchestrator', 'session-active');

if (existsSync(markerPath)) {
  const ts = Date.now();
  const context = `[ORCHESTRATOR MODE ACTIVE]
Route this request through the orchestrator:
1. Write the user's request as requirements to .orchestrator/requirements-${ts}.md
2. Run: npx orch orchestrate .orchestrator/requirements-${ts}.md
3. The orchestrator will plan tasks, then show the plan and WAIT for user approval via interactive prompt
4. After the user approves (y/n), the orchestrator executes autonomously (scheduling, execution, validation, retries)
5. Show the user the final results summary including metrics (cost, tokens, tool calls, turns)
Do NOT run separate plan/run/status commands. Let the CLI handle the interactive approval prompt.
To skip approval: add --auto-approve flag.`;

  const output = JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'UserPromptSubmit',
      additionalContext: context,
    },
  });

  process.stdout.write(output);
}
