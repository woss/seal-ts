---
name: docs-audit
description: >
  Audit or update authored repo documentation and agent-facing skills
  (docs/, .omp/skills/, AGENTS.md files) against implementation evidence,
  within a requested topic or diff. Run when a change touches a surface
  covered by a doc or skill — larger than a one-line same-commit touch-up.
---

# Docs/Skill Audit

Agent-facing prose rots fast and agents trust it over the code (arXiv
2610.30571). Dead references are caught mechanically by `pnpm agent-docs`
(CI + pre-push + land/push gates) — this skill covers the part no regex
can check: correctness of semantics, commands' meaning, and conventions.

## Scope check

- `AGENTS.md`, `CLAUDE.md`, `docs/**/*.md`, `.omp/skills/**/SKILL.md` are
  in scope. `plans/` is NOT (plans describe target states, not shipped
  behavior — see `.omp/rules/plans.md`).
- A one-line drift (path moved, flag renamed): fix in the same commit as
  the change; do not run the full audit.

## Procedure

1. **Inventory.** List the docs/skills the diff's surfaces are covered
   by: grep `docs/` + `.omp/skills/` for the changed symbols, route
   paths, script names, and workflow names. Nothing found → done
   (report "no coverage").
2. **Doc-first.** For each in-scope file: extract its checkable claims
   (paths, commands, flags, defaults, limits, gates). Verify each against
   the implementation at the named location, not against memory.
3. **Code-first.** Scan the diff for behavior changes with no doc/skill
   mention anywhere: new or renamed scripts, routes, env vars, gate
   steps, user-visible flags. Missing coverage → propose the exact
   file + insertion point (skill for procedures, docs/ for reference).
4. **Conventions.** Check the precedence rule (AGENTS.md § Docs/Code
   Precedence) holds in the docs you touch: code is truth, docs describe
   it. Flag any doc that instructs agents to "fix" working code.

## Report format

- Correct/outdated docs: file → claims verified OR issue + correct info
  + evidence (file:line).
- Coverage gaps: diff surface → suggested doc/skill file + section.
- Proposed edits: file → one-line summary each.
- Unresolved decisions only when they block a correct fix.
