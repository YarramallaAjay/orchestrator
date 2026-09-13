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
  const context = `[ORCHESTRATOR MODE ACTIVE]
Route this request through the orchestrator autonomously:
1. Write the user's request as requirements to .orchestrator/requirements-${Date.now()}.md
2. Run: npx tsx src/cli/index.ts orchestrate .orchestrator/requirements-${Date.now()}.md
3. The orchestrator will plan, schedule, execute, validate, and retry automatically — do NOT intervene
4. Show the user the final results summary from the command output
Do NOT run separate plan/run/status commands. Do NOT ask the user for approval between steps.`;

  const output = JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'UserPromptSubmit',
      additionalContext: context,
    },
  });

  process.stdout.write(output);
}
