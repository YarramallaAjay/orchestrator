#!/usr/bin/env node

/**
 * UserPromptSubmit hook for Claude Code orchestrator mode.
 * When orchestrator mode is active (session-active marker exists),
 * injects additional context to route requests through the orchestrator.
 */

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

const cwd = process.cwd();
const markerPath = resolve(cwd, '.orchestrator', 'session-active');

if (existsSync(markerPath)) {
  const context = `[ORCHESTRATOR MODE ACTIVE]
Route this request through the orchestrator:
1. Use 'npx tsx src/cli/index.ts plan <requirements-file>' to decompose the request into tasks
2. Show the task plan to the user
3. On approval, use 'npx tsx src/cli/index.ts run --orchestrate' to execute
4. Monitor with 'npx tsx src/cli/index.ts status' and report results`;

  const output = JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'UserPromptSubmit',
      additionalContext: context,
    },
  });

  process.stdout.write(output);
}
