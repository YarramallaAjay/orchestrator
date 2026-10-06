/**
 * Configuration loader.
 *
 * Loads platform.config.yaml (with fallback to orchestrator.config.yaml),
 * validates against the Zod schema, applies defaults.
 */

import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { PlatformConfigSchema, type PlatformConfig } from './schema.js';

const CONFIG_FILENAMES = [
  'platform.config.yaml',
  'platform.config.yml',
  'orchestrator.config.yaml',
  'orchestrator.config.yml',
];

/**
 * Find and load the platform configuration file.
 *
 * Searches the given directory (and parents) for a config file.
 * Returns the parsed and validated config.
 */
export function loadConfig(fromDir: string = process.cwd()): {
  config: PlatformConfig;
  configPath: string;
} {
  const configPath = findConfigFile(fromDir);
  if (!configPath) {
    throw new Error(
      `No platform config found. Run 'orch init' to create one, or create platform.config.yaml manually.`,
    );
  }

  const raw = readFileSync(configPath, 'utf-8');
  const parsed = parseYaml(raw);

  // Resolve rootPath relative to config file location
  const configDir = dirname(configPath);
  if (parsed?.project?.root_path) {
    parsed.project.root_path = resolve(configDir, parsed.project.root_path);
  } else if (parsed?.project) {
    parsed.project.root_path = configDir;
  }

  const result = PlatformConfigSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid platform config at ${configPath}:\n${issues}`);
  }

  return { config: result.data, configPath };
}

/**
 * Find the config file by searching the directory and its parents.
 */
function findConfigFile(fromDir: string): string | null {
  let dir = resolve(fromDir);
  const root = resolve('/');

  while (dir !== root) {
    for (const filename of CONFIG_FILENAMES) {
      const candidate = resolve(dir, filename);
      if (existsSync(candidate)) {
        return candidate;
      }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  return null;
}

/**
 * Generate a default config file content for `orch init`.
 */
export function generateDefaultConfig(projectName: string): string {
  return `# Platform Configuration
# See ARCHITECTURE.md for full schema reference.

project:
  name: ${projectName}

execution:
  max_concurrent: 3
  max_budget_usd: 10.0
  auto_retry: true
  max_retries: 2

# Agents can be defined here or via agent.yaml / .md files
agents: []

# Runtime preferences (ordered by priority, lower = preferred)
# runtimes:
#   - name: claude-code
#     type: claude-code
#     priority: 0
#     capabilities: [file-edit, shell, git, search]
#   - name: openai-api
#     type: api
#     priority: 1
#     capabilities: [text-generation]
#     config:
#       base_url: https://api.openai.com/v1
#       api_key_env: OPENAI_API_KEY
`;
}
