import type { Task } from '../task/types.js';
import type { AgentConfig } from '../agent/types.js';
import type { McpServerConfig } from '../config/types.js';
import type { McpRegistry } from '../mcp/mcp-registry.js';
import { BUILTIN_SKILLS, shouldAssignSkill } from '../skills/index.js';
import { skillToMcpConfig } from '../skills/base-skill.js';
import { logger } from '../util/logger.js';

export interface SkillAssignment {
  mcpServers: Record<string, McpServerConfig>;
  additionalTools: string[];
  guidance: string;
}

/**
 * Analyzes tasks and assigns relevant skills/MCP servers per-task.
 * Uses task tags, target files, and description to determine which skills are needed.
 */
export class SkillAssigner {
  constructor(
    private mcpRegistry?: McpRegistry,
  ) {}

  /**
   * Determine which skills and MCP servers should be assigned to a task.
   */
  assignForTask(task: Task, agentConfig: AgentConfig): SkillAssignment {
    const mcpServers: Record<string, McpServerConfig> = {};
    const additionalTools: string[] = [];
    const guidanceParts: string[] = [];

    // 1. Assign built-in skills based on task analysis
    for (const skill of BUILTIN_SKILLS) {
      if (shouldAssignSkill(skill, task.tags, task.targetFiles)) {
        const config = skillToMcpConfig(skill);
        mcpServers[config.name] = config;

        // Add guidance about the skill
        guidanceParts.push(`- **${skill.name}**: ${skill.description}`);

        logger.debug({
          taskId: task.id,
          skill: skill.name,
          reason: 'tag/file match',
        }, 'Skill assigned to task');
      }
    }

    // 2. Add agent-configured MCP servers
    if (agentConfig.mcpServers?.length) {
      guidanceParts.push('');
      guidanceParts.push('**Agent-configured MCP servers** are also available.');
    }

    // 3. Generate task-specific tool guidance
    const taskGuidance = this.generateToolGuidance(task);
    if (taskGuidance) {
      guidanceParts.push('');
      guidanceParts.push(taskGuidance);
    }

    // Set env vars for skills that need task context
    for (const config of Object.values(mcpServers)) {
      config.env = {
        ...config.env,
        ORCH_AGENT_ID: agentConfig.id,
        ORCH_TASK_ID: task.id,
        ORCH_CWD: '', // Will be set by executor
      };
    }

    const guidance = guidanceParts.length > 0
      ? '## Available Skills & Tools\n\n' + guidanceParts.join('\n')
      : '';

    return { mcpServers, additionalTools, guidance };
  }

  /**
   * Generate tool usage guidance based on task analysis.
   */
  private generateToolGuidance(task: Task): string {
    const hints: string[] = [];

    // Test-related tasks
    if (this.hasTestIndicators(task)) {
      hints.push('This task involves testing. Use `run_tests` to validate your changes and `run_tests_for_file` for targeted test runs.');
    }

    // Tasks that modify many files
    if (task.targetFiles.length > 3) {
      hints.push(`This task touches ${task.targetFiles.length} files. Use \`claim_file\` to prevent conflicts with sibling agents.`);
    }

    // Tasks with dependencies
    if (task.dependsOn.length > 0) {
      hints.push('This task has upstream dependencies. Use `get_discoveries` to see findings from earlier tasks.');
    }

    // Convention/pattern tasks
    if (task.tags.includes('setup') || task.tags.includes('scaffolding')) {
      hints.push('This is a foundational task. Use `publish_discovery` to share patterns and conventions you establish for downstream tasks.');
    }

    if (hints.length === 0) return '';
    return '### Tool Usage Hints\n' + hints.map((h) => `- ${h}`).join('\n');
  }

  private hasTestIndicators(task: Task): boolean {
    const testTags = ['test', 'testing', 'tests', 'qa', 'validation'];
    if (task.tags.some((t) => testTags.includes(t.toLowerCase()))) return true;
    if (task.targetFiles.some((f) => /\.(test|spec)\./i.test(f))) return true;
    if (task.title.toLowerCase().includes('test')) return true;
    return false;
  }
}
