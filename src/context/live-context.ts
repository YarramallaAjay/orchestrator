import { ContextStore } from './context-store.js';
import { ContextCategory } from './types.js';

export interface LiveDiscovery {
  id: string;
  agentId: string;
  taskId: string;
  type: 'convention' | 'pattern' | 'decision' | 'warning' | 'file_claim';
  summary: string;
  details: string;
  relatedFiles: string[];
  timestamp: string;
}

/**
 * Thin wrapper over ContextStore providing agent-friendly write/read patterns
 * for inter-agent communication during execution.
 *
 * Agents write discoveries here; sibling agents read them to stay coordinated.
 */
export class LiveContext {
  private discoveries: LiveDiscovery[] = [];
  private fileClaims = new Map<string, string>(); // filePath -> agentId

  constructor(
    private contextStore: ContextStore,
    private projectId: string,
  ) {}

  /**
   * Agent writes a discovery during execution.
   */
  async publishDiscovery(
    agentId: string,
    taskId: string,
    content: {
      type: LiveDiscovery['type'];
      summary: string;
      details: string;
      relatedFiles?: string[];
    },
  ): Promise<void> {
    const discovery: LiveDiscovery = {
      id: `disc_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      agentId,
      taskId,
      type: content.type,
      summary: content.summary,
      details: content.details,
      relatedFiles: content.relatedFiles ?? [],
      timestamp: new Date().toISOString(),
    };

    this.discoveries.push(discovery);

    // Persist to context store for durability
    const category = content.type === 'file_claim'
      ? ContextCategory.FILE_LOCK
      : content.type === 'decision'
        ? ContextCategory.SHARED_DECISION
        : ContextCategory.AGENT_DISCOVERY;

    await this.contextStore.set({
      projectId: this.projectId,
      key: `live:${discovery.id}`,
      category,
      title: content.summary,
      content: JSON.stringify(discovery),
      updatedBy: `agent:${agentId}`,
    });
  }

  /**
   * Agent reads all discoveries from siblings.
   */
  getRecentDiscoveries(since?: string): LiveDiscovery[] {
    if (!since) return [...this.discoveries];
    return this.discoveries.filter((d) => d.timestamp > since);
  }

  /**
   * Agent claims a file (prevents conflicts).
   * Returns true if the claim was successful, false if already claimed by another agent.
   */
  async claimFile(agentId: string, filePath: string): Promise<boolean> {
    const existingClaim = this.fileClaims.get(filePath);
    if (existingClaim && existingClaim !== agentId) {
      return false;
    }

    this.fileClaims.set(filePath, agentId);

    await this.publishDiscovery(agentId, '', {
      type: 'file_claim',
      summary: `Claimed ${filePath}`,
      details: `Agent ${agentId} is working on ${filePath}`,
      relatedFiles: [filePath],
    });

    return true;
  }

  /**
   * Check if a file is claimed.
   */
  isFileClaimed(filePath: string): { claimed: boolean; by?: string } {
    const claimedBy = this.fileClaims.get(filePath);
    if (claimedBy) {
      return { claimed: true, by: claimedBy };
    }
    return { claimed: false };
  }

  /**
   * Get all claimed files.
   */
  getFileClaims(): Map<string, string> {
    return new Map(this.fileClaims);
  }

  /**
   * Build a formatted context snapshot for injection into agent system prompts.
   */
  buildLiveContextSnapshot(): string {
    if (this.discoveries.length === 0) return '';

    const sections: string[] = ['## Live Context (from sibling agents)\n'];

    // Group by type
    const decisions = this.discoveries.filter((d) => d.type === 'decision');
    const patterns = this.discoveries.filter((d) => d.type === 'pattern' || d.type === 'convention');
    const warnings = this.discoveries.filter((d) => d.type === 'warning');
    const claims = this.discoveries.filter((d) => d.type === 'file_claim');

    if (decisions.length > 0) {
      sections.push('### Decisions Made');
      for (const d of decisions) {
        sections.push(`- **${d.summary}** (by agent ${d.agentId}): ${d.details}`);
      }
      sections.push('');
    }

    if (patterns.length > 0) {
      sections.push('### Discovered Patterns');
      for (const d of patterns) {
        sections.push(`- ${d.summary}: ${d.details}`);
      }
      sections.push('');
    }

    if (warnings.length > 0) {
      sections.push('### Warnings');
      for (const d of warnings) {
        sections.push(`- ${d.summary}: ${d.details}`);
      }
      sections.push('');
    }

    if (claims.length > 0) {
      sections.push('### File Ownership');
      const uniqueClaims = new Map<string, string>();
      for (const d of claims) {
        for (const f of d.relatedFiles) {
          uniqueClaims.set(f, d.agentId);
        }
      }
      for (const [file, agent] of uniqueClaims) {
        sections.push(`- \`${file}\` — owned by agent ${agent}`);
      }
      sections.push('');
    }

    return sections.join('\n');
  }

  /**
   * Reset all live context (e.g., between orchestration runs).
   */
  reset(): void {
    this.discoveries = [];
    this.fileClaims.clear();
  }
}
