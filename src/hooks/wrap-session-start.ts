#!/usr/bin/env node

/**
 * SessionStart hook for `orch wrap` mode.
 * Reads pre-computed context from .orchestrator/.wrap-context.json
 * and outputs it as session context for the wrapped Claude Code instance.
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Skip when running inside an orchestrator agent subprocess
if (process.env.ORCH_AGENT_MODE === '1') {
  process.exit(0);
}

// Only run in wrap mode
if (process.env.ORCH_WRAP_MODE !== '1') {
  process.exit(0);
}

const cwd = process.cwd();
const contextFile = resolve(cwd, '.orchestrator', '.wrap-context.json');

if (!existsSync(contextFile)) {
  process.exit(0);
}

try {
  const data = JSON.parse(readFileSync(contextFile, 'utf-8'));
  const parts: string[] = [];

  parts.push('[ORCHESTRATOR WRAP MODE]');
  parts.push('This session is enhanced by the orchestrator with shared context, memory, and tools.\n');

  if (data.projectContext) {
    parts.push('## Project Context');
    parts.push(data.projectContext);
    parts.push('');
  }

  if (data.sharedContext) {
    parts.push('## Shared Knowledge');
    parts.push(data.sharedContext);
    parts.push('');
  }

  if (data.observations) {
    parts.push('## Previous Observations');
    parts.push(data.observations);
    parts.push('');
  }

  if (data.memory) {
    parts.push(data.memory);
    parts.push('');
  }

  parts.push('## Available MCP Tools');
  parts.push('You have access to orchestrator tools via the orch-tools MCP server:');
  parts.push('- **publish_observation**: Share findings (conventions, patterns, warnings) for future sessions');
  parts.push('- **get_observations**: Read observations from current and past sessions');
  parts.push('- **store_memory**: Persist important knowledge across sessions');
  parts.push('- **recall_memory**: Retrieve past knowledge by category or keyword');
  parts.push('- **get_project_context**: Read the full project context snapshot');
  parts.push('');
  parts.push('Use these tools proactively to build up project knowledge over time.');

  process.stdout.write(parts.join('\n'));
} catch {
  // Silently fail — don't break the session
  process.exit(0);
}
