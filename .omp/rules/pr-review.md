---
name: pr-review-worktree
description: PR review ("harness review the pr") runs EXCLUSIVELY in a dedicated git worktree with plain git — never in the GitButler workspace; GitButler builds, worktree reviews
alwaysApply: true
---

## PR Review — Worktree Only - MANDATORY (user ruling 2026-10-22)

When the user asks for a PR review ("harness review the pr"), the review runs **EXCLUSIVELY in a dedicated git worktree**. Never inside the GitButler base checkout.

- **GitButler builds, worktree reviews.** Feature, bug, and chore flows go through GitButler lanes (`but`). PR review never touches the workspace checkout and never uses `but` for review.
- **Setup** (from the base checkout `~/projects/work/kelp-market`):
  - `git fetch origin pull/<N>/head` then `omp worktree add <path> FETCH_HEAD` (fallback: plain `git worktree add <path> FETCH_HEAD`).
  - Plain git commands (`git log`, `git diff`, `git checkout`, tests, builds) are allowed ONLY inside that worktree.
- **Review is read-only**: deliver findings in chat. Fixes, if requested afterward, become normal GitButler lane work back in the base checkout — never committed from the review worktree.
- **Cleanup**: remove the review worktree once findings are delivered.
- **Exception**: only the user's explicit contrary instruction in the current conversation ("review it on the lane") overrides this.
