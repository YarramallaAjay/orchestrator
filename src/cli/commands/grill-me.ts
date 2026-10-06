import { Command } from 'commander';
import { createInterface } from 'node:readline';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import chalk from 'chalk';

interface Message {
  role: 'user' | 'assistant';
  content: string;
}

const TOPICS: Record<string, string> = {
  vision: 'What is this project? What is it NOT? Who is it for?',
  architecture: 'Provider agnosticism, plugin systems, workflow engines, runtime abstractions',
  priorities: 'What to build next, what to defer, what to kill',
  gaps: 'Current state vs desired state — what\'s missing, what\'s broken, what\'s pretending to work',
  differentiators: 'Why this over LangChain, CrewAI, AutoGen, and other frameworks',
};

const CODEBASE_CONTEXT = `
Current state of the project (factual):

- CLI tool called "orch" (npm package: dev-orchestrator)
- Core pipeline: plan → approve → schedule → execute → validate with human-in-the-loop approval
- Agent execution via Claude CLI subprocess only (ClaudeCliRuntime spawns "claude" commands)
- There's an ApiRuntime that calls Anthropic Messages API directly, but it's single-turn only
- Git worktree isolation for parallel task execution
- DAG-based task scheduling with dependency resolution (TaskGraph)
- SQLite database via Drizzle ORM for state persistence
- Session management with resume capability
- Event bus for real-time updates
- Performance metrics tracking (cost, tokens, tool calls, turns, duration)
- Context system with ContextStore/ContextRepository for shared context entries
- Observation system (ObservationStore) for cross-session knowledge
- MCP sidecar infrastructure (publish_observation, store_memory, recall_memory tools)
- "orch wrap" command that wraps Claude Code with context injection hooks
- Eval framework (partially working)
- Hooks system for Claude Code integration (SessionStart, UserPromptSubmit)
- No plugin/extension system
- No workflow engine beyond the DAG task scheduler
- No provider abstraction beyond Claude — runtime interfaces exist but only Claude implementations
- The harness system only has a ClaudeCodeAdapter
`.trim();

function buildSystemPrompt(topic?: string): string {
  const topicInstruction = topic && TOPICS[topic]
    ? `\n\nFocus area for this session: "${topic}" — ${TOPICS[topic]}\nStart your questioning in this area, but follow threads wherever they lead.`
    : '\n\nNo specific topic was requested. Identify the most important area of fog or contradiction and start there.';

  return `You are a tough but constructive Socratic questioner helping a developer think clearly about their software project.

Your job is to:
- Ask ONE pointed question at a time
- Be specific — no softballs, no generic questions
- Challenge vague answers — if someone says "it'll be modular" or "it's extensible", demand specifics
- Don't accept buzzwords without substance
- Probe contradictions between what the project IS and what it ASPIRES to be
- When an answer is clear and specific, acknowledge it briefly and move to the next gap
- When an answer is vague or hand-wavy, drill deeper on the same point
- Be direct and concise — no filler, no excessive praise

Here is the current state of the project you're grilling about:

${CODEBASE_CONTEXT}
${topicInstruction}

Output format during questioning rounds:
- Ask exactly ONE question
- Keep it under 3 sentences
- No preamble, no numbering, just the question (you may include 1 sentence of context before the question if needed)

When asked for a clarity report, produce a structured summary with these sections:
## What's Clear
(Things the user articulated well and has concrete answers for)

## What's Still Foggy
(Areas where answers were vague, contradictory, or missing)

## Next Questions to Resolve
(Specific questions the user should answer before building more)

## Key Tensions
(Contradictions or trade-offs that surfaced during the conversation)`;
}

async function callApi(
  messages: Message[],
  systemPrompt: string,
  model: string,
): Promise<string> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error(
      'ANTHROPIC_API_KEY environment variable is required.\n' +
      'Set it with: export ANTHROPIC_API_KEY=your-key-here',
    );
  }

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model,
      max_tokens: 1024,
      system: systemPrompt,
      messages,
    }),
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`API request failed (${response.status}): ${errorBody}`);
  }

  const result = await response.json() as any;
  const textBlocks = (result.content ?? []).filter((b: any) => b.type === 'text');
  return textBlocks.map((b: any) => b.text).join('\n');
}

