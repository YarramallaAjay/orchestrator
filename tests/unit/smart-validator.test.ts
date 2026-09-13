import { describe, it, expect } from 'vitest';
import { Validator } from '../../src/core/validator.js';
import type { AgentRunResult, AgentMessage } from '../../src/agent/runtimes/runtime.js';
import { TaskStatus, TaskClassification, type Task } from '../../src/task/types.js';

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task_1',
    projectId: 'proj_test',
    parentId: null,
    title: 'Test Task',
    description: 'Test description',
    status: TaskStatus.RUNNING,
    classification: TaskClassification.LOCAL,
    priority: 100,
    dependsOn: [],
    assignedAgentId: null,
    worktreeId: null,
    attempt: 0,
    maxRetries: 2,
    inputContext: {},
    outputArtifacts: {},
    acceptanceCriteria: [],
    validationScript: null,
    tags: [],
    estimatedEffort: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    startedAt: new Date().toISOString(),
    completedAt: null,
    ...overrides,
  };
}

function makeResult(overrides: Partial<AgentRunResult> = {}): AgentRunResult {
  return {
    success: true,
    messages: [
      { role: 'assistant', content: 'Task completed.', timestamp: new Date().toISOString() },
    ],
    outputArtifacts: {},
    totalCostUsd: 0,
    turnsUsed: 1,
    inputTokens: 0,
    outputTokens: 0,
    toolCalls: 0,
    sessionId: null,
    ...overrides,
  };
}

describe('Validator - Smart Features', () => {
  const validator = new Validator();

  it('should pass basic validation for successful agent run', async () => {
    const task = makeTask();
    const result = makeResult();

    const validation = await validator.validate(task, result, '/tmp');

    expect(validation.passed).toBe(true);
    expect(validation.checks.find((c) => c.name === 'agent_execution')?.passed).toBe(true);
  });

  it('should fail when agent execution failed', async () => {
    const task = makeTask();
    const result = makeResult({ success: false, error: 'Process crashed' });

    const validation = await validator.validate(task, result, '/tmp');

    expect(validation.passed).toBe(false);
    const check = validation.checks.find((c) => c.name === 'agent_execution');
    expect(check?.passed).toBe(false);
    expect(check?.output).toContain('Process crashed');
  });

  it('should extract modified files from tool_use messages', async () => {
    const task = makeTask();
    const result = makeResult({
      messages: [
        {
          role: 'assistant',
          content: '[Tool: Write]',
          toolUse: { name: 'Write', input: { file_path: '/tmp/test.ts' } },
          timestamp: new Date().toISOString(),
        },
        {
          role: 'assistant',
          content: '[Tool: Edit]',
          toolUse: { name: 'Edit', input: { file_path: '/tmp/other.js' } },
          timestamp: new Date().toISOString(),
        },
        { role: 'assistant', content: 'Done.', timestamp: new Date().toISOString() },
      ],
    });

    // The validator internally calls extractModifiedFiles
    // Since /tmp has no tsconfig.json or eslint config, these checks won't run,
    // but the basic validation should still pass
    const validation = await validator.validate(task, result, '/tmp');

    expect(validation.passed).toBe(true);
    // No typescript_typecheck or eslint checks should appear (no configs in /tmp)
    expect(validation.checks.find((c) => c.name === 'typescript_typecheck')).toBeUndefined();
    expect(validation.checks.find((c) => c.name === 'eslint')).toBeUndefined();
  });

  it('should run validation script when specified', async () => {
    const task = makeTask({ validationScript: 'echo "validation passed"' });
    const result = makeResult();

    const validation = await validator.validate(task, result, '/tmp');

    expect(validation.passed).toBe(true);
    const scriptCheck = validation.checks.find((c) => c.name === 'validation_script');
    expect(scriptCheck?.passed).toBe(true);
  });

  it('should fail on validation script failure', async () => {
    const task = makeTask({ validationScript: 'exit 1' });
    const result = makeResult();

    const validation = await validator.validate(task, result, '/tmp');

    expect(validation.passed).toBe(false);
    const scriptCheck = validation.checks.find((c) => c.name === 'validation_script');
    expect(scriptCheck?.passed).toBe(false);
  });

  it('should check acceptance criteria presence', async () => {
    const task = makeTask({ acceptanceCriteria: ['Must handle errors'] });
    const result = makeResult({
      messages: [
        { role: 'assistant', content: 'Implemented error handling.', timestamp: new Date().toISOString() },
      ],
    });

    const validation = await validator.validate(task, result, '/tmp');

    const criteriaCheck = validation.checks.find((c) => c.name === 'acceptance_criteria');
    expect(criteriaCheck?.passed).toBe(true);
  });

  it('should fail acceptance criteria when no output produced', async () => {
    const task = makeTask({ acceptanceCriteria: ['Must handle errors'] });
    const result = makeResult({ messages: [] });

    const validation = await validator.validate(task, result, '/tmp');

    const criteriaCheck = validation.checks.find((c) => c.name === 'acceptance_criteria');
    expect(criteriaCheck?.passed).toBe(false);
  });

  it('should build feedback prompt from failed checks', () => {
    const task = makeTask({
      title: 'Fix bugs',
      description: 'Fix all the bugs',
      acceptanceCriteria: ['No errors in logs'],
    });

    const validation = {
      passed: false,
      checks: [
        { name: 'agent_execution', passed: true, output: 'OK' },
        { name: 'validation_script', passed: false, output: 'Tests failed: 3 errors' },
      ],
    };

    const feedback = validator.buildFeedback(task, validation);

    expect(feedback).toContain('Fix bugs');
    expect(feedback).toContain('validation_script');
    expect(feedback).toContain('Tests failed: 3 errors');
    expect(feedback).toContain('No errors in logs');
  });

  it('should return empty feedback when all checks pass', () => {
    const task = makeTask();
    const validation = {
      passed: true,
      checks: [
        { name: 'agent_execution', passed: true, output: 'OK' },
      ],
    };

    const feedback = validator.buildFeedback(task, validation);

    expect(feedback).toBe('');
  });
});
