#!/usr/bin/env node

/**
 * UserPromptSubmit hook for `orch wrap` mode.
 * Reads live state from .orchestrator/.wrap-state/ directory
 * and injects updated observations/context as additional context.
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
const stateDir = resolve(cwd, '.orchestrator', '.wrap-state');
const observationsFile = resolve(stateDir, 'observations.json');

// Check if there are new observations from this session
if (!existsSync(observationsFile)) {
  process.exit(0);
}

try {
  const observations = JSON.parse(readFileSync(observationsFile, 'utf-8'));

  if (!Array.isArray(observations) || observations.length === 0) {
    process.exit(0);
  }

  // Only inject if there are recent observations (from last 5 minutes)
  const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
  const recent = observations.filter(
    (o: any) => o.timestamp && o.timestamp > fiveMinAgo,
  );

  if (recent.length === 0) {
    process.exit(0);
  }

  const context = [
    '[LIVE SESSION CONTEXT]',
    `${recent.length} observation(s) from this session:`,
    ...recent.map((o: any) => `- [${o.type}] ${o.summary}: ${o.details}`),
  ].join('\n');

  const output = JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'UserPromptSubmit',
      additionalContext: context,
    },
  });

  process.stdout.write(output);
} catch {
  // Silently fail
  process.exit(0);
}
