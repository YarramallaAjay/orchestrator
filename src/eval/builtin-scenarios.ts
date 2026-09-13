import type { EvalScenario } from './types.js';

/**
 * Built-in eval scenarios for sanity checking the orchestrator.
 */
export const builtinScenarios: EvalScenario[] = [
  {
    name: 'sanity-todo-app',
    description: 'Decompose a simple TODO app into tasks. Validates basic planning and task count.',
    requirements: `Build a simple command-line TODO application with the following features:
- Add a new TODO item with a title
- List all TODO items
- Mark a TODO item as complete
- Delete a TODO item
- Persist TODOs to a JSON file

Use TypeScript and Node.js. Include basic input validation.`,
    expectedTaskCount: { min: 4, max: 8 },
    maxBudgetUsd: 1.0,
    maxDurationMs: 300_000,
    validationChecks: [
      {
        name: 'task_count_in_range',
        type: 'all_tasks_completed',
      },
      {
        name: 'cost_under_budget',
        type: 'cost_under',
        threshold: 1.0,
      },
      {
        name: 'success_rate',
        type: 'task_success_rate',
        threshold: 0.8,
      },
    ],
  },
  {
    name: 'planning-quality',
    description: 'Feed complex requirements and validate planning quality: classification distribution, dependency correctness, acceptance criteria presence.',
    requirements: `Build a REST API for a blog platform:
- User authentication with JWT tokens (signup, login, logout)
- CRUD operations for blog posts (title, content, author, tags)
- Comment system with nested replies
- Tag-based search and filtering
- Rate limiting middleware
- Input validation with Zod schemas
- Database with PostgreSQL using Drizzle ORM
- Unit tests for all endpoints
- API documentation with OpenAPI/Swagger

The API should follow RESTful conventions and include proper error handling.`,
    expectedTaskCount: { min: 6, max: 20 },
    expectedClassifications: {
      'MODULE': 3,
      'CROSS_MODULE': 2,
    },
    maxBudgetUsd: 2.0,
    maxDurationMs: 600_000,
    validationChecks: [
      {
        name: 'all_tasks_have_criteria',
        type: 'custom',
      },
      {
        name: 'no_dependency_cycles',
        type: 'custom',
      },
      {
        name: 'reasonable_task_count',
        type: 'all_tasks_completed',
      },
    ],
  },
  {
    name: 'retry-resilience',
    description: 'Include a task with a validation script that fails the first time. Verify retry occurs and succeeds.',
    requirements: `Create a simple utility module with:
- A function to format dates in ISO format
- A function to parse command-line arguments
- A function to read and parse a YAML config file

Include unit tests. The date formatter must handle edge cases.`,
    expectedTaskCount: { min: 3, max: 6 },
    maxBudgetUsd: 1.0,
    maxDurationMs: 300_000,
    validationChecks: [
      {
        name: 'retry_occurred',
        type: 'retry_rate_under',
        threshold: 1.0,
      },
      {
        name: 'eventual_success',
        type: 'task_success_rate',
        threshold: 0.5,
      },
    ],
  },
  {
    name: 'file-conflict-prevention',
    description: 'Verify that tasks with overlapping targetFiles are serialized (not run concurrently). Two tasks target the same file — they must not run in parallel.',
    requirements: `Create a shared utility module:
- Task A: Create src/utils/helpers.ts with string formatting functions
- Task B: Add date formatting functions to src/utils/helpers.ts
- Task C: Create src/utils/validators.ts with input validators
- Task D: Write tests for all utility functions

Tasks A and B both target src/utils/helpers.ts and must be serialized.
Tasks A and C can run in parallel (different files).`,
    expectedTaskCount: { min: 3, max: 6 },
    maxBudgetUsd: 1.5,
    maxDurationMs: 300_000,
    validationChecks: [
      {
        name: 'no_file_conflicts',
        type: 'custom',
      },
      {
        name: 'tasks_with_shared_files_serialized',
        type: 'custom',
      },
      {
        name: 'all_tasks_have_target_files',
        type: 'custom',
      },
    ],
  },
  {
    name: 'discovery-quality',
    description: 'Verify that the discovery agent produces accurate file analysis and identifies relevant code patterns before planning.',
    requirements: `Add a new API endpoint to the existing Express app:
- GET /api/users/:id/posts — returns all posts by a user
- Include pagination support (page, limit query params)
- Add input validation
- Write integration tests

The discovery agent should identify existing route files, models, and test patterns.`,
    expectedTaskCount: { min: 3, max: 8 },
    maxBudgetUsd: 2.0,
    maxDurationMs: 600_000,
    validationChecks: [
      {
        name: 'discovery_produced_relevant_files',
        type: 'custom',
      },
      {
        name: 'discovery_found_patterns',
        type: 'custom',
      },
      {
        name: 'planning_used_discovery',
        type: 'custom',
      },
    ],
  },
  {
    name: 'skill-assignment',
    description: 'Verify that the correct skills are assigned per task based on tags and target files.',
    requirements: `Build a calculator library:
- Core calculation functions (add, subtract, multiply, divide)
- Unit tests for all functions
- CLI wrapper for interactive use
- Package.json setup with build and test scripts

Testing tasks should get the test-runner skill. All tasks should get shared-context.`,
    expectedTaskCount: { min: 3, max: 6 },
    maxBudgetUsd: 1.0,
    maxDurationMs: 300_000,
    validationChecks: [
      {
        name: 'test_tasks_have_test_runner',
        type: 'custom',
      },
      {
        name: 'all_tasks_have_shared_context',
        type: 'custom',
      },
      {
        name: 'cost_under_budget',
        type: 'cost_under',
        threshold: 1.0,
      },
    ],
  },
];
