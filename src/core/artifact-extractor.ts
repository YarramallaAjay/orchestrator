import type { AgentRunResult } from '../agent/runtimes/runtime.js';

export interface ExtractedArtifact {
  type: 'file_created' | 'file_modified' | 'export' | 'decision';
  path?: string;
  content?: string;
  summary: string;
}

/**
 * Extracts artifacts (files created/modified, decisions) from agent run results.
 * Used to pass context from upstream tasks to downstream tasks.
 */
export class ArtifactExtractor {
  /**
   * Scan agent messages for Write/Edit tool_use calls and extract file artifacts.
   */
  extract(result: AgentRunResult): ExtractedArtifact[] {
    const artifacts: ExtractedArtifact[] = [];
    const seenPaths = new Set<string>();

    for (const msg of result.messages) {
      if (!msg.toolUse) continue;

      const name = msg.toolUse.name.toLowerCase();
      const input = msg.toolUse.input as Record<string, any>;

      if (name === 'write') {
        const filePath = input.file_path ?? input.path;
        if (typeof filePath === 'string' && !seenPaths.has(filePath)) {
          seenPaths.add(filePath);
          artifacts.push({
            type: 'file_created',
            path: filePath,
            summary: `Created ${filePath}`,
          });
        }
      } else if (name === 'edit') {
        const filePath = input.file_path ?? input.path;
        if (typeof filePath === 'string' && !seenPaths.has(filePath)) {
          seenPaths.add(filePath);
          artifacts.push({
            type: 'file_modified',
            path: filePath,
            summary: `Modified ${filePath}`,
          });
        }
      }
    }

    // Extract key decisions from assistant messages
    for (const msg of result.messages) {
      if (msg.role !== 'assistant' || !msg.content) continue;

      // Look for decision-like patterns
      const decisionPatterns = [
        /(?:I decided|Decision:|Chose|Selected|Using|Going with)\s+(.{10,100})/i,
      ];

      for (const pattern of decisionPatterns) {
        const match = msg.content.match(pattern);
        if (match) {
          artifacts.push({
            type: 'decision',
            summary: match[0]!.trim(),
          });
          break; // One decision per message max
        }
      }
    }

    return artifacts;
  }

  /**
   * Format extracted artifacts as markdown for injection into downstream task context.
   */
  formatForDownstream(taskTitle: string, artifacts: ExtractedArtifact[]): string {
    if (artifacts.length === 0) return '';

    const lines: string[] = [
      `### Upstream Task: ${taskTitle}`,
      '',
    ];

    const files = artifacts.filter((a) => a.type === 'file_created' || a.type === 'file_modified');
    const decisions = artifacts.filter((a) => a.type === 'decision');

    if (files.length > 0) {
      lines.push('**Files changed:**');
      for (const file of files) {
        const action = file.type === 'file_created' ? 'Created' : 'Modified';
        lines.push(`- ${action}: \`${file.path}\``);
      }
      lines.push('');
    }

    if (decisions.length > 0) {
      lines.push('**Decisions:**');
      for (const decision of decisions) {
        lines.push(`- ${decision.summary}`);
      }
      lines.push('');
    }

    return lines.join('\n');
  }
}
