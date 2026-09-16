import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, rmSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import type { Db } from '../db/connection.js';
import type { ContextStore } from '../context/context-store.js';
import type { ObservationStore } from '../context/observation-store.js';
import { MemoryStore } from '../context/memory-store.js';
import { ProjectScanner } from '../context/project-scanner.js';
import { TokenOptimizer, type ContextSection } from './token-optimizer.js';
import type { HarnessAdapter, HarnessSessionResult, WrapOptions } from './types.js';
import { logger } from '../util/logger.js';

interface GatewayDeps {
  adapter: HarnessAdapter;
  db: Db;
  projectId: string;
  rootPath: string;
  contextStore: ContextStore;
  observationStore: ObservationStore;
}

/**
 * HarnessGateway coordinates the full lifecycle of an `orch wrap` session:
 * 1. Pre-launch: scan project, build context, install hooks, start MCP sidecar
 * 2. Launch: spawn the harness adapter with stdio: 'inherit'
 * 3. Post-exit: harvest data, promote observations to memory, cleanup
 */
export class HarnessGateway {
  private deps: GatewayDeps;
  private settingsBackup: string | null = null;
  private settingsPath: string;
  private cleanupDone = false;

  constructor(deps: GatewayDeps) {
    this.deps = deps;
    this.settingsPath = resolve(deps.rootPath, '.claude', 'settings.local.json');
  }

  async launch(
    options: WrapOptions = {},
    onReady?: (gateway: HarnessGateway) => void,
  ): Promise<HarnessSessionResult> {
    const tokenBudget = options.tokenBudget ?? 8192;

    try {
      // Phase 1: Build context
      logger.info('Preparing orchestrator context...');
      const contextData = await this.buildContext(tokenBudget, options);

      // Phase 2: Write context file for hooks
      const contextFile = resolve(this.deps.rootPath, '.orchestrator', '.wrap-context.json');
      mkdirSync(dirname(contextFile), { recursive: true });
      writeFileSync(contextFile, JSON.stringify(contextData, null, 2));

      // Phase 3: Ensure .wrap-state directory exists
      const stateDir = resolve(this.deps.rootPath, '.orchestrator', '.wrap-state');
      mkdirSync(stateDir, { recursive: true });

      // Phase 4: Install hooks (unless disabled)
      if (!options.disableHooks) {
        this.installHooks();
      }

      // Phase 5: Write MCP config (unless disabled)
      let mcpConfigPath: string | undefined;
      if (!options.disableMcp) {
        mcpConfigPath = this.writeMcpConfig();
      }

      // Phase 6: Register cleanup handlers
      this.registerCleanupHandlers();

      // Phase 6.5: Notify caller that setup is complete
      if (onReady) {
        onReady(this);
      }

      // Phase 7: Launch the harness
      logger.info({ harness: this.deps.adapter.type }, 'Launching harness...');
      const harnessProcess = await this.deps.adapter.start({
        cwd: this.deps.rootPath,
        projectId: this.deps.projectId,
        model: options.model,
        mcpConfigPath,
        resumeSession: options.resumeSession,
        additionalArgs: options.additionalArgs,
      });

      // Phase 8: Wait for exit
      const result = await harnessProcess.exitPromise;

      // Phase 9: Post-exit harvesting
      await this.postExitHarvest(options);

      // Phase 10: Cleanup
      this.cleanup();

      logger.info({
        exitCode: result.exitCode,
        durationMs: result.durationMs,
      }, 'Harness session complete');

      return result;
    } catch (err) {
      this.cleanup();
      throw err;
    }
  }

