import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, relative, basename } from 'node:path';

export interface ProjectScanResult {
  name: string;
  packageManager: string;
  language: string;
  framework?: string;
  buildTool?: string;
  testFramework?: string;
  directoryStructure: string[];
  scripts: Record<string, string>;
  dependencies: string[];
  configFiles: string[];
  conventions: string[];
}

/**
 * Scans a project root to detect language, framework, package manager,
 * directory structure, scripts, and conventions.
 */
export class ProjectScanner {
  scan(rootPath: string): ProjectScanResult {
    const name = basename(rootPath);
    const packageManager = this.detectPackageManager(rootPath);
    const language = this.detectLanguage(rootPath);
    const framework = this.detectFramework(rootPath);
    const buildTool = this.detectBuildTool(rootPath);
    const testFramework = this.detectTestFramework(rootPath);
    const directoryStructure = this.getDirectoryTree(rootPath, 2);
    const scripts = this.getScripts(rootPath);
    const dependencies = this.getDependencies(rootPath);
    const configFiles = this.getConfigFiles(rootPath);
    const conventions = this.detectConventions(rootPath);

    return {
      name,
      packageManager,
      language,
      framework,
      buildTool,
      testFramework,
      directoryStructure,
      scripts,
      dependencies,
      configFiles,
      conventions,
    };
  }

  formatAsContext(scan: ProjectScanResult): string {
    const lines: string[] = [
      `## Project Overview: ${scan.name}`,
      '',
      `- **Language**: ${scan.language}`,
      `- **Package Manager**: ${scan.packageManager}`,
    ];

    if (scan.framework) lines.push(`- **Framework**: ${scan.framework}`);
    if (scan.buildTool) lines.push(`- **Build Tool**: ${scan.buildTool}`);
    if (scan.testFramework) lines.push(`- **Test Framework**: ${scan.testFramework}`);

    lines.push('');
    lines.push('### Directory Structure');
    lines.push('```');
    for (const entry of scan.directoryStructure) {
      lines.push(entry);
    }
    lines.push('```');

    if (Object.keys(scan.scripts).length > 0) {
      lines.push('');
      lines.push('### Available Scripts');
      for (const [name, cmd] of Object.entries(scan.scripts)) {
        lines.push(`- \`${name}\`: ${cmd}`);
      }
    }

    if (scan.dependencies.length > 0) {
      lines.push('');
      lines.push('### Key Dependencies');
      lines.push(scan.dependencies.join(', '));
    }

    if (scan.configFiles.length > 0) {
      lines.push('');
      lines.push('### Config Files');
      lines.push(scan.configFiles.join(', '));
    }

    if (scan.conventions.length > 0) {
      lines.push('');
      lines.push('### Conventions');
      for (const conv of scan.conventions) {
        lines.push(`- ${conv}`);
      }
    }

    return lines.join('\n');
  }

  private detectPackageManager(root: string): string {
    if (existsSync(resolve(root, 'pnpm-lock.yaml'))) return 'pnpm';
    if (existsSync(resolve(root, 'yarn.lock'))) return 'yarn';
    if (existsSync(resolve(root, 'bun.lockb')) || existsSync(resolve(root, 'bun.lock'))) return 'bun';
    if (existsSync(resolve(root, 'package-lock.json'))) return 'npm';
    if (existsSync(resolve(root, 'Cargo.toml'))) return 'cargo';
    if (existsSync(resolve(root, 'go.mod'))) return 'go modules';
    if (existsSync(resolve(root, 'requirements.txt')) || existsSync(resolve(root, 'pyproject.toml'))) return 'pip/poetry';
    return 'unknown';
  }

  private detectLanguage(root: string): string {
    if (existsSync(resolve(root, 'tsconfig.json'))) return 'TypeScript';
    if (existsSync(resolve(root, 'package.json'))) return 'JavaScript';
    if (existsSync(resolve(root, 'Cargo.toml'))) return 'Rust';
    if (existsSync(resolve(root, 'go.mod'))) return 'Go';
    if (existsSync(resolve(root, 'pyproject.toml')) || existsSync(resolve(root, 'setup.py'))) return 'Python';
    if (existsSync(resolve(root, 'pom.xml')) || existsSync(resolve(root, 'build.gradle'))) return 'Java';
    return 'unknown';
  }

