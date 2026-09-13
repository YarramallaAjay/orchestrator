import type { AgentRuntime, AgentMessage } from '../agent/runtimes/runtime.js';
import { ProjectScanner, type ProjectScanResult } from '../context/project-scanner.js';
import { logger } from '../util/logger.js';

export interface FileAnalysis {
  path: string;
  summary: string;
  relevance: 'high' | 'medium' | 'low';
}

export interface TechStackInfo {
  language: string;
  framework?: string;
  buildTool?: string;
  testFramework?: string;
  packageManager: string;
}

export interface DiscoveryResult {
  refinedRequirements: string;
  projectContext: ProjectScanResult;
  relevantFiles: FileAnalysis[];
  codePatterns: string[];
  techStack: TechStackInfo;
  suggestedApproach: string;
}

export interface DiscoveryConfig {
  enabled: boolean;
  model: string;
  maxTurns: number;
}

const DISCOVERY_SYSTEM_PROMPT = `You are a codebase discovery agent. Your job is to analyze a project and its requirements to produce a detailed analysis that will be used by a planner to create tasks.

You have access to tools like Read, Glob, Grep, and Bash to explore the codebase. Use them actively.

Given the user's requirements, you must:

1. **Scan the project structure** — Understand the directory layout, key files, and architecture.
2. **Identify relevant files** — Find the specific files that will likely need to be created or modified to fulfill the requirements.
3. **Detect patterns** — Identify coding conventions, naming patterns, file organization patterns, and test patterns used in the project.
4. **Assess the tech stack** — Confirm the language, framework, build tools, test framework, and package manager.
5. **Suggest an approach** — Based on your analysis, suggest a high-level approach for implementing the requirements.

CRITICAL: Your FINAL message must be a JSON object (and ONLY the JSON object) with this exact schema:

{
  "refinedRequirements": "The original requirements enriched with context from your analysis. Include specific file paths, existing patterns to follow, and constraints discovered.",
  "relevantFiles": [
    {
      "path": "src/path/to/file.ts",
      "summary": "Brief description of what this file does and why it's relevant",
      "relevance": "high|medium|low"
    }
  ],
  "codePatterns": [
    "Pattern description, e.g. 'All services use dependency injection via constructor'",
    "Another pattern"
  ],
  "suggestedApproach": "A 2-4 sentence high-level strategy for implementing the requirements."
}

Rules:
- Explore broadly first, then dive deep into relevant areas.
- Read at least 3-5 key files to understand conventions.
- Include files that exist AND will need modification, plus paths for new files that should be created.
- For relevance: "high" = will be directly modified/created, "medium" = provides context or patterns, "low" = tangentially related.
- Your refined requirements should be much more detailed than the original — include file paths, function names, existing patterns to follow.
- The LAST message must be ONLY the JSON. No markdown fences, no explanation.`;

/**
 * Runs BEFORE the planner to scan the codebase and produce
 * enriched context for better task decomposition.
 */
export class DiscoveryAgent {
  constructor(
    private runtime: AgentRuntime,
    private config: DiscoveryConfig,
  ) {}

  async discover(
    requirements: string,
    options: {
      rootPath: string;
      projectScan?: ProjectScanResult;
    },
  ): Promise<DiscoveryResult> {
    logger.info('Starting discovery phase');

    // Get or create project scan
    const scanner = new ProjectScanner();
    const projectScan = options.projectScan ?? scanner.scan(options.rootPath);
    const projectContext = scanner.formatAsContext(projectScan);

    const techStack: TechStackInfo = {
      language: projectScan.language,
      framework: projectScan.framework,
      buildTool: projectScan.buildTool,
      testFramework: projectScan.testFramework,
      packageManager: projectScan.packageManager,
    };

    const prompt = [
      '# Requirements to Analyze',
      '',
      requirements,
      '',
      '# Project Context (from automated scan)',
      '',
      projectContext,
      '',
      'Please explore the codebase to understand the relevant code, patterns, and architecture.',
      'Then produce your JSON analysis as described in your instructions.',
    ].join('\n');

    try {
      const content = await this.runDiscovery(prompt, options.rootPath);
      const analysis = this.parseDiscoveryOutput(content);

      const result: DiscoveryResult = {
        refinedRequirements: analysis.refinedRequirements || requirements,
        projectContext: projectScan,
        relevantFiles: analysis.relevantFiles || [],
        codePatterns: analysis.codePatterns || [],
        techStack,
        suggestedApproach: analysis.suggestedApproach || '',
      };

      logger.info({
        relevantFiles: result.relevantFiles.length,
        patterns: result.codePatterns.length,
      }, 'Discovery phase complete');

      return result;
    } catch (err) {
      logger.warn({ err }, 'Discovery agent failed, returning basic scan results');

      // Fallback: return basic project scan without deep analysis
      return {
        refinedRequirements: requirements,
        projectContext: projectScan,
        relevantFiles: [],
        codePatterns: projectScan.conventions,
        techStack,
        suggestedApproach: '',
      };
    }
  }