  private async buildContext(
    tokenBudget: number,
    options: WrapOptions,
  ): Promise<Record<string, string>> {
    const data: Record<string, string> = {};
    const sections: ContextSection[] = [];

    // 1. Project scan
    const scanner = new ProjectScanner();
    const scanResult = scanner.scan(this.deps.rootPath);
    const projectContext = scanner.formatAsContext(scanResult);
    data.projectContext = projectContext;
    sections.push({ name: 'project', content: projectContext, priority: 10, required: true });

    // 2. Shared context from context store
    try {
      // Use a minimal task stub so all foundational context categories are included
      const stubTask = { id: 'wrap', title: 'wrap-session', tags: [] } as any;
      const sharedContext = await this.deps.contextStore.buildAgentContext(this.deps.projectId, stubTask);
      if (sharedContext) {
        data.sharedContext = sharedContext;
        sections.push({ name: 'shared', content: sharedContext, priority: 8 });
      }
    } catch { /* context store may be empty */ }

    // 3. Observations from past sessions
    try {
      const observations = await this.deps.observationStore.findRelevant(this.deps.projectId);
      if (observations.length > 0) {
        const formatted = this.deps.observationStore.formatForContext(observations);
        data.observations = formatted;
        sections.push({ name: 'observations', content: formatted, priority: 6 });
      }
    } catch { /* observation store may be empty */ }

    // 4. Cross-session memory
    if (!options.disableMemory) {
      try {
        const memoryStore = new MemoryStore(this.deps.db);
        const memories = await memoryStore.recall(this.deps.projectId, { limit: 20 });
        if (memories.length > 0) {
          const formatted = memoryStore.formatForContext(memories);
          data.memory = formatted;
          sections.push({ name: 'memory', content: formatted, priority: 9 });
        }
      } catch { /* memory store may not exist yet */ }
    }

    // 5. Apply token optimization
    const optimizer = new TokenOptimizer();
    const totalTokens = optimizer.estimateTokens(Object.values(data).join('\n'));
    if (totalTokens > tokenBudget) {
      logger.info({ totalTokens, budget: tokenBudget }, 'Compressing context to fit token budget');
      const compressed = optimizer.compress(sections, tokenBudget);
      // Replace with compressed version
      data.compressed = compressed;
    }

    return data;
  }

  private installHooks(): void {
    // Backup existing settings
    if (existsSync(this.settingsPath)) {
      this.settingsBackup = readFileSync(this.settingsPath, 'utf-8');
    }

    // Read current settings
    let settings: Record<string, any> = {};
    if (this.settingsBackup) {
      try {
        settings = JSON.parse(this.settingsBackup);
      } catch { /* start fresh */ }
    }

    if (!settings.hooks) {
      settings.hooks = {};
    }

    // Resolve hook scripts
    const sessionStartCmd = this.resolveHookScript('wrap-session-start');
    const promptSubmitCmd = this.resolveHookScript('wrap-prompt-submit');

    // Add wrap-mode hooks (append to existing, don't replace)
    if (!settings.hooks.SessionStart) {
      settings.hooks.SessionStart = [];
    }
    settings.hooks.SessionStart.push({
      matcher: '',
      hooks: [{ type: 'command', command: sessionStartCmd }],
    });

    if (!settings.hooks.UserPromptSubmit) {
      settings.hooks.UserPromptSubmit = [];
    }
    settings.hooks.UserPromptSubmit.push({
      matcher: '',
      hooks: [{ type: 'command', command: promptSubmitCmd }],
    });

    // Write updated settings
    mkdirSync(dirname(this.settingsPath), { recursive: true });
    writeFileSync(this.settingsPath, JSON.stringify(settings, null, 2) + '\n');

    logger.info('Wrap hooks installed');
  }

  private resolveHookScript(hookName: string): string {
    const thisDir = dirname(new URL(import.meta.url).pathname);

    // Check dist/ (compiled)
    const hookFileJs = resolve(thisDir, '..', 'hooks', `${hookName}.js`);
    if (existsSync(hookFileJs)) {
      return `node ${hookFileJs}`;
    }

    // Check src/ (dev mode with tsx)
    const hookFileTs = resolve(thisDir, '..', 'hooks', `${hookName}.ts`);
    if (existsSync(hookFileTs)) {
      return `npx tsx ${hookFileTs}`;
    }

    // Fallback
    return `node ${hookFileJs}`;
  }

