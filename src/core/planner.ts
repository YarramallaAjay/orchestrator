import { readFileSync } from 'node:fs';
import type { AgentRuntime, AgentMessage } from '../agent/runtimes/runtime.js';
import type { CreateTaskInput } from '../task/types.js';
import { TaskClassification } from '../task/types.js';
import { logger } from '../util/logger.js';
import type { SessionAnalytics } from './session-analytics.js';

interface PlannerConfig {
  projectId: string;
  model?: string;
  maxTurns?: number;
  maxRetries?: number;
  sessionAnalytics?: SessionAnalytics;
}

interface DecomposedTask {
  title: string;
  description: string;
  classification: string;
  priority: number;
  dependsOn: string[];
  tags: string[];
  targetFiles: string[];
  acceptanceCriteria: string[];
  validationScript?: string;
  estimatedEffort?: string;
}

interface DecompositionResult {
  tasks: DecomposedTask[];
  context?: {
    architecture?: string;
    decisions?: string[];
    contracts?: string[];
  };
}

const PLANNER_SYSTEM_PROMPT = `You are a software project planner. Your ONLY job is to output a JSON task graph.

CRITICAL: You must respond with ONLY a valid JSON object. No explanations, no markdown, no diagrams, no commentary. Your entire response must be parseable by JSON.parse().

JSON schema:
{
  "tasks": [
    {
      "title": "Short task title",
      "description": "Detailed description of what to build/do",
      "classification": "LOCAL|MODULE|CROSS_MODULE|AGENT|HUMAN_IN_THE_LOOP|AUTONOMOUS",
      "priority": <number, 0=highest>,
      "dependsOn": ["<title of dependency task>"],
      "tags": ["backend", "frontend", "database", etc.],
      "targetFiles": ["src/path/to/file.ts", "src/other/file.ts"],
      "acceptanceCriteria": ["Criterion 1", "Criterion 2"],
      "validationScript": "optional command to validate",
      "estimatedEffort": "trivial|small|medium|large|xlarge"
    }
  ],
  "context": {
    "architecture": "Brief architecture description",
    "decisions": ["Key architecture decision 1"],
    "contracts": ["API contract description 1"]
  }
}

Rules:
1. Break work into small, independently executable tasks.
2. Each task should be completable by a single developer/agent.
3. Use dependsOn to reference other tasks by their TITLE (not index).
4. Order priorities so foundational work (setup, DB, models) comes first.
5. Include validation scripts where possible (e.g., "npm test", "npm run typecheck").
6. Classification should reflect the scope of the task.
7. Always include setup/scaffolding tasks first.
8. Include test tasks for each module.
9. Include integration tasks at the end.
10. Every task MUST list the specific files it will create or modify in targetFiles. This enables conflict detection — tasks with overlapping targetFiles will be serialized.

REMEMBER: Output ONLY the JSON object. Nothing else. No text before or after the JSON.`;

const RETRY_PROMPT = `Your previous response was not valid JSON. You MUST respond with ONLY a valid JSON object matching the schema I described. No markdown, no explanations, no code fences — just the raw JSON object starting with { and ending with }. Try again with the same requirements.`;

/**
 * Uses an LLM agent to decompose requirements into a task graph.
 * Includes retry logic if the planner doesn't return valid JSON.
 */
export class Planner {
  constructor(
    private runtime: AgentRuntime,
    private config: PlannerConfig,
  ) {}

  /**
   * Decompose a requirements document/string into tasks.
   * Retries up to maxRetries times if JSON parsing fails.
   */
  async decompose(requirements: string, discoveryContext?: string): Promise<CreateTaskInput[]> {
    logger.info('Decomposing requirements into task graph');

    // Fetch historical insights if analytics are available
    let insightsSection = '';
    if (this.config.sessionAnalytics) {
      try {
        const insights = await this.config.sessionAnalytics.analyze(this.config.projectId);
        insightsSection = this.config.sessionAnalytics.formatForPlannerPrompt(insights);
      } catch (err) {
        logger.warn({ err }, 'Failed to load session analytics');
      }
    }

    const prompt = [
      'Decompose the following requirements into a structured task graph:',
      '',
      requirements,
      discoveryContext ? `\n${discoveryContext}` : '',
      insightsSection ? `\n${insightsSection}` : '',
    ].filter(Boolean).join('\n');

    const maxRetries = this.config.maxRetries ?? 2;
    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const isRetry = attempt > 0;
      const currentPrompt = isRetry ? `${RETRY_PROMPT}\n\nOriginal requirements:\n${requirements}` : prompt;

      try {
        const content = await this.runPlanner(currentPrompt);
        return this.parseDecomposition(content);
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        if (attempt < maxRetries) {
          logger.warn({ attempt: attempt + 1, error: lastError.message }, 'Planner output not valid JSON, retrying');
        }
      }
    }

