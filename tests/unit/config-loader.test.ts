import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadConfig, configExists } from '../../src/config/loader.js';

const TEST_DIR = '/tmp/orch-config-test';

describe('Config Loader', () => {
  beforeEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  });

  it('should load a valid config', () => {
    writeFileSync(resolve(TEST_DIR, 'orchestrator.config.yaml'), `
project:
  name: test-project
  rootPath: .
orchestrator:
  maxConcurrentAgents: 5
  maxTotalBudgetUsd: 20.0
database:
  path: .orchestrator/data.db
agents:
  templates: []
mcp:
  servers: []
git:
  integrationBranch: main
web:
  port: 4000
`);

    const config = loadConfig(TEST_DIR);
    expect(config.project.name).toBe('test-project');
    expect(config.orchestrator.maxConcurrentAgents).toBe(5);
    expect(config.web.port).toBe(4000);
  });

  it('should apply defaults for missing optional fields', () => {
    writeFileSync(resolve(TEST_DIR, 'orchestrator.config.yaml'), `
project:
  name: minimal
`);

    const config = loadConfig(TEST_DIR);
    expect(config.orchestrator.maxConcurrentAgents).toBe(3);
    expect(config.orchestrator.autoRetry).toBe(true);
    expect(config.database.path).toBe('.orchestrator/data.db');
  });

  it('should interpolate environment variables', () => {
    process.env.TEST_DB_PATH = '/custom/path.db';

    writeFileSync(resolve(TEST_DIR, 'orchestrator.config.yaml'), `
project:
  name: env-test
database:
  path: "\${TEST_DB_PATH}"
`);

    const config = loadConfig(TEST_DIR);
    expect(config.database.path).toBe('/custom/path.db');

    delete process.env.TEST_DB_PATH;
  });

  it('should throw when config file is missing', () => {
    expect(() => loadConfig(TEST_DIR)).toThrow('Config file not found');
  });

  it('should detect config existence', () => {
    expect(configExists(TEST_DIR)).toBe(false);

    writeFileSync(resolve(TEST_DIR, 'orchestrator.config.yaml'), 'project:\n  name: x');
    expect(configExists(TEST_DIR)).toBe(true);
  });
});
