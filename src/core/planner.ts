import { readFileSync } from 'node:fs';
import type { AgentRuntime, AgentMessage } from '../agent/runtimes/runtime.js';
import type { CreateTaskInput } from '../task/types.js';
import { TaskClassification } from '../task/types.js';
import { logger } from '../util/logger.js';

interface PlannerConfig {
  projectId: string;
  model?: string;
  maxTurns?: number;
}

interface DecomposedTask {
  title: string;
  description: string;
  classification: string;
  priority: number;
  dependsOn: string[];
  tags: string[];
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

const PLANNER_SYSTEM_PROMPT = `You are a software project planner. Your job is to decompose high-level requirements into a structured task graph.

You must output valid JSON matching this schema:
{
  "tasks": [
    {
      "title": "Short task title",
      "description": "Detailed description of what to build/do",
      "classification": "LOCAL|MODULE|CROSS_MODULE|AGENT|HUMAN_IN_THE_LOOP|AUTONOMOUS",
      "priority": <number, 0=highest>,
      "dependsOn": ["<title of dependency task>"],
      "tags": ["backend", "frontend", "database", etc.],
      "acceptanceCriteria": ["Criterion 1", "Criterion 2"],
      "validationScript": "optional command to validate",
      "estimatedEffort": "trivial|small|medium|large|xlarge"
    }
  ],
  "context": {
    "architecture": "Brief architecture description",
    "decisions": ["Key architecture decision 1", "Decision 2"],
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
10. Output ONLY the JSON, no other text.`;

/**
 * Uses an LLM agent to decompose requirements into a task graph.
 */
export class Planner {
  constructor(
    private runtime: AgentRuntime,
    private config: PlannerConfig,
  ) {}

  /**
   * Decompose a requirements document/string into tasks.
   */
  async decompose(requirements: string): Promise<CreateTaskInput[]> {
    logger.info('Decomposing requirements into task graph');

    const prompt = `Decompose the following requirements into a structured task graph:\n\n${requirements}`;

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
        maxTurns: this.config.maxTurns ?? 3,
        permissionMode: 'default',
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

    // Extract JSON from the assistant's response
    const assistantMessages = messages.filter((m) => m.role === 'assistant');
    const fullContent = assistantMessages.map((m) => m.content).join('\n');

    // Also check the final result messages
    if (result?.messages) {
      const resultContent = result.messages
        .filter((m) => m.role === 'assistant')
        .map((m) => m.content)
        .join('\n');
      if (resultContent) {
        return this.parseDecomposition(resultContent || fullContent);
      }
    }

    return this.parseDecomposition(fullContent);
  }

  /**
   * Decompose from a requirements file.
   */
  async decomposeFile(filePath: string): Promise<CreateTaskInput[]> {
    const content = readFileSync(filePath, 'utf-8');
    return this.decompose(content);
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
    // We'll assign temporary IDs based on index for dependency resolution
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
        dependsOn: [], // Will be resolved after all tasks are created
        tags: t.tags ?? [],
        acceptanceCriteria: t.acceptanceCriteria ?? [],
        validationScript: t.validationScript,
        estimatedEffort: this.parseEffort(t.estimatedEffort),
      });
    }

    // Store dependency info for post-creation resolution
    // The caller (orchestrator) will need to resolve these after creating tasks
    for (let i = 0; i < parsed.tasks.length; i++) {
      const t = parsed.tasks[i]!;
      if (t.dependsOn?.length) {
        const depIndices = t.dependsOn
          .map((title) => titleMap.get(title))
          .filter((idx): idx is number => idx !== undefined);
        // Store as __temp_N references - the orchestrator will resolve
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
