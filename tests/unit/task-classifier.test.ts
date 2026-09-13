import { describe, it, expect } from 'vitest';
import { TaskClassifier } from '../../src/task/task-classifier.js';
import { TaskClassification } from '../../src/task/types.js';

describe('TaskClassifier', () => {
  const classifier = new TaskClassifier();

  it('should classify tasks needing human review', () => {
    expect(classifier.classify({
      projectId: 'p',
      title: 'Deploy to production',
      description: 'Deploy the app',
      tags: [],
    })).toBe(TaskClassification.HUMAN_IN_THE_LOOP);
  });

  it('should classify autonomous tasks', () => {
    expect(classifier.classify({
      projectId: 'p',
      title: 'Run lint check',
      description: 'Lint the code',
      tags: ['lint'],
    })).toBe(TaskClassification.AUTONOMOUS);
  });

  it('should classify module tasks', () => {
    expect(classifier.classify({
      projectId: 'p',
      title: 'Build user service',
      description: 'Create a new service module',
      tags: [],
    })).toBe(TaskClassification.MODULE);
  });

  it('should classify cross-module tasks', () => {
    expect(classifier.classify({
      projectId: 'p',
      title: 'End-to-end integration',
      description: 'Integrate all modules',
      tags: [],
    })).toBe(TaskClassification.CROSS_MODULE);
  });

  it('should classify agent tasks by tags', () => {
    expect(classifier.classify({
      projectId: 'p',
      title: 'Build API',
      description: 'REST endpoints',
      tags: ['backend'],
    })).toBe(TaskClassification.AGENT);
  });

  it('should default to LOCAL', () => {
    expect(classifier.classify({
      projectId: 'p',
      title: 'Fix typo',
      description: 'Correct spelling',
      tags: [],
    })).toBe(TaskClassification.LOCAL);
  });
});
