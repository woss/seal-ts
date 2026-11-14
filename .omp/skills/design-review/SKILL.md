---
name: design-review
description: >
  Goldfish design review for repo plan docs (plans/*.md). Spawns fresh,
  zero-context reviewer subagents (comprehension naive-reader, design critic,
  implementation readiness) against vendored EGM rubrics BEFORE implementation
  starts. Triggers: "review this plan/design", "goldfish review <plan>", or
  automatically per .omp/rules/plans.md for any design-decision plan.
---

# Design Review (Goldfish) for plans/

Adapted from google/elephant-goldfish-model (Apache-2.0, SHA 403d8881d62022490637d740657b33f01e321ea8).
Mandatory per `.omp/rules/plans.md` § Design Review Gate: run ONCE on any
`plans/*.md` containing design decisions before the first implementation
commit. EXEMPT: mechanical/chore plans (version bumps, migrations, CI wiring).

## Inputs

`TargetPlan`: path to a `plans/*.md` file. Required; if missing, ask in chat
for the path and end the turn.

## Procedure

1. **Intake.** Read TargetPlan. List every file it references (docs, source
   files, linked plans). Nothing else defines the reviewers' world: reviewers
   read ONLY TargetPlan + referenced files + the vendored standards.

2. **Spawn 3 reviewers in one `task` batch** (one tasks[] call, default
   general agent, read-only instruction inside each prompt). Each prompt must
   include: (a) TargetPlan path, (b) full referenced-file list, (c) the
   standards file path(s) to read FIRST, (d) this line: "You are a Goldfish
   reviewer: strictly read-only, zero knowledge outside the files read for
   this review; no praise, critique first, severity [Blocker | Major | Nit]
   with affected section/pattern and concrete rationale."

   | Reviewer | Read first | Scope |
   |---|---|---|
   | comprehension | standards/comprehension.md | WHOLE doc, Mode REVIEW: paraphrase test (What this proposes / How the existing system works per this document), undefined project-specific terms, assumed knowledge |
   | design-critic | standards/design-critic.md + standards/feature-spec.md (Target Standard) | Feature-level sections against the standard: missing problem/goals/non-goals/architecture, missing `## Alternatives considered` with real reasons, unbacked assertions, unmitigated risks |
   | implementation-readiness | standards/implementation-readiness.md | Detailed implementation section: zero open design decisions, explicit file scope, per-file actionable steps, test plan for each behavior change |

   Reviewers return findings in plain text; do NOT write repo files.

3. **Consolidate.** Merge by finding (dedupe cross-reviewer overlaps). One
   section per severity in order 🔴 Blocker → 🟡 Major → 🟢 Nit. Each finding:
   reviewer(s), plan section/heading anchor, issue, concrete fix suggestion.
   Keep each reviewer's comprehension paraphrase at top for author comparison.

4. **Deliver.** Write the report to `local://design-review-<plan-topic>.md`
   (session-local; NEVER committed) and post the Blocker/Major headline list
   in chat. Triage: apply accepted fixes to TargetPlan as the plan's owning
   lane (shared-pool rules apply); waived findings are recorded in the report
   as accepted trade-offs. Re-run ONLY the comprehension reviewer on the
   changed sections, max 1 re-audit.

5. **Gate.** Any unwaived 🔴 Blocker = plan NOT ready; say so in chat and stop
   before implementation. Implementation may start only when gate conditions
   of `.omp/rules/plans.md` are met.