export const grillMeCommand = new Command('grill-me')
  .description('Socratic grilling session — forces you to articulate and defend your project vision')
  .option('--topic <topic>', `Focus area: ${Object.keys(TOPICS).join(', ')}`)
  .option('--rounds <n>', 'Max number of question rounds', '10')
  .option('--model <model>', 'Model to use', 'claude-sonnet-4-6')
  .option('--save', 'Save transcript and clarity report to .orchestrator/grill-sessions/')
  .action(async (options) => {
    const topic: string | undefined = options.topic;
    const maxRounds = parseInt(options.rounds, 10) || 10;
    const model: string = options.model;
    const save: boolean = options.save ?? false;

    // Validate topic
    if (topic && !TOPICS[topic]) {
      console.error(chalk.red(`Unknown topic: ${topic}`));
      console.error(chalk.dim(`Available topics: ${Object.keys(TOPICS).join(', ')}`));
      process.exit(1);
    }

    console.log('');
    console.log(chalk.cyan.bold('  orch grill-me'));
    console.log(chalk.dim('  ─────────────────────────────────'));
    if (topic) {
      console.log(`  ${chalk.white('Topic:')}    ${chalk.green(topic)} — ${TOPICS[topic]}`);
    } else {
      console.log(`  ${chalk.white('Topic:')}    ${chalk.dim('freestyle (LLM picks)')}`);
    }
    console.log(`  ${chalk.white('Rounds:')}   ${chalk.dim(String(maxRounds))}`);
    console.log(`  ${chalk.white('Model:')}    ${chalk.dim(model)}`);
    console.log(chalk.dim('  ─────────────────────────────────'));
    console.log(chalk.dim('  Type your answers. Type "done" or press Ctrl+C to end early.'));
    console.log('');

    const systemPrompt = buildSystemPrompt(topic);
    const messages: Message[] = [];
    const transcript: Array<{ role: string; content: string }> = [];

    // Get first question
    messages.push({ role: 'user', content: 'Begin the grilling session. Ask your first question.' });

    let firstQuestion: string;
    try {
      firstQuestion = await callApi(messages, systemPrompt, model);
    } catch (err: any) {
      console.error(chalk.red(err.message));
      process.exit(1);
    }

    messages.push({ role: 'assistant', content: firstQuestion });
    transcript.push({ role: 'question', content: firstQuestion });
    console.log(chalk.yellow.bold('Q:'), firstQuestion);
    console.log('');

    // Interactive loop
    const rl = createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    let round = 1;
    let aborted = false;

    const askForInput = (): Promise<string> => {
      return new Promise((resolve, reject) => {
        rl.question(chalk.green('A: '), (answer) => {
          resolve(answer);
        });
        rl.once('close', () => {
          aborted = true;
          resolve('done');
        });
      });
    };

    while (round < maxRounds) {
      const answer = await askForInput();

      if (aborted || answer.toLowerCase().trim() === 'done') {
        console.log('');
        break;
      }

      transcript.push({ role: 'answer', content: answer });
      messages.push({ role: 'user', content: answer });
      round++;

      if (round >= maxRounds) {
        console.log('');
        console.log(chalk.dim(`  Max rounds (${maxRounds}) reached.`));
        break;
      }

      // Get next question
      let nextQuestion: string;
      try {
        nextQuestion = await callApi(messages, systemPrompt, model);
      } catch (err: any) {
        console.error(chalk.red(`API error: ${err.message}`));
        break;
      }

      messages.push({ role: 'assistant', content: nextQuestion });
      transcript.push({ role: 'question', content: nextQuestion });

      console.log('');
      console.log(chalk.yellow.bold('Q:'), nextQuestion);
      console.log('');
    }

    rl.close();

    // Generate clarity report
    console.log(chalk.dim('  Generating clarity report...'));
    console.log('');

    messages.push({
      role: 'user',
      content: 'The grilling session is over. Generate the clarity report now, summarizing what\'s clear, what\'s still foggy, the next questions to resolve, and any key tensions that surfaced.',
    });

    let report: string;
    try {
      report = await callApi(messages, systemPrompt, model);
    } catch (err: any) {
      console.error(chalk.red(`Failed to generate report: ${err.message}`));
      process.exit(1);
    }

    console.log(chalk.cyan.bold('  ━━━ Clarity Report ━━━'));
    console.log('');
    console.log(report);
    console.log('');

    // Save if requested
    if (save) {
      const sessionDir = resolve(process.cwd(), '.orchestrator', 'grill-sessions');
      mkdirSync(sessionDir, { recursive: true });

      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const filename = `${timestamp}${topic ? `-${topic}` : ''}.md`;
      const filepath = resolve(sessionDir, filename);

      const transcriptMd = [
        `# Grill Session${topic ? ` — ${topic}` : ''}`,
        ``,
        `**Date:** ${new Date().toISOString()}`,
        `**Model:** ${model}`,
        `**Rounds:** ${round}`,
        ``,
        `## Transcript`,
        ``,
        ...transcript.map((entry) => {
          if (entry.role === 'question') {
            return `**Q:** ${entry.content}\n`;
          }
          return `**A:** ${entry.content}\n`;
        }),
        `## Clarity Report`,
        ``,
        report,
      ].join('\n');

      writeFileSync(filepath, transcriptMd, 'utf-8');
      console.log(chalk.green(`  Saved to ${filepath}`));
      console.log('');
    }
  });
