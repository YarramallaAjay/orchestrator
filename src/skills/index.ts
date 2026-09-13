import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { SkillConfig } from './base-skill.js';
import { skillToMcpConfig } from './base-skill.js';
import type { McpServerConfig } from '../config/types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Registry of all built-in skills.
 */
export const BUILTIN_SKILLS: SkillConfig[] = [
  {
    name: 'shared-context',
    description: 'Inter-agent communication: publish discoveries, claim files, read sibling findings',
    entryPoint: resolve(__dirname, 'shared-context/server.js'),
    defaultEnabled: true,
    triggerTags: [],  // Always attached
    triggerFilePatterns: [],
  },
  {
    name: 'test-runner',
    description: 'Run tests, check test status, run tests for specific files',
    entryPoint: resolve(__dirname, 'test-runner/server.js'),
    defaultEnabled: true,
    triggerTags: ['test', 'testing', 'tests', 'qa'],
    triggerFilePatterns: ['*.test.*', '*.spec.*', '*_test.*', 'test_*'],
  },
];

/**
 * Get MCP server configs for enabled built-in skills.
 */
export function getBuiltinSkillConfigs(options?: {
  enabledSkills?: string[];
  disabledSkills?: string[];
}): McpServerConfig[] {
  return BUILTIN_SKILLS
    .filter((skill) => {
      if (options?.disabledSkills?.includes(skill.name)) return false;
      if (options?.enabledSkills) return options.enabledSkills.includes(skill.name);
      return skill.defaultEnabled;
    })
    .map(skillToMcpConfig);
}

/**
 * Get a specific skill config by name.
 */
export function getSkillByName(name: string): SkillConfig | undefined {
  return BUILTIN_SKILLS.find((s) => s.name === name);
}

/**
 * Check if a skill should be assigned based on task tags and target files.
 */
export function shouldAssignSkill(
  skill: SkillConfig,
  taskTags: string[],
  targetFiles: string[],
): boolean {
  // Skills with no trigger tags are assigned to all tasks (like shared-context)
  if (skill.triggerTags.length === 0 && skill.triggerFilePatterns.length === 0) {
    return true;
  }

  // Check tag match
  for (const tag of taskTags) {
    if (skill.triggerTags.includes(tag.toLowerCase())) {
      return true;
    }
  }

  // Check file pattern match
  for (const file of targetFiles) {
    for (const pattern of skill.triggerFilePatterns) {
      if (matchesPattern(file, pattern)) {
        return true;
      }
    }
  }

  return false;
}

/**
 * Simple glob-like pattern matching for file names.
 */
function matchesPattern(filePath: string, pattern: string): boolean {
  // Convert glob to regex
  const regexStr = pattern
    .replace(/\./g, '\\.')
    .replace(/\*/g, '.*');
  const regex = new RegExp(regexStr);
  return regex.test(filePath);
}
