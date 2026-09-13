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
2. Before editing, check the current branch, worktree, and remote status.
3. If the worktree is not clean, stop and report the existing changes; do not reset, discard, or overwrite them.
4. Create and switch to a dedicated feature branch before implementation. Use the pattern `feat/<short-task-name>`.
5. Astra writes the implementation plan and identifies dependencies and risks.
6. Astra defines request and response schemas before implementation begins.
7. Astra writes the task prompts, including branch name, ownership, acceptance criteria, and verification commands.
8. Astra dispatches independent tasks to GLM-5 and DeepSeek-V4-Flash in parallel when their write sets do not overlap.
9. Astra inspects worker diffs, resolves integration issues, and runs the project checks.
10. Astra performs a final review for correctness, security, regressions, scope, and test coverage.
11. Do not declare completion until the relevant checks pass and the final diff has been reviewed.

## Git Branch Workflow

- Every independent implementation task must use its own branch created from the latest `main`.
- Do not implement directly on `main`.
- Do not create multiple workers that edit the same files or share the same feature branch.
- A task branch should use a specific name such as `feat/foundation`, `feat/contracts`, or `feat/map-ui`.
- Before creating a branch, run `git fetch origin` and update the local base only when the worktree is clean.
- Never use `git reset --hard`, `git checkout --`, or broad deletion commands to resolve worktree or merge issues.
- The task owner may commit completed work to its task branch after verification.
- Task branches must not be pushed or merged automatically unless the user explicitly requests it.
- The controller owns integration and should merge task branches into `main` in dependency order.
- After each merge, run `npm test` and `npm run check`; when server code changes, start the server and verify `/api/health`.
- If a merge conflict occurs, stop and report the conflicting files and the proposed resolution. Do not silently choose one side.
- Push `main` only after the integrated changes pass the final review and the user explicitly requests the push.

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
