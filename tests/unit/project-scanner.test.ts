import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { ProjectScanner } from '../../src/context/project-scanner.js';

const TEST_DIR = '/tmp/orch-test-scanner';

describe('ProjectScanner', () => {
  const scanner = new ProjectScanner();

  beforeEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    mkdirSync(resolve(TEST_DIR, 'src'), { recursive: true });
    mkdirSync(resolve(TEST_DIR, 'tests'), { recursive: true });
  });

  afterEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  });

  it('should detect TypeScript language', () => {
    writeFileSync(resolve(TEST_DIR, 'package.json'), JSON.stringify({ name: 'test' }));
    writeFileSync(resolve(TEST_DIR, 'tsconfig.json'), '{}');

    const result = scanner.scan(TEST_DIR);

    expect(result.language).toBe('TypeScript');
  });

  it('should detect npm package manager', () => {
    writeFileSync(resolve(TEST_DIR, 'package.json'), JSON.stringify({ name: 'test' }));
    writeFileSync(resolve(TEST_DIR, 'package-lock.json'), '{}');

    const result = scanner.scan(TEST_DIR);

    expect(result.packageManager).toBe('npm');
  });

  it('should detect pnpm package manager', () => {
    writeFileSync(resolve(TEST_DIR, 'package.json'), JSON.stringify({ name: 'test' }));
    writeFileSync(resolve(TEST_DIR, 'pnpm-lock.yaml'), '');

    const result = scanner.scan(TEST_DIR);

    expect(result.packageManager).toBe('pnpm');
  });

  it('should detect React framework', () => {
    writeFileSync(resolve(TEST_DIR, 'package.json'), JSON.stringify({
      name: 'test',
      dependencies: { react: '^18.0.0' },
    }));

    const result = scanner.scan(TEST_DIR);

    expect(result.framework).toBe('React');
  });

  it('should detect Next.js framework over plain React', () => {
    writeFileSync(resolve(TEST_DIR, 'package.json'), JSON.stringify({
      name: 'test',
      dependencies: { react: '^18.0.0', next: '^14.0.0' },
    }));

    const result = scanner.scan(TEST_DIR);

    expect(result.framework).toBe('Next.js');
  });

  it('should detect Vitest test framework', () => {
    writeFileSync(resolve(TEST_DIR, 'package.json'), JSON.stringify({
      name: 'test',
      devDependencies: { vitest: '^1.0.0' },
    }));

    const result = scanner.scan(TEST_DIR);

    expect(result.testFramework).toBe('Vitest');
  });

  it('should read scripts from package.json', () => {
    writeFileSync(resolve(TEST_DIR, 'package.json'), JSON.stringify({
      name: 'test',
      scripts: { build: 'tsc', test: 'vitest', lint: 'eslint .' },
    }));

    const result = scanner.scan(TEST_DIR);

    expect(result.scripts.build).toBe('tsc');
    expect(result.scripts.test).toBe('vitest');
    expect(result.scripts.lint).toBe('eslint .');
  });

  it('should list dependencies', () => {
    writeFileSync(resolve(TEST_DIR, 'package.json'), JSON.stringify({
      name: 'test',
      dependencies: { express: '^4.0.0', zod: '^3.0.0' },
    }));

    const result = scanner.scan(TEST_DIR);

    expect(result.dependencies).toContain('express');
    expect(result.dependencies).toContain('zod');
  });

  it('should detect config files', () => {
    writeFileSync(resolve(TEST_DIR, 'package.json'), JSON.stringify({ name: 'test' }));
    writeFileSync(resolve(TEST_DIR, 'tsconfig.json'), '{}');
    writeFileSync(resolve(TEST_DIR, 'Dockerfile'), 'FROM node:18');

    const result = scanner.scan(TEST_DIR);

    expect(result.configFiles).toContain('tsconfig.json');
    expect(result.configFiles).toContain('Dockerfile');
  });

  it('should detect conventions', () => {
    writeFileSync(resolve(TEST_DIR, 'package.json'), JSON.stringify({
      name: 'test',
      type: 'module',
    }));
    writeFileSync(resolve(TEST_DIR, 'CLAUDE.md'), '# Guide');

    const result = scanner.scan(TEST_DIR);

    expect(result.conventions).toContain('ESM modules (type: module)');
    expect(result.conventions).toContain('Source code in src/ directory');
    expect(result.conventions).toContain('Tests in separate directory');
    expect(result.conventions).toContain('Claude Code integration (CLAUDE.md)');
  });

  it('should build directory tree', () => {
    writeFileSync(resolve(TEST_DIR, 'package.json'), JSON.stringify({ name: 'test' }));
    writeFileSync(resolve(TEST_DIR, 'src', 'index.ts'), '');

    const result = scanner.scan(TEST_DIR);

    expect(result.directoryStructure.length).toBeGreaterThan(0);
    const joined = result.directoryStructure.join('\n');
    expect(joined).toContain('src/');
  });

  it('should format scan result as context markdown', () => {
    writeFileSync(resolve(TEST_DIR, 'package.json'), JSON.stringify({
      name: 'my-project',
      type: 'module',
      scripts: { build: 'tsc', test: 'vitest' },
      dependencies: { fastify: '^5.0.0' },
    }));
    writeFileSync(resolve(TEST_DIR, 'tsconfig.json'), '{}');

    const result = scanner.scan(TEST_DIR);
    const formatted = scanner.formatAsContext(result);

    expect(formatted).toContain('Project Overview');
    expect(formatted).toContain('TypeScript');
    expect(formatted).toContain('Directory Structure');
    expect(formatted).toContain('Available Scripts');
    expect(formatted).toContain('Key Dependencies');
  });

  it('should handle project without package.json gracefully', () => {
    const result = scanner.scan(TEST_DIR);

    expect(result.packageManager).toBe('unknown');
    expect(result.language).toBe('unknown');
    expect(result.framework).toBeUndefined();
    expect(result.scripts).toEqual({});
    expect(result.dependencies).toEqual([]);
  });
});
