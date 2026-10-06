/**
 * orch init -- initialize a platform config in the current directory.
 */

import { writeFileSync, existsSync } from 'node:fs';
import { resolve, basename } from 'node:path';
import { generateDefaultConfig } from '../../../platform/config/loader.js';

export async function initCommand(options: { dir?: string }): Promise<void> {
  const dir = resolve(options.dir ?? process.cwd());
  const configPath = resolve(dir, 'platform.config.yaml');

  if (existsSync(configPath)) {
    console.log(`Config already exists: ${configPath}`);
    return;
  }

  // Also check for legacy config
  const legacyPath = resolve(dir, 'orchestrator.config.yaml');
  if (existsSync(legacyPath)) {
    console.log(`Legacy config found: ${legacyPath}`);
    console.log(`Rename it to platform.config.yaml to use the new platform.`);
    return;
  }

  const projectName = basename(dir);
  const content = generateDefaultConfig(projectName);

  writeFileSync(configPath, content, 'utf-8');
  console.log(`Created ${configPath}`);
  console.log(`\nNext steps:`);
  console.log(`  1. Edit platform.config.yaml to configure agents and runtimes`);
  console.log(`  2. Run: orch run "your task description"`);
}
