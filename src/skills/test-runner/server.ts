#!/usr/bin/env node

/**
 * Test Runner MCP Server
 *
 * Auto-detects the project's test framework and provides tools to run tests.
 *
 * Tools:
 * - run_tests: Run the full test suite
 * - run_tests_for_file: Run tests for a specific file
 * - get_test_status: Check if tests are passing
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

const cwd = process.env.ORCH_CWD ?? process.cwd();

function detectTestFramework(): { name: string; runCmd: string; fileCmd: (file: string) => string } | null {
  // Check for vitest
  if (existsSync(resolve(cwd, 'node_modules/.bin/vitest'))) {
    return {
      name: 'vitest',
      runCmd: 'npx vitest run',
      fileCmd: (file) => `npx vitest run ${file}`,
    };
  }
  // Check for jest
  if (existsSync(resolve(cwd, 'node_modules/.bin/jest'))) {
    return {
      name: 'jest',
      runCmd: 'npx jest',
      fileCmd: (file) => `npx jest ${file}`,
    };
  }
  // Check for pytest
  if (existsSync(resolve(cwd, 'pytest.ini')) || existsSync(resolve(cwd, 'conftest.py'))) {
    return {
      name: 'pytest',
      runCmd: 'pytest',
      fileCmd: (file) => `pytest ${file}`,
    };
  }
  // Check for go test
  if (existsSync(resolve(cwd, 'go.mod'))) {
    return {
      name: 'go test',
      runCmd: 'go test ./...',
      fileCmd: (file) => `go test ./${file}`,
    };
  }
  return null;
}

function runCommand(cmd: string): { success: boolean; output: string } {
  try {
    const output = execSync(cmd, {
      cwd,
      encoding: 'utf-8',
      timeout: 120_000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return { success: true, output };
  } catch (err: any) {
    const output = (err.stdout ?? '') + '\n' + (err.stderr ?? '');
    return { success: false, output: output.trim() };
  }
}

const server = new McpServer(
  { name: 'orch-test-runner', version: '1.0.0' },
  { capabilities: { tools: {} } },
);

server.tool(
  'run_tests',
  'Run the full test suite. Returns test output and pass/fail status.',
  {},
  async () => {
    const framework = detectTestFramework();
    if (!framework) {
      return {
        content: [{ type: 'text' as const, text: 'No test framework detected in this project.' }],
      };
    }

    const result = runCommand(framework.runCmd);
    const status = result.success ? 'PASSED' : 'FAILED';
    const truncated = result.output.length > 5000
      ? result.output.slice(-5000) + '\n... (output truncated)'
      : result.output;

    return {
      content: [{
        type: 'text' as const,
        text: `Test framework: ${framework.name}\nStatus: ${status}\n\n${truncated}`,
      }],
    };
  },
);

server.tool(
  'run_tests_for_file',
  'Run tests for a specific file or pattern.',
  {
    file: z.string().describe('Test file path or pattern'),
  },
  async ({ file }) => {
    const framework = detectTestFramework();
    if (!framework) {
      return {
        content: [{ type: 'text' as const, text: 'No test framework detected in this project.' }],
      };
    }

    const result = runCommand(framework.fileCmd(file));
    const status = result.success ? 'PASSED' : 'FAILED';
    const truncated = result.output.length > 5000
      ? result.output.slice(-5000) + '\n... (output truncated)'
      : result.output;

    return {
      content: [{
        type: 'text' as const,
        text: `Tests for ${file}: ${status}\n\n${truncated}`,
      }],
    };
  },
);

server.tool(
  'get_test_status',
  'Quick check if the test suite is currently passing (runs tests silently).',
  {},
  async () => {
    const framework = detectTestFramework();
    if (!framework) {
      return {
        content: [{ type: 'text' as const, text: 'No test framework detected.' }],
      };
    }

    const result = runCommand(framework.runCmd);
    return {
      content: [{
        type: 'text' as const,
        text: result.success ? 'All tests passing.' : 'Tests are FAILING. Run run_tests for details.',
      }],
    };
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