  private async runDiscovery(prompt: string, cwd: string): Promise<string> {
    const generator = this.runtime.run({
      prompt,
      systemPrompt: DISCOVERY_SYSTEM_PROMPT,
      config: {
        id: 'discovery',
        name: 'Discovery Agent',
        role: 'analyst',
        runtimeType: this.runtime.type,
        capabilities: [],
        model: this.config.model,
        maxTurns: this.config.maxTurns,
        permissionMode: 'default',
        allowedTools: [
          'Read', 'Glob', 'Grep', 'Bash',
          'mcp__filesystem__read_file',
          'mcp__filesystem__list_directory',
        ],
      },
      cwd,
    });

    const messages: AgentMessage[] = [];
    let result;
    while (true) {
      const { value, done } = await generator.next();
      if (done) {
        result = value;
        break;
      }
      messages.push(value as AgentMessage);
    }

    // Get the last assistant message (should be the JSON output)
    const allMessages = [
      ...messages,
      ...(result?.messages ?? []),
    ];

    // Look through messages in reverse to find JSON
    const assistantMessages = allMessages
      .filter((m) => m.role === 'assistant' && !m.toolUse && !m.toolResult)
      .reverse();

    for (const msg of assistantMessages) {
      if (msg.content.includes('"refinedRequirements"')) {
        return msg.content;
      }
    }

    // If no JSON found in individual messages, concatenate all assistant content
    const fullContent = assistantMessages
      .reverse()
      .map((m) => m.content)
      .join('\n');

    return fullContent;
  }

  private parseDiscoveryOutput(content: string): {
    refinedRequirements: string;
    relevantFiles: FileAnalysis[];
    codePatterns: string[];
    suggestedApproach: string;
  } {
    // Try to extract JSON from the content
    let jsonStr = content;

    // Try markdown code fences first
    const fenceMatch = content.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
    if (fenceMatch?.[1]) {
      jsonStr = fenceMatch[1];
    } else {
      // Try to find raw JSON object containing our expected keys
      const objMatch = content.match(/\{[\s\S]*"refinedRequirements"[\s\S]*\}/);
      if (objMatch?.[0]) {
        jsonStr = objMatch[0];
      }
    }

    try {
      const parsed = JSON.parse(jsonStr);
      return {
        refinedRequirements: parsed.refinedRequirements ?? '',
        relevantFiles: (parsed.relevantFiles ?? []).map((f: any) => ({
          path: f.path ?? '',
          summary: f.summary ?? '',
          relevance: f.relevance ?? 'medium',
        })),
        codePatterns: parsed.codePatterns ?? [],
        suggestedApproach: parsed.suggestedApproach ?? '',
      };
    } catch (e) {
      logger.warn({ error: e, contentLength: content.length }, 'Failed to parse discovery output as JSON');
      throw new Error(`Failed to parse discovery output: ${e instanceof Error ? e.message : e}`);
    }
  }

  /**
   * Format discovery result as context for the planner.
   */
  static formatForPlanner(discovery: DiscoveryResult): string {
    const sections: string[] = [];

    sections.push('## Discovery Analysis');
    sections.push('');

    // Tech stack
    sections.push('### Tech Stack');
    sections.push(`- Language: ${discovery.techStack.language}`);
    sections.push(`- Package Manager: ${discovery.techStack.packageManager}`);
    if (discovery.techStack.framework) sections.push(`- Framework: ${discovery.techStack.framework}`);
    if (discovery.techStack.buildTool) sections.push(`- Build Tool: ${discovery.techStack.buildTool}`);
    if (discovery.techStack.testFramework) sections.push(`- Test Framework: ${discovery.techStack.testFramework}`);
    sections.push('');

    // Relevant files
    if (discovery.relevantFiles.length > 0) {
      sections.push('### Relevant Files');
      const highRelevance = discovery.relevantFiles.filter((f) => f.relevance === 'high');
      const mediumRelevance = discovery.relevantFiles.filter((f) => f.relevance === 'medium');

      if (highRelevance.length > 0) {
        sections.push('**Will be modified/created:**');
        for (const f of highRelevance) {
          sections.push(`- \`${f.path}\`: ${f.summary}`);
        }
      }
      if (mediumRelevance.length > 0) {
        sections.push('**Context/reference files:**');
        for (const f of mediumRelevance) {
          sections.push(`- \`${f.path}\`: ${f.summary}`);
        }
      }
      sections.push('');
    }

    // Code patterns
    if (discovery.codePatterns.length > 0) {
      sections.push('### Code Patterns & Conventions');
      for (const pattern of discovery.codePatterns) {
        sections.push(`- ${pattern}`);
      }
      sections.push('');
    }

    // Suggested approach
    if (discovery.suggestedApproach) {
      sections.push('### Suggested Approach');
      sections.push(discovery.suggestedApproach);
      sections.push('');
    }

    return sections.join('\n');
  }
}
