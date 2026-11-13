---
name: omp-deliver
description: >
  Route code-review findings to the live omp agent session that owns each
  GitButler lane via scripts/omp-deliver.mjs, injecting per-lane prompts into
  their tmux panes. Use when the user says "deliver findings", "send to
  agents", "omp deliver", at the end of a /review run, or when a reviewer
  subagent must hand review findings to lane-owner sessions. Unresolvable
  findings come back as paste-ready manual messages, never dropped.
---

# omp-deliver — deliver review findings to lane-owner agents

A review run ends with findings as JSON. `scripts/omp-deliver.mjs` routes each
finding to the **live omp session whose lane owns the flagged file** and types a
per-lane prompt into that agent's tmux pane, so each lane owner fixes findings
on its own branch. Unresolvable findings are NEVER guessed or dropped — they
return as paste-ready messages for the operator.

## Usage

Findings JSON: `[{ file_path, title, priority?, message? }, ...]`
(`file_path` must be a real repo path — the resolver trusts diff membership;
a typo'd path silently becomes `manual (unattributed)`).

```sh
node scripts/omp-deliver.mjs --findings findings.json --dry-run   # table, no typing
node scripts/omp-deliver.mjs --findings findings.json             # live injection
```

`--findings` is required; `--dry-run` optional. Exit 2 on missing/invalid findings file.

Exit contract: stdout JSON `{ delivered: [{lane, session, pane, paneId}], manual: [{lane?, reason, detail, message}], dryRun? }`; human-readable table on stderr. `delivered` = keystrokes landed (NOT acked by the receiving agent). Each `manual` entry carries a complete paste-ready `message` for the operator.

## Delivery procedure

1. Write findings JSON to a temp file (include `priority` and `message` — they appear in the injected prompt).
2. ALWAYS `--dry-run` first; check the stderr table for expected lane/session/pane targets.
3. Review the plan with the user (typing into other agents' terminals is
   ask-never-assume — delivery is fired explicitly, never automatically at
   review completion).
4. Run without `--dry-run`. Paste any `manual` messages by hand.

## Resolver chain

```
file_path ──► lane(s)        git diff origin/main...<branch> --name-only over all local lanes
                             (branches = git branch minus main and gitbutler*;
                              a file on two lanes delivers to BOTH)
lane ───────► session UUID   git log --format=%H%x00%B%x00 <branch>, newest-first,
                             first footer match "Created by omp (session <uuid>)" wins
UUID ───────► live pane      pgrep -x omp → per-pid lsof for *_<uuid>.jsonl
                             (transcript held open by every interactive TUI)
                             → ps -o tty= → tmux list-panes -a match on
                             #{pane_tty} with #{pane_current_command} == omp
delivery ───                 tmux set-buffer -- <text>; paste-buffer -t <pane> -p
                             (bracketed paste — multi-line prompts never press
                             Enter per line); send-keys Enter
```

Injected prompt format (per lane): heading `Code review findings for your lane <lane> (from the workspace review round):`, then one `- [P<priority>] <title> (<file_path>)` line per finding plus indented `message`, closing with `Fix these on your lane; commit and push as usual.` omp queues it as a user message at the next turn boundary.

## Manual reasons & gotchas

- `unattributed` — file is in no lane's diff (or path typo'd). Paste by hand.
- `session-not-running` — no footer session id on the lane, or the owning
  session has no live omp tmux pane (covers owner outside tmux / in a non-omp
  pane: such panes are skipped silently by the matcher).
- `tmux send-keys` types into whatever the pane has focused; harmless for omp,
  but never run against panes whose current command is not `omp`.
- Findings for the same file held by multiple lanes are delivered to every
  owning lane — expect duplicate prompts on shared files.
