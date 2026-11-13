---
name: land-push-gates
description: >
  Governs how kelp-market lanes are pushed and gated: the `pnpm push
  <branch>` gate wrapper (scripts/land.mjs), the fixed gate order (lanes
  check → lint → semgrep → schema freeze → but push), the frozen
  `init.surql` baseline rule, and the SSH-over-443 / prune-remote details.
  Integration is GitHub PRs only — landing is disabled (2026-11-04 ruling).
  Use when pushing a GitButler lane, when `pnpm push` fails or a gate
  blocks, when touching `market/packages/db/schemas/init.surql`, when SSH
  to github.com hangs on port 22, or when cleaning up stale
  `origin/<lane>` backup refs.
---

# pnpm push — gate wrapper and branch forwarding

`pnpm push <branch>` is the only wrapper entry point (push = backup of
work in progress; `pnpm f` first). **Integration is GitHub PRs only —
landing is disabled** (2026-11-04 ruling): NEVER run `but land`,
`pnpm land`, or `--whole-stack`; the user merges PRs. The `land` op in
`scripts/land.mjs` remains only as dead code.

## Why a Node wrapper (never chain gates in package.json)

pnpm appends extra CLI args to the END of the script string. Chained
scripts misdeliver `<branch>`: in `"push": "… && but push && node …
prune"` the arg would go to `lanes prune` (ignored) and `but push`
would error after the gates. Only a trailing script got the arg by
luck. The wrapper parses `<branch>` itself, so never "fix" this by
chaining shell commands.

## Execution order (invariants)

1. **Gates, in parallel** (`Promise.all`, ~wall of slowest gate):
   - `pnpm lanes check` — lane authorship gate (forward-only).
   - `pnpm lint` — turbo lint across in-scope packages.
   - `pnpm semgrep` — SAST, full `p/ci` ruleset for remote-CI parity.
     No `--jobs` sizing (measured no gain). `SKIP_SEMGREP=1` is NOT
     honored here; to skip SAST for a pure WIP backup, call
     `but push <branch>` directly instead (allowed: one push per lane).
   - `node scripts/schema-freeze.mjs` — frozen-baseline gate (below).
2. **`but push <branch> [extra flags…]`** — the push step, strictly
   AFTER all gates.

- NEVER reorder gates before/after the `but` step.
- Branch is NEVER optional: untargeted push errors by design
  (GitButler stacks make "current branch" ambiguous).
- Missing or flag-shaped branch exits 2 with usage error BEFORE any
  gate runs — cheap, no minute of lint/semgrep burned.
- Extra args pass through: `pnpm push feat/x -- --force-with-lease` →
  `but push feat/x --force-with-lease`.
- Entry point: `"push": "node scripts/land.mjs push"` in root
  package.json (`"land": "node scripts/land.mjs land"` is dead —
  landing disabled; leave it so old muscle memory fails into the gate
  wrapper, not raw `but`).
- `but` is the only git-write surface in workspace mode; plain
  `git add`/`git commit`/`git push` are forbidden.

## Frozen schema baselines (schema-freeze gate)

`scripts/schema-freeze.mjs` refuses any push that changes either
`market/packages/db/schemas/init.surql` or
`market/packages/db/src/db/analytics` (Drizzle schema + migrations) vs the `origin/main` worktree baseline.
Remote backstop: `schema-freeze` job in ci.yml; `.husky/pre-push` runs
the same script on the plain `git push` path. Schema changes ship as
NEW numbered migration pairs (market/packages/db/schemas/migrations/
or schemas/analytics/migrations/) — NEVER edit a baseline (re-triggers the
2026-10-25 prod incident: pod restarts re-applied DDL the live schema
never had, wedging every `surreal-schema` init container). Full
lifecycle + recovery: `docs/system/market-db-tables.md` § Frozen schema
baselines.

## Remote over SSH:443

`origin` is `ssh://git@ssh.github.com:443/kelp-hq/kelp-market.git`,
NOT plain `git@github.com:…`. Port 22 intermittently hangs ~75s at TCP
connect then fails (rate/flow-based, not a firewall — both ports probe
fine on retry). Pinned config (`known_hosts` entry
`[ssh.github.com]:443`; `~/.ssh/config` for that host):
`IdentityFile id_rsa`, `IdentityAgent none`, `IdentitiesOnly yes` —
the `Host *` 1Password-agent block is not honored by `but`'s libssh2.
Measured: `ssh -T -p 443` auth ~2s; `but push` wall ~65s, no hang.

## Prune-remote (backup-ref cleanup)

`node scripts/lanes.mjs prune-remote [--dry-run]` deletes
`origin/<lane>` backup refs whose commits are patch-equivalent to
`origin/main` (merged lanes, dead-weight backups); keeps refs with real
unlanded WIP.

- Per-ref pushes, one deletion per `git push origin --delete` — a
  batched push where one ref errors deletes NOTHING (verified failure mode).
- Runs `git fetch --prune` first; stale tracking refs otherwise produce
  `remote ref does not exist` errors mid-run.
- Hook runs with `SKIP_SEMGREP=1` via env: ref deletion pushes no code;
  a full scan is dead cost. (Fine here — the wrapper is the only place
  SKIP_SEMGREP is not honored.)
- `prune` (no suffix) is the local twin: deletes local lanes whose
  commits reached `origin/main` (i.e. after their PR merged and
  `but pull` synced).
