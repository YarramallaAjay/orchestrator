/**
 * Runtime adapter registry.
 *
 * Manages registration and lookup of runtime adapters.
 * Adapters register themselves; the execution engine looks them up by type.
 */

import type { RuntimeAdapter, AdapterConfig } from './types.js';
import { ClaudeCodeAdapter } from './claude-code/adapter.js';
import { ApiAdapter } from './api/adapter.js';
import { CliAdapter } from './cli/adapter.js';

export type AdapterFactory = (config: AdapterConfig) => RuntimeAdapter;

export class AdapterRegistry {
  private factories = new Map<string, AdapterFactory>();

  /**
   * Register an adapter factory for a runtime type.
   */
  register(type: string, factory: AdapterFactory): void {
    this.factories.set(type, factory);
  }

  /**
   * Create an adapter instance for the given type and config.
   */
  create(type: string, config: AdapterConfig): RuntimeAdapter {
    const factory = this.factories.get(type);
    if (!factory) {
      const available = [...this.factories.keys()].join(', ');
      throw new Error(
        `No adapter registered for runtime type '${type}'. Available: ${available || 'none'}`,
      );
    }
    return factory(config);
  }

  /**
   * Check if an adapter type is registered.
   */
  has(type: string): boolean {
    return this.factories.has(type);
  }

  /**
   * List all registered adapter types.
   */
  types(): string[] {
    return [...this.factories.keys()];
  }
}

/**
 * Create a registry with built-in adapters pre-registered.
 */
export function createDefaultRegistry(): AdapterRegistry {
  const registry = new AdapterRegistry();

  // Register built-in adapters
  registry.register('claude-code', () => new ClaudeCodeAdapter());
  registry.register('api', () => new ApiAdapter());
  registry.register('cli', () => new CliAdapter());

  return registry;
}