  private detectFramework(root: string): string | undefined {
    const pkg = this.readPackageJson(root);
    if (!pkg) return undefined;

    const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };
    if (allDeps['next']) return 'Next.js';
    if (allDeps['nuxt']) return 'Nuxt';
    if (allDeps['@angular/core']) return 'Angular';
    if (allDeps['svelte'] || allDeps['@sveltejs/kit']) return 'Svelte/SvelteKit';
    if (allDeps['vue']) return 'Vue';
    if (allDeps['react']) return 'React';
    if (allDeps['express']) return 'Express';
    if (allDeps['fastify']) return 'Fastify';
    if (allDeps['hono']) return 'Hono';
    if (allDeps['nestjs'] || allDeps['@nestjs/core']) return 'NestJS';
    return undefined;
  }

  private detectBuildTool(root: string): string | undefined {
    const pkg = this.readPackageJson(root);
    const allDeps = { ...pkg?.dependencies, ...pkg?.devDependencies };

    if (allDeps['vite']) return 'Vite';
    if (allDeps['webpack']) return 'Webpack';
    if (allDeps['esbuild']) return 'esbuild';
    if (allDeps['rollup']) return 'Rollup';
    if (allDeps['turbo']) return 'Turborepo';
    if (existsSync(resolve(root, 'tsconfig.json')) && pkg?.scripts?.build?.includes('tsc')) return 'tsc';
    return undefined;
  }

  private detectTestFramework(root: string): string | undefined {
    const pkg = this.readPackageJson(root);
    const allDeps = { ...pkg?.dependencies, ...pkg?.devDependencies };

    if (allDeps['vitest']) return 'Vitest';
    if (allDeps['jest']) return 'Jest';
    if (allDeps['mocha']) return 'Mocha';
    if (allDeps['@playwright/test']) return 'Playwright';
    if (allDeps['cypress']) return 'Cypress';
    if (existsSync(resolve(root, 'pytest.ini')) || existsSync(resolve(root, 'conftest.py'))) return 'pytest';
    return undefined;
  }

  private getDirectoryTree(root: string, maxDepth: number, prefix = '', depth = 0): string[] {
    if (depth >= maxDepth) return [];

    const entries: string[] = [];
    const ignoreDirs = new Set([
      'node_modules', '.git', 'dist', 'build', '.next', '.nuxt',
      '.cache', 'coverage', '.orchestrator', '__pycache__', '.venv',
      'target', 'vendor',
    ]);

    try {
      const items = readdirSync(root)
        .filter((name) => !ignoreDirs.has(name) && !name.startsWith('.'))
        .sort();

      for (let i = 0; i < items.length; i++) {
        const item = items[i]!;
        const fullPath = resolve(root, item);
        const isLast = i === items.length - 1;
        const connector = isLast ? '└── ' : '├── ';

        try {
          const stat = statSync(fullPath);
          if (stat.isDirectory()) {
            entries.push(`${prefix}${connector}${item}/`);
            const childPrefix = prefix + (isLast ? '    ' : '│   ');
            entries.push(...this.getDirectoryTree(fullPath, maxDepth, childPrefix, depth + 1));
          } else {
            entries.push(`${prefix}${connector}${item}`);
          }
        } catch {
          // Skip inaccessible entries
        }
      }
    } catch {
      // Skip inaccessible directories
    }

    return entries;
  }

  private getScripts(root: string): Record<string, string> {
    const pkg = this.readPackageJson(root);
    return pkg?.scripts ?? {};
  }

  private getDependencies(root: string): string[] {
    const pkg = this.readPackageJson(root);
    if (!pkg?.dependencies) return [];
    return Object.keys(pkg.dependencies);
  }

  private getConfigFiles(root: string): string[] {
    const configPatterns = [
      'tsconfig.json', 'vite.config.ts', 'next.config.js', 'next.config.mjs',
      'tailwind.config.ts', 'tailwind.config.js', 'postcss.config.js',
      'drizzle.config.ts', 'prisma/schema.prisma',
      'eslint.config.js', 'eslint.config.mjs', '.eslintrc.json',
      'prettier.config.js', '.prettierrc',
      'vitest.config.ts', 'jest.config.ts', 'jest.config.js',
      'Dockerfile', 'docker-compose.yml', 'docker-compose.yaml',
      '.env.example', '.env.local',
    ];

    return configPatterns.filter((name) => existsSync(resolve(root, name)));
  }

  private detectConventions(root: string): string[] {
    const conventions: string[] = [];
    const pkg = this.readPackageJson(root);

    if (pkg?.type === 'module') conventions.push('ESM modules (type: module)');
    if (existsSync(resolve(root, 'src'))) conventions.push('Source code in src/ directory');
    if (existsSync(resolve(root, 'tests')) || existsSync(resolve(root, '__tests__'))) {
      conventions.push('Tests in separate directory');
    }
    if (existsSync(resolve(root, '.husky'))) conventions.push('Git hooks via Husky');
    if (existsSync(resolve(root, '.github/workflows'))) conventions.push('GitHub Actions CI/CD');
    if (existsSync(resolve(root, 'CLAUDE.md'))) conventions.push('Claude Code integration (CLAUDE.md)');

    return conventions;
  }

  private readPackageJson(root: string): any | null {
    try {
      return JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf-8'));
    } catch {
      return null;
    }
  }
}
