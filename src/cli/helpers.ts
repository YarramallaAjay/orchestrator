import { resolve } from 'node:path';
import { loadConfig, configExists } from '../config/loader.js';
import { createDb, initializeDb } from '../db/connection.js';
import type { Db } from '../db/connection.js';
import type { ProjectConfig } from '../config/types.js';
import { projects } from '../db/schema.js';
import { ConfigError } from '../util/errors.js';

export interface ProjectContext {
  config: ProjectConfig;
  db: Db;
  projectId: string;
  rootPath: string;
}

/**
 * Load the project context (config, db, projectId) from the current directory.
 * Throws if not initialized.
 */
export function loadProjectContext(cwd: string = process.cwd()): ProjectContext {
  if (!configExists(cwd)) {
    throw new ConfigError(
      `No orchestrator project found in ${cwd}. Run 'orch init' first.`,
    );
  }

  const config = loadConfig(cwd);
  const dbPath = resolve(cwd, config.database.path);
  const db = createDb(dbPath);

  // Get the project ID from the database
  const rows = db.select().from(projects).all();
  const project = rows[0];
  if (!project) {
    throw new ConfigError('Project record not found in database. Re-run init.');
  }

  return {
    config,
    db,
    projectId: project.id,
    rootPath: resolve(cwd),
  };
}
