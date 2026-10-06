/**
 * Runtime resolver -- matches agents to runtime adapters.
 *
 * Resolution order:
 * 1. Agent explicitly specifies a runtime → use it
 * 2. Agent specifies capabilities → match against registered adapters
 * 3. User-defined preference order → pick the first capable adapter
 * 4. Fallback runtime from agent preferences
 * 5. Default runtime
 */

import type { AdapterRegistry } from '../layer1-adapters/adapter-registry.js';
import type { AgentDefinition } from '../platform/types.js';

export interface RuntimePreference {
  name: string;
  type: string;
  priority: number;
  capabilities: string[];
}

export class RuntimeResolver {
  private preferences: RuntimePreference[] = [];
  private defaultRuntime = 'claude-code';

  constructor(
    private registry: AdapterRegistry,
    preferences?: RuntimePreference[],
  ) {
    if (preferences) {
      this.preferences = [...preferences].sort((a, b) => a.priority - b.priority);
    }
  }

  setDefault(runtime: string): void {
    this.defaultRuntime = runtime;
  }

  /**
   * Resolve which runtime to use for the given agent.
   */
  resolve(agent: AgentDefinition): string {
    // 1. Agent explicitly specifies a runtime
    if (agent.runtime) {
      if (this.registry.has(agent.runtime)) {
        return agent.runtime;
      }
      // Runtime specified but not registered -- try fallback
    }

    // 2. Match by capabilities against user preferences
    if (agent.capabilities.length > 0 && this.preferences.length > 0) {
      for (const pref of this.preferences) {
        if (this.hasAllCapabilities(pref.capabilities, agent.capabilities)) {
          if (this.registry.has(pref.type)) {
            return pref.type;
          }
        }
      }
    }

    // 3. Match by capabilities against all registered adapters
    if (agent.capabilities.length > 0) {
      const types = this.registry.types();
      for (const type of types) {
        // Create a temporary adapter to check capabilities
        try {
          const adapter = this.registry.create(type, {
            id: 'probe',
            type,
            cwd: '.',
          });
          if (this.hasAllCapabilities(adapter.capabilities, agent.capabilities)) {
            return type;
          }
        } catch {
          // Skip adapters that fail to create
        }
      }
    }

    // 4. Fallback runtime from agent preferences
    if (agent.preferences.fallbackRuntime && this.registry.has(agent.preferences.fallbackRuntime)) {
      return agent.preferences.fallbackRuntime;
    }

    // 5. Default
    return this.defaultRuntime;
  }

  /**
   * Check if the adapter's capabilities satisfy all required capabilities.
   */
  private hasAllCapabilities(adapterCaps: string[], requiredCaps: string[]): boolean {
    return requiredCaps.every((req) => adapterCaps.includes(req));
  }
}
