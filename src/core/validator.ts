import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import type { Task } from '../task/types.js';
import type { AgentRunResult } from '../agent/runtimes/runtime.js';
import { logger } from '../util/logger.js';

const execFileAsync = promisify(execFile);

export interface ValidationCheck {
  name: string;
  passed: boolean;
  output: string;
}

export interface ValidationResult {
  passed: boolean;
  checks: ValidationCheck[];
}

/**
 * Validates task output against acceptance criteria and validation scripts.
 * Implements the Inspect->Test->Evaluate portion of the execution loop.
 */
export class Validator {
  /**
   * Run all validation checks on task output.
   */
  async validate(task: Task, result: AgentRunResult, cwd: string): Promise<ValidationResult> {
    const checks: ValidationCheck[] = [];

    // Check 1: Agent execution success
    checks.push({
      name: 'agent_execution',
      passed: result.success,
      output: result.success ? 'Agent completed successfully' : (result.error ?? 'Agent failed'),
    });

    // Check 2: Run validation script if defined
    if (task.validationScript) {
      const scriptResult = await this.runValidationScript(task.validationScript, cwd);
      checks.push(scriptResult);
    }

    // Check 3: TypeScript type check (if modified files include .ts/.tsx)
    const modifiedFiles = this.extractModifiedFiles(result);
    const hasTsFiles = modifiedFiles.some((f) => /\.tsx?$/.test(f));
    if (hasTsFiles && existsSync(resolve(cwd, 'tsconfig.json'))) {
      const tscCheck = await this.runValidationScript('npx tsc --noEmit', cwd);
      tscCheck.name = 'typescript_typecheck';
      checks.push(tscCheck);
    }

    // Check 4: ESLint (if eslint config exists and files were modified)
    if (modifiedFiles.length > 0 && this.hasEslintConfig(cwd)) {
      const eslintFiles = modifiedFiles.filter((f) => /\.(ts|tsx|js|jsx|mjs|cjs)$/.test(f));
      if (eslintFiles.length > 0) {
        const eslintCmd = `npx eslint ${eslintFiles.map((f) => `"${f}"`).join(' ')}`;
        const eslintCheck = await this.runValidationScript(eslintCmd, cwd);
        eslintCheck.name = 'eslint';
        checks.push(eslintCheck);
      }
    }

    // Check 5: Acceptance criteria (basic presence check in output)
    if (task.acceptanceCriteria.length > 0) {
      const criteriaCheck = this.checkAcceptanceCriteria(task, result);
      checks.push(criteriaCheck);
    }

    const passed = checks.every((c) => c.passed);

    logger.info({
      taskId: task.id,
      passed,
      checks: checks.map((c) => ({ name: c.name, passed: c.passed })),
    }, 'Validation complete');

    return { passed, checks };
  }

  /**
   * Build a feedback prompt from validation failures for retry.
   */
  buildFeedback(task: Task, validation: ValidationResult): string {
    const failedChecks = validation.checks.filter((c) => !c.passed);
    if (failedChecks.length === 0) return '';

    const lines = [
      `The previous attempt for task "${task.title}" failed validation.`,
      '',
      'Failed checks:',
    ];

    for (const check of failedChecks) {
      lines.push(`- ${check.name}: ${check.output}`);
    }

    lines.push('');
    lines.push('Please fix the issues and try again. The original task description was:');
    lines.push(task.description);

    if (task.acceptanceCriteria.length > 0) {
      lines.push('');
      lines.push('Acceptance criteria:');
      for (const criterion of task.acceptanceCriteria) {
        lines.push(`- ${criterion}`);
      }
    }

    return lines.join('\n');
  }

  private async runValidationScript(script: string, cwd: string): Promise<ValidationCheck> {
    try {
      const { stdout, stderr } = await execFileAsync('sh', ['-c', script], {
        cwd,
        timeout: 120_000, // 2 minute timeout
      });

      return {
        name: 'validation_script',
        passed: true,
        output: (stdout + stderr).trim() || 'Passed',
      };
    } catch (error: any) {
      return {
        name: 'validation_script',
        passed: false,
        output: error.stderr || error.stdout || error.message || 'Script failed',
      };
    }
  }

  /**
   * Extract file paths from Write/Edit tool_use calls in agent messages.
   */
  private extractModifiedFiles(result: AgentRunResult): string[] {
    const files = new Set<string>();
    for (const msg of result.messages) {
      if (msg.toolUse) {
        const name = msg.toolUse.name.toLowerCase();
        if (name === 'write' || name === 'edit') {
          const filePath = (msg.toolUse.input as any)?.file_path ?? (msg.toolUse.input as any)?.path;
          if (typeof filePath === 'string') {
            files.add(filePath);
          }
        }
      }
    }
    return [...files];
  }

  private hasEslintConfig(cwd: string): boolean {
    const configNames = [
      'eslint.config.js', 'eslint.config.mjs', 'eslint.config.cjs',
      'eslint.config.ts', 'eslint.config.mts',
      '.eslintrc.js', '.eslintrc.cjs', '.eslintrc.json', '.eslintrc.yml', '.eslintrc.yaml', '.eslintrc',
    ];
    return configNames.some((name) => existsSync(resolve(cwd, name)));
  }

  private checkAcceptanceCriteria(task: Task, result: AgentRunResult): ValidationCheck {
    // Basic check: at minimum, the agent should have produced some output
    const hasOutput = result.messages.some(
      (m) => m.role === 'assistant' && m.content.length > 0,
    );

    return {
      name: 'acceptance_criteria',
      passed: hasOutput,
      output: hasOutput
        ? `Agent produced output. ${task.acceptanceCriteria.length} criteria defined.`
        : 'No meaningful output produced by agent',
    };
  }
}
