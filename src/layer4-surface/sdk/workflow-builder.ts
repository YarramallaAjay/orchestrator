/**
 * Fluent workflow builder.
 *
 * Usage:
 *   const workflow = Workflow.create('deploy')
 *     .step('plan', planAgent, 'Create deployment plan')
 *     .step('build', buildAgent, 'Build artifacts', { dependsOn: ['plan'] })
 *     .step('test', testAgent, 'Run tests', { dependsOn: ['build'] })
 *     .step('deploy', deployAgent, 'Deploy to production', { dependsOn: ['test'] })
 *     .constraints({ maxConcurrent: 2, maxBudgetUsd: 5 })
 *     .build();
 */

import type { AgentDefinition } from '../../platform/types.js';
import type { WorkflowDefinition, WorkflowNodeInput } from '../../layer3-engine/composition/workflow-orchestrator.js';
import type { SchedulerConstraints, Scheduler } from '../../layer3-engine/composition/scheduler-interface.js';

// ─── Step Options ───────────────────────────────────────────────────────────

export interface StepOptions {
  dependsOn?: string[];
  priority?: number;
}

// ─── Workflow Builder ───────────────────────────────────────────────────────

export class WorkflowBuilder {
  private _name: string;
  private _nodes: WorkflowNodeInput[] = [];
  private _constraints: Partial<SchedulerConstraints> = {};
  private _cwd = '.';
  private _projectId?: string;
  private _scheduler?: Scheduler;

  private constructor(name: string) {
    this._name = name;
  }

  static create(name: string): WorkflowBuilder {
    return new WorkflowBuilder(name);
  }

  /**
   * Add a step (node) to the workflow.
   */
  step(
    name: string,
    agent: AgentDefinition,
    prompt: string,
    options?: StepOptions,
  ): WorkflowBuilder {
    this._nodes.push({
      id: name,
      name,
      agent,
      prompt,
      dependsOn: options?.dependsOn,
      priority: options?.priority,
    });
    return this;
  }

  /**
   * Add multiple parallel steps that share the same dependencies.
   */
  parallel(
    steps: Array<{ name: string; agent: AgentDefinition; prompt: string }>,
    options?: { dependsOn?: string[]; priority?: number },
  ): WorkflowBuilder {
    for (const s of steps) {
      this.step(s.name, s.agent, s.prompt, options);
    }
    return this;
  }

  /**
   * Set scheduling constraints.
   */
  constraints(constraints: Partial<SchedulerConstraints>): WorkflowBuilder {
    this._constraints = { ...this._constraints, ...constraints };
    return this;
  }

  /**
   * Set the working directory.
   */
  cwd(dir: string): WorkflowBuilder {
    this._cwd = dir;
    return this;
  }

  /**
   * Set the project ID.
   */
  projectId(id: string): WorkflowBuilder {
    this._projectId = id;
    return this;
  }

  /**
   * Use a custom scheduler.
   */
  scheduler(s: Scheduler): WorkflowBuilder {
    this._scheduler = s;
    return this;
  }

  /**
   * Build the workflow definition.
   */
  build(): WorkflowDefinition {
    if (this._nodes.length === 0) {
      throw new Error('Workflow must have at least one step');
    }

    // Validate dependencies
    const nodeIds = new Set(this._nodes.map((n) => n.id ?? n.name));
    for (const node of this._nodes) {
      for (const dep of node.dependsOn ?? []) {
        if (!nodeIds.has(dep)) {
          throw new Error(
            `Step "${node.name}" depends on "${dep}" which does not exist in the workflow`,
          );
        }
      }
    }

    return {
      name: this._name,
      nodes: this._nodes,
      constraints: this._constraints,
      cwd: this._cwd,
      projectId: this._projectId,
      scheduler: this._scheduler,
    };
  }
}

/** Convenience alias for the builder. */
export const Workflow = WorkflowBuilder;
