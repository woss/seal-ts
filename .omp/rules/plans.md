---
name: plans-directory
description: All plans go to plans/; done-feature docs live in docs/ per AGENTS.md — never repo root, docs/, or .devops/
alwaysApply: true
---

## Plan File Location - MANDATORY

Every plan, roadmap, or planning document (implementation plans, research + plan docs, phase/task breakdowns, feature plans, migration plans) MUST be written under `plans/`:

- Top-level plans: `plans/<topic>.md`
- NEVER repo root, `docs/`, `.devops/`, `market/docs/`, or any package/app directory
- Updating an existing plan: edit it in place where it lives; if it lives outside `plans/`, move it there first

Done-feature docs live in `docs/` — see AGENTS.md § Docs & Plans Taxonomy for the full convention.

## Plan Format (OKF) - MANDATORY

**At creation** — the moment you write a new file into `plans/` or `docs/`, it MUST start with OKF v0.2 frontmatter (spec: https://github.com/GoogleCloudPlatform/open-knowledge-format — SPEC.md) before any content:

```yaml
---
type: Plan            # Plan (plans/) | Doc (docs/)
title: <the H1 text>  # must match the body's first H1
description: <one line>
status: draft         # draft | stable | deprecated
generated:
  by: omp/<session-id>   # bare session UUID; use process:<name> for machine-generated
  at: <ISO 8601 with explicit UTC offset, e.g. 2026-10-07T16:30:00Z>
---
```

- `status: draft` at creation; flip to `stable` when executable/approved, `deprecated` when superseded or executed-and-promoted to `docs/` (link the replacement in the body). `status` is a human judgment — automation must never reset it.
- Same rule for docs: new files in `docs/` (shipped-feature/system reference) get frontmatter with `type: Doc` immediately; the template above is the canonical copy-paste source.

**At maintenance** — executed plans are deleted once their unique content is promoted to `docs/`; `status: deprecated` marks the transition before deletion. Frontmatter is machine-validated: run `pnpm okf check` after any plan/doc add, remove, or edit — including the edit that creates the file — and before `but commit` (CI gate in common-turbo-ci.yaml). **There are NO index files**: `plans/README.md` and `docs/README.md` must never exist (user ruling 2026-10-10 — one shared generated file committed by two agents caused repeated lane couplings); `okf check` fails if either is present.

## Design Review Gate + Alternatives Considered - MANDATORY

Every plan under `plans/` that contains design decisions (new subsystem, data
model, public contract, algorithm, license/pricing semantics — anything a
reviewer could reasonably challenge) MUST:

1. Include an `## Alternatives considered` H2 section: at least one viable
   alternative rejected with a concrete reason (complexity, cost, scale,
   maintenance, license restrictions). Rationale mirrors upstream EGM's
   feature-spec standard (vendored at
   `.omp/skills/design-review/standards/feature-spec.md`). Mechanical/chore
   plans (version bumps, migration-only, CI wiring) are EXEMPT.
2. Get one `design-review` pass (`.omp/skills/design-review/SKILL.md`) BEFORE
   the first implementation commit. 🔴 Blocker findings: resolved in the plan
   or explicitly waived by the user in chat. 🟡 Major: resolved or waived with
   a one-line reason. 🟢 Nit: optional.

## Finalize Scope - MANDATORY (user ruling 2026-10-18; amended 2026-11-04: finalize pushes, never lands — and opens the PR if none exists)

"finalize" means the current agent's **OWN GitButler lane only**: delete the plan the own lane added (deletions must ride the lane that committed the add — a deletion from another lane cannot cancel it, and the file resurrects after both land), write docs to the own lane, push the own lane, ensure a PR exists — finalize is NEVER a landing or PR-merge go. NEVER finalize, edit, or commit to **other lanes/branches** — even if their work looks done or review-approved. Only the user's explicit "finalize all" (or naming specific lanes) widens scope. Every file touched during finalize must belong to the own lane; shared-pool discipline applies on top.

Finalize runs this exact procedure, in order (user ruling 2026-10-18):

1. **Make the docs** — `docs/<topic>.md` per the taxonomy above, OKF frontmatter, dense shipped-behavior reference. Always; no memory-only shortcut for bugs or chores.
2. **Delete the plan** — the own lane's plan file under `plans/`.
3. **Commit docs + deleted plan together** on the own lane (`pnpm f`, `pnpm okf check`, `but commit` with the omp footer).
4. **Push** — `pnpm push <own-lane>`. Finalize never lands: the PR is merged only AFTER the finalize commit is on it — docs ready + plan removed, both changes in that single commit. Landing is disabled entirely (user ruling 2026-11-04): the GitHub PR merge is the only integration path.
5. **Open the PR if none exists** (user ruling 2026-11-04) — check `gh pr list --head <own-lane> --state open`; if empty, `gh pr create --head <own-lane> --base main` (stacked lane: `--base <parent lane>`), body summarizing the lane with the omp session footer. If a PR exists, report its number; never merge it.

## Plan Declares Its GitButler Branch - MANDATORY

Every plan, before execution starts, MUST state its GitButler lane: branch name (`feat/<topic>` / `chore/<topic>`, never `gitbutler*`) and the exact command that creates it (`but branch new <branch>`; stack with `--anchor <parent>` when it builds on another feature). The lane is decided BEFORE any edit and recorded in the plan doc — editing first and picking a branch at commit time is a violation. Session start: `but pull`; `but status` first — extend an existing lane, never open a duplicate. Full lane contract: `.omp/rules/worktrees.md`.