    throw lastError ?? new Error('Planner failed to produce valid JSON after retries');
  }

  /**
   * Decompose from a requirements file.
   */
  async decomposeFile(filePath: string): Promise<CreateTaskInput[]> {
    const content = readFileSync(filePath, 'utf-8');
    return this.decompose(content);
  }

  private async runPlanner(prompt: string): Promise<string> {
    const generator = this.runtime.run({
      prompt,
      systemPrompt: PLANNER_SYSTEM_PROMPT,
      config: {
        id: 'planner',
        name: 'Planner',
        role: 'planner',
        runtimeType: this.runtime.type,
        capabilities: [],
        model: this.config.model ?? 'claude-sonnet-4-6',
        // Single turn only — planner should produce JSON in one shot, no tool use
        maxTurns: 1,
        permissionMode: 'default',
        // Explicitly deny all tools so the model can't explore or use tools
        allowedTools: [],
      },
      cwd: process.cwd(),
    });

    // Collect all messages
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

    // Merge streamed + result messages, filter to text-only assistant messages
    // (skip tool_use and tool_result messages which are noise for JSON extraction)
    const allMessages = [
      ...messages,
      ...(result?.messages ?? []),
    ];
    const textMessages = allMessages.filter(
      (m) => m.role === 'assistant' && !m.toolUse && !m.toolResult,
    );

    // Look for the message that contains JSON (has '{' and '"tasks"')
    for (const msg of textMessages.reverse()) {
      if (msg.content.includes('"tasks"') && msg.content.includes('{')) {
        return msg.content;
      }
    }

    // Fallback: concatenate all text assistant messages
    const fullContent = textMessages
      .reverse()
      .map((m) => m.content)
      .join('\n');

    return fullContent;
  }

  private parseDecomposition(content: string): CreateTaskInput[] {
    // Try to extract JSON from the content
    let jsonStr = content;

    // Try to find JSON block in markdown code fences
    const jsonMatch = content.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
    if (jsonMatch?.[1]) {
      jsonStr = jsonMatch[1];
    } else {
      // Try to find raw JSON object
      const objMatch = content.match(/\{[\s\S]*\}/);
      if (objMatch?.[0]) {
        jsonStr = objMatch[0];
      }
    }

    let parsed: DecompositionResult;
    try {
      parsed = JSON.parse(jsonStr);
    } catch (e) {
      logger.error({ content: jsonStr.substring(0, 500) }, 'Failed to parse planner output as JSON');
      throw new Error(`Failed to parse planner output: ${e instanceof Error ? e.message : e}`);
    }

    if (!parsed.tasks || !Array.isArray(parsed.tasks)) {
      throw new Error('Planner output missing "tasks" array');
    }

    // Build title -> index map for resolving dependsOn references
    const titleMap = new Map<string, number>();
    for (let i = 0; i < parsed.tasks.length; i++) {
      titleMap.set(parsed.tasks[i]!.title, i);
    }

    // Convert to CreateTaskInput array
    const tempIds: string[] = [];
    const inputs: CreateTaskInput[] = [];

    for (let i = 0; i < parsed.tasks.length; i++) {
      const t = parsed.tasks[i]!;
      const tempId = `__temp_${i}`;
      tempIds.push(tempId);

      inputs.push({
        projectId: this.config.projectId,
        title: t.title,
        description: t.description,
        classification: this.parseClassification(t.classification),
        priority: t.priority ?? (i * 10),
        dependsOn: [],
        tags: t.tags ?? [],
        targetFiles: t.targetFiles ?? [],
        acceptanceCriteria: t.acceptanceCriteria ?? [],
        validationScript: t.validationScript,
        estimatedEffort: this.parseEffort(t.estimatedEffort),
      });
    }

    // Resolve dependency references
    for (let i = 0; i < parsed.tasks.length; i++) {
      const t = parsed.tasks[i]!;
      if (t.dependsOn?.length) {
        const depIndices = t.dependsOn
          .map((title) => titleMap.get(title))
          .filter((idx): idx is number => idx !== undefined);
        inputs[i]!.dependsOn = depIndices.map((idx) => `__temp_${idx}`);
      }
    }

    logger.info({ taskCount: inputs.length }, 'Decomposition complete');
    return inputs;
  }

  private parseClassification(value?: string): TaskClassification {
    if (!value) return TaskClassification.LOCAL;
    const upper = value.toUpperCase();
    if (upper in TaskClassification) {
      return upper as TaskClassification;
    }
    return TaskClassification.LOCAL;
  }

  private parseEffort(value?: string): CreateTaskInput['estimatedEffort'] {
    const valid = ['trivial', 'small', 'medium', 'large', 'xlarge'];
    if (value && valid.includes(value.toLowerCase())) {
      return value.toLowerCase() as CreateTaskInput['estimatedEffort'];
    }
    return undefined;
  }
}