  private writeMcpConfig(): string {
    const configPath = resolve(this.deps.rootPath, '.orchestrator', '.wrap-mcp-config.json');
    const thisDir = dirname(new URL(import.meta.url).pathname);

    // Find the MCP server script
    let serverScript = resolve(thisDir, 'mcp', 'wrap-tools-server.js');
    if (!existsSync(serverScript)) {
      serverScript = resolve(thisDir, 'mcp', 'wrap-tools-server.ts');
    }

    const dbPath = resolve(this.deps.rootPath, '.orchestrator', 'data.db');

    const config = {
      mcpServers: {
        'orch-tools': {
          type: 'stdio',
          command: 'node',
          args: [serverScript],
          env: {
            ORCH_PROJECT_ID: this.deps.projectId,
            ORCH_DB_PATH: dbPath,
            ORCH_CWD: this.deps.rootPath,
          },
        },
      },
    };

    writeFileSync(configPath, JSON.stringify(config, null, 2));
    logger.info('MCP sidecar config written');
    return configPath;
  }

  private registerCleanupHandlers(): void {
    const doCleanup = () => this.cleanup();
    process.on('exit', doCleanup);
    process.on('SIGINT', () => { doCleanup(); process.exit(130); });
    process.on('SIGTERM', () => { doCleanup(); process.exit(143); });
  }

  private async postExitHarvest(options: WrapOptions): Promise<void> {
    if (options.disableMemory) return;

    // Promote high-confidence observations from this session to memory
    const observationsFile = resolve(this.deps.rootPath, '.orchestrator', '.wrap-state', 'observations.json');
    if (!existsSync(observationsFile)) return;

    try {
      const observations = JSON.parse(readFileSync(observationsFile, 'utf-8'));
      const memoryStore = new MemoryStore(this.deps.db);

      let promoted = 0;
      for (const obs of observations) {
        const result = await memoryStore.promote({
          projectId: this.deps.projectId,
          type: obs.type,
          content: `${obs.summary}: ${obs.details}`,
          confidence: 0.8,
          source: 'wrap-session',
        });
        if (result) promoted++;
      }

      if (promoted > 0) {
        logger.info({ promoted }, 'Observations promoted to memory');
      }
    } catch (err) {
      logger.warn({ err }, 'Failed to harvest session observations');
    }
  }

  private cleanup(): void {
    if (this.cleanupDone) return;
    this.cleanupDone = true;

    // Restore original settings.local.json
    if (this.settingsBackup !== null) {
      try {
        writeFileSync(this.settingsPath, this.settingsBackup);
        logger.info('Original settings.local.json restored');
      } catch (err) {
        logger.warn({ err }, 'Failed to restore settings.local.json');
      }
    } else if (existsSync(this.settingsPath)) {
      // We created settings.local.json — check if we should remove our hooks
      try {
        const settings = JSON.parse(readFileSync(this.settingsPath, 'utf-8'));
        // Remove wrap hooks
        if (settings.hooks?.SessionStart) {
          settings.hooks.SessionStart = settings.hooks.SessionStart.filter(
            (h: any) => !h.hooks?.some((hook: any) => hook.command?.includes('wrap-session-start')),
          );
          if (settings.hooks.SessionStart.length === 0) delete settings.hooks.SessionStart;
        }
        if (settings.hooks?.UserPromptSubmit) {
          settings.hooks.UserPromptSubmit = settings.hooks.UserPromptSubmit.filter(
            (h: any) => !h.hooks?.some((hook: any) => hook.command?.includes('wrap-prompt-submit')),
          );
          if (settings.hooks.UserPromptSubmit.length === 0) delete settings.hooks.UserPromptSubmit;
        }
        if (settings.hooks && Object.keys(settings.hooks).length === 0) delete settings.hooks;
        writeFileSync(this.settingsPath, JSON.stringify(settings, null, 2) + '\n');
      } catch { /* best effort */ }
    }

    // Clean up temp files
    const tempFiles = [
      resolve(this.deps.rootPath, '.orchestrator', '.wrap-context.json'),
      resolve(this.deps.rootPath, '.orchestrator', '.wrap-mcp-config.json'),
    ];
    for (const f of tempFiles) {
      try { if (existsSync(f)) rmSync(f); } catch { /* best effort */ }
    }
  }
}
