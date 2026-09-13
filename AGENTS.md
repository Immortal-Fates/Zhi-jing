# Vibe Coding Orchestration

This project uses GPT-6-Astra as the controller and delegates implementation work to local worker models.

## Session Entry

Start the main Codex session from the project root:

```bash
codex -C "$PWD" -m gpt-6-astra -c 'model_reasoning_effort="xhigh"'
```

Use `xhigh` for Astra controller work. The local model catalog currently exposes `gpt-6-astra`, `glm-5`, and `deepseek-v4-flash`.

## Model Routing

- GPT-6-Astra: requirements analysis, architecture, API contracts, prompt design, task decomposition, scheduling, integration, and final review.
- GLM-5: backend implementation, business logic, data flow, and complex code changes.
- DeepSeek-V4-Flash: small modules, tests, documentation, fixtures, and repetitive implementation.

When spawning a worker, assign a disjoint file or module ownership boundary. Use GLM-5 with `high` reasoning for complex implementation and DeepSeek-V4-Flash with `medium` reasoning for bounded tasks.

## Required Workflow

1. Read this file, the relevant product documents, source files, and tests.
2. Astra writes the implementation plan and identifies dependencies and risks.
3. Astra defines request and response schemas before implementation begins.
4. Astra writes the task prompts, including ownership, acceptance criteria, and verification commands.
5. Astra dispatches independent tasks to GLM-5 and DeepSeek-V4-Flash in parallel when their write sets do not overlap.
6. Astra inspects worker diffs, resolves integration issues, and runs the project checks.
7. Astra performs a final review for correctness, security, regressions, scope, and test coverage.
8. Do not declare completion until the relevant checks pass and the final diff has been reviewed.

## Worker Contract

Workers must read the current repository state before editing, keep changes within the assigned ownership boundary, avoid unrelated refactors, remove dead code, and report changed files plus verification results. Workers must not add comments that only describe a recent change.

## Ownership Rules

The controller owns shared contracts, cross-module integration, and final decisions. A worker must not modify files owned by another worker. If a task crosses ownership boundaries, stop and return the dependency to Astra for repartitioning.

## Verification

Use the repository's existing commands first. For this project, the baseline checks are:

```bash
npm test
npm run check
```

When the server changes, also start it and verify `/api/health`.
