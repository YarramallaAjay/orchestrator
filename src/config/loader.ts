import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { ProjectConfigSchema, type ProjectConfig } from './types.js';
import { CONFIG_FILENAME } from './defaults.js';
import { ConfigError } from '../util/errors.js';

/**
 * Interpolate ${VAR} references with environment variables.
 */
function interpolateEnv(value: string): string {
  return value.replace(/\$\{(\w+)\}/g, (_match, varName: string) => {
    return process.env[varName] ?? '';
  });
}

/**
 * Recursively walk an object and interpolate all string values.
 */
function interpolateDeep(obj: unknown): unknown {
  if (typeof obj === 'string') {
    return interpolateEnv(obj);
  }
  if (Array.isArray(obj)) {
    return obj.map(interpolateDeep);
  }
  if (obj !== null && typeof obj === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      result[key] = interpolateDeep(value);
    }
    return result;
  }
  return obj;
}

export function loadConfig(cwd: string): ProjectConfig {
  const configPath = resolve(cwd, CONFIG_FILENAME);

  if (!existsSync(configPath)) {
    throw new ConfigError(`Config file not found: ${configPath}. Run 'orch init' first.`);
  }

  const raw = readFileSync(configPath, 'utf-8');
  const parsed = parseYaml(raw);
  const interpolated = interpolateDeep(parsed);

  const result = ProjectConfigSchema.safeParse(interpolated);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new ConfigError(`Invalid configuration:\n${issues}`);
  }

  return result.data;
}

export function configExists(cwd: string): boolean {
  return existsSync(resolve(cwd, CONFIG_FILENAME));
}
