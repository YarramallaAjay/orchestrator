import type { McpServerConfig } from '../config/types.js';

/**
 * Base configuration for a built-in skill (MCP server).
 * Each skill is launched as a separate process and connects via stdio.
 */
export interface SkillConfig {
  name: string;
  description: string;
  /** The script entry point for this skill's MCP server. */
  entryPoint: string;
  /** Whether this skill is enabled by default. */
  defaultEnabled: boolean;
  /** Tags that trigger auto-assignment (e.g., 'test' -> test-runner). */
  triggerTags: string[];
  /** File patterns that trigger auto-assignment (e.g., '*.test.ts' -> test-runner). */
  triggerFilePatterns: string[];
}

/**
 * Convert a SkillConfig into an McpServerConfig for passing to runtimes.
 */
export function skillToMcpConfig(skill: SkillConfig): McpServerConfig {
  return {
    name: `skill:${skill.name}`,
    type: 'stdio',
    command: 'node',
    args: [skill.entryPoint],
    env: {},
    autoStart: false,
  };
}
