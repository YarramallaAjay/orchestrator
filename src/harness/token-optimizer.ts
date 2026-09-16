/**
 * Context section with priority metadata for token budget management.
 */
export interface ContextSection {
  /** Section identifier */
  name: string;
  /** The text content of this section */
  content: string;
  /** Priority: higher = more important, kept first when trimming */
  priority: number;
  /** Whether this section is required (cannot be dropped) */
  required?: boolean;
}

/**
 * Token optimizer for managing context injection within token budgets.
 * Uses heuristic token estimation (~4 chars per token) and applies
 * deduplication, prioritization, truncation, and budget-based dropping.
 */
export class TokenOptimizer {
  /**
   * Estimate token count for a string using the ~4 chars/token heuristic.
   */
  estimateTokens(text: string): number {
    return Math.ceil(text.length / 4);
  }

  /**
   * Compress context sections to fit within a token budget.
   * Returns the assembled context string.
   */
  compress(sections: ContextSection[], budgetTokens: number): string {
    if (sections.length === 0) return '';

    // 1. Deduplicate sections with identical content
    const deduped = this.deduplicate(sections);

    // 2. Sort by priority (highest first), required sections always first
    const sorted = [...deduped].sort((a, b) => {
      if (a.required && !b.required) return -1;
      if (!a.required && b.required) return 1;
      return b.priority - a.priority;
    });

    // 3. Greedily add sections until budget is reached
    const result: string[] = [];
    let usedTokens = 0;

    for (const section of sorted) {
      const sectionTokens = this.estimateTokens(section.content);

      if (usedTokens + sectionTokens <= budgetTokens) {
        result.push(section.content);
        usedTokens += sectionTokens;
      } else if (section.required) {
        // Required sections get truncated to fit remaining budget
        const remainingTokens = budgetTokens - usedTokens;
        if (remainingTokens > 100) {
          const truncated = this.truncateToTokens(section.content, remainingTokens);
          result.push(truncated);
          usedTokens += this.estimateTokens(truncated);
        }
      } else {
        // Optional section doesn't fit — try truncating if it's worth including
        const remainingTokens = budgetTokens - usedTokens;
        if (remainingTokens > 200 && sectionTokens > remainingTokens) {
          const truncated = this.truncateToTokens(section.content, remainingTokens);
          result.push(truncated);
          usedTokens += this.estimateTokens(truncated);
        }
        // Otherwise skip this section entirely
      }
    }

    return result.join('\n\n');
  }

  /**
   * Remove duplicate sections with identical content.
   */
  private deduplicate(sections: ContextSection[]): ContextSection[] {
    const seen = new Set<string>();
    return sections.filter((s) => {
      const normalized = s.content.trim();
      if (seen.has(normalized)) return false;
      seen.add(normalized);
      return true;
    });
  }

  /**
   * Truncate text to approximately fit within a token budget.
   * Truncates at line boundaries and adds a truncation marker.
   */
  private truncateToTokens(text: string, maxTokens: number): string {
    const maxChars = maxTokens * 4;
    if (text.length <= maxChars) return text;

    // Find the last newline before the char limit
    const truncateAt = text.lastIndexOf('\n', maxChars);
    const cutPoint = truncateAt > maxChars * 0.5 ? truncateAt : maxChars;

    return text.slice(0, cutPoint) + '\n\n[... truncated for token budget]';
  }
}
