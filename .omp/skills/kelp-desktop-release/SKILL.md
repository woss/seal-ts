---
name: kelp-desktop-release
description: >
  Kelp desktop release flow: "release x.y.z" → verify versions/lanes → prep
  lane + version PR → human merges → dispatch desktop-patch.yml cut →
  prerelease tag → human-gated promote. Trigger on "release x.y.z",
  "prepare release", "cut version x.y.z". No auto-merge/bump/build/deploy
  exists anymore (2026-10-29).
---

# Kelp Desktop Release — "release x.y.z"

User says "release 0.7.0" (or "prepare release x.y.z"). This skill is the ONLY release flow: no auto-merge, auto-bump, auto-build, or auto-deploy exist in this repo (removed 2026-10-29). Every step below is deliberate and observable.

## What you tell the user BEFORE touching anything

Print this plan, then execute:

1. **Verify**: current version, requested version, the 4 version files, GitButler lanes clean, gh auth OK.
2. **Prep**: bump the 4 files on a fresh lane `chore/desktop-x.y.z`, open the **version PR** to `main` — you (the agent) never merge it.
3. **Merge is the user's**: human merges on GitHub = approval. Nothing builds on merge.
4. **Cut**: after the PR is MERGED, fetch main, then `gh workflow run desktop-patch.yml --ref main` → it re-verifies version parity + exact match on `main`, then dispatches `desktop-release.yml` (macOS arm64 build + updater artifacts).
5. **Result**: `desktop-v<x.y.z>` prerelease (canary; the updater feed ignores prereleases until promoted).
6. **Promote**: only on explicit user go → `gh workflow run desktop-release.yml -f promote=true`; promote hawk-checks the canary install + feed. NEVER promote silently.

## Step 1 — Verify (blocking checks, in order)

```bash
# current versions (must be 4-file parity now)
grep -m1 '"version"' market/apps/desktop/package.json
# lanes — no uncommitted business work in flight
but status
# gh auth identity + PR-creation rights
gh api user --jq .login
```

Abort and report if: requested ≤ current, parity broken (run `pnpm --filter @kelp_digital/market-desktop exec node scripts/check-versions.mjs`), lanes dirty (other features' uncommitted edits — never steal them), or gh unauthenticated.

## Step 2 — Prep (changelog + bump + PR)

Write the user-facing notes into `market/apps/desktop/CHANGELOG.md` BEFORE
prep: add a `## x.y.z` section on top (plain text — the updater modal renders
it verbatim; groups `New` `Improved` `Fixed`, bullets `- `; user-visible
changes only, since the previous released `desktop-v*` tag). Then:

```bash
pnpm --filter @kelp_digital/market-desktop release <x.y.z>
```

`scripts/release.mjs`: hard-fails without the matching `## x.y.z` section,
fresh GitButler lane `chore/desktop-<x.y.z>`, bumps the 4 files in one clean
edit, commits CHANGELOG.md + the 4 files (exact file IDs only), pushes, opens
the PR with the agent's own gh token (repo blocks Actions creating PRs on
purpose). If it fails mid-way: `but status`, fix nothing silently — report
and stop.

## Step 3 — Merge gate (HUMAN go; agent never merges)

Wait for the user to merge (or paste "merged"). On their word verify:

```bash
gh pr view <PR#> --json state,mergeable --jq '.state'   # must be MERGED
git fetch origin --prune && git rev-parse --short origin/main  # contains the bumped commit
```

If still OPEN → do not cut; report state only.

## Step 4 — Cut (dispatch after verified merge)

```bash
gh workflow run desktop-patch.yml --ref main       # verify parity + dispatch release build
gh run watch $(gh run list -w desktop-patch -L1 --json databaseId -q '.[0].databaseId')
```

For attest-only (version files already carry x.y.z and no build wanted): `-f skipBuild=true`. The cut job is idempotent-guarded — if the 4 files already sit at the requested version on `main` it cuts exactly that version (no drift, no +1).

## Abort / rollback mid-cut

`gh run cancel <run-id>` — cancels the matrix build; a partially-tagged prerelease is deleted manually via `gh release delete desktop-v<x.y.z> --yes && git push origin :refs/tags/desktop-v<x.y.z>`. NEVER re-cut over an existing version without `-f force=true` inside desktop-release.yml.

## Standing rules

- Version PR = the ONLY approval path; the agent MUST NOT merge/approve/re-review it.
- Desktop tag pushes alone no longer cut anything; never push tags to "make a build happen".
- Prod market deploys (`deploy-market.yml`) are unrelated to a desktop release — never dispatched from a desktop release ask.
- Windows legs queue offline; macOS cut completes alone unless the PR labels `desktop:build:win` say otherwise (labels are read at cut time from the PR; wrong-leg cuts are permanent).

## Leg matrix (`desktop-release.yml`)

`desktop:build:mac` on the cut PR → macOS only; `desktop:build:win` → Windows only; no or both labels → all legs `[self-hosted-macos, ${{ vars.DESKTOP_WINDOWS_RUNNER || 'windows-latest' }}]`. Labels are read from the open PR headed by the `--ref` branch at cut time; lookup failure degrades to all legs. Use leg labels ONLY for `workflow_dispatch` canaries or when a platform genuinely doesn't need the release — a cut missing a leg is permanent for that version.

## Build chain (what the release workflow actually produces)

1. `gen-build-configs.mjs` (run per build via `package.json build`) stamps the two gitignored `tauri.conf.{release,dev-nsis}.json` overrides from the latest published `desktop-v*` release — local builds never carry a committed version; `package-update.mjs` refuses to cut a version ≤ the latest published one. `tauri build --config` builds the `.app`.
2. **`patch-bundle.mjs` (the updater-artifact invariant)**: Tauri's bundler drops the pnpm `deploy --legacy` tree's top-level symlinks → sidecar can't resolve deps; fix = `ditto` `resources/server/node_modules` into the `.app` (symlink-faithful) + re-seal ad-hoc (`codesign --force --sign -`). Tauri packs `*.app.tar.gz` from the **pre-patch** bundle and `node_modules` is not in the resources map, so every stock updater archive is structurally broken (Gatekeeper "damaged"). The script re-tars the patched `.app` **over** the stale archive (same filename; CI: `Kelp.Market.app.tar.gz`, local: `Kelp Market.app.tar.gz`), signs it via `pnpm exec tauri signer sign` (`TAURI_SIGNING_PRIVATE_KEY` / `..._PASSWORD` env, exported by the workflow), and skips dev configs (`createUpdaterArtifacts: false`). Sanity: regenerated ≈65MB vs stale ≈9MB. Hardened tar flags (`--no-xattrs --no-mac-metadata`, `COPYFILE_DISABLE=1`) keep `com.apple.provenance` out.
3. **Notarization (optional, auto-skipping)**: when `APPLE_SIGNING_IDENTITY` + `APPLE_ID`/`APPLE_PASSWORD`/`APPLE_TEAM_ID` are set, the script Developer-ID-signs the patched `.app`, notarytool-submits, staples, and signs the `.zip` — all BEFORE the updater re-tar so the staple is inside both artifacts. Unset secrets → ad-hoc signing stays (users right-click open until secrets exist).
4. `ditto -c -k --sequesterRsrc --keepParent` → `kelp-market-<ver>-macos.zip` (manual download path, built from the correctly-sealed `.app`). `upload-artifact` globs four macOS paths only: `macos/*.app.tar.gz`, its `.sig`, the zip (+ `.app` inside).
5. Release job creates `desktop-v$VERSION` **as a draft, uploads all assets, THEN publishes** — under immutable releases, assets must attach before the freeze. Notes: the release-bump PR ships the `## x.y.z` section in `market/apps/desktop/CHANGELOG.md` (release-please shape; prep script gate-enforces it; plain text, NO markdown — the updater modal renders it verbatim; LLM-at-cut is gone — the notes action shipped 2026-11-05 was retired 2026-11-06 after the 0.7.4 cut #1 died `node: command not found`); the publish job extracts the section for `$VERSION` and `gh release create --notes-file`s it; wrong notes are a legal metadata edit on the published release.

## Release immutability (why cuts are single-shot)

Published releases are frozen: asset upload to a published release → HTTP 422 `Cannot transfer`, draft demotion → 422; only **metadata edits** remain legal (prerelease↔stable flip, title/notes). Verified empirically 2026-10-28 on the stranded desktop-v0.6.0 cut. The exists-gate hard-fails — a botched cut burns the version number; recovery = bump + recut (0.6.0 stranded with zero assets 2026-10-28 under the old publish-first flow; user-invisible, abandoned). Pre-flight before the cut because a burned version is unrecoverable: both legs' runners online (`gh api …/runners`; Windows leg only when `DESKTOP_WINDOWS_RUNNER` points at the build PC) and notarization secrets present or ad-hoc accepted. Before trusting promote on a new repo state, probe the freeze on an old release first: `gh release edit <old-tag> --prerelease=true` must succeed.

## Promote mechanics

`gh workflow run desktop-release.yml -f promote=true` flips the release to stable — THIS is what puts the canary on the updater feed — and smoke-tests live: `promote:false` no-ops. The smoke asserts `/api/desktop-updates/latest.json` returns 200 with the right version + download URL, **polling** `latest.json` (6-minute bound, cache-buster per attempt, past its `max-age=300` staleness window) rather than single-shot curling; the download-route asserts stay single-shot (those responses are `no-store`).

## Manual download route (arch-aware)

`/api/download-desktop?os=<mac|win|linux>&arch=<arm64|x64>` streams the matching release asset; defaults are the shipped builds (mac arm64, win x64), unmatched arch/OS combos 404 with the asset list. macOS ships `kelp-market-<v>-macos.zip` (arm64-only; an Intel build would match `…-macos-(x64|intel).zip`), Windows NSIS carries its arch (`…_x64-setup.exe`, `…_(arm64|aarch64)-setup.exe`, x64 falls back to bare `-setup.exe`), Linux 404s until bundles ship. Public pages only ever link `/desktop`, never the route directly (`DownloadCta` `pageLink` mode).

## macOS arch strategy

Current: arm64-only via `self-hosted-macos` (Intel unsupported). Cheap to change later — runtime deps download per-arch at first boot on the user machine (node: `node_triple()` in `src-tauri/src/main.rs`, uv: `UV_TRIPLES` in `src/lib/server/desktop/uv.ts` incl. `darwin-x64` + sha256, exiftool universal perl tarball). Only two pieces carry the build-host arch: the Tauri Rust binary itself, and `fetch-resources.mjs` HOST_TOKENS pruning (the staged sidecar `node_modules` ships only build-host native modules, e.g. `sharp-darwin-arm64`, `@rollup/rollup-darwin-arm64`).

Universal-binary recipe (when Intel/universal is actually needed):
1. Rust toolchain step: `targets: aarch64-apple-darwin,x86_64-apple-darwin`, build with `--target universal-apple-darwin` (Tauri lipo's both slices into one fat binary; bundle output moves `target/release/` → `target/universal-apple-darwin/release/`).
2. Path follow-through: both hardcoded paths in `patch-bundle.mjs`, the zip step's `cd`, and the `upload-artifact` globs must use the new path.
3. `fetch-resources.mjs`: keep BOTH `darwin-arm64` AND `darwin-x64` HOST_TOKENS sets (flag or token-list change).
4. Updater feed (`market/apps/web/src/routes/api/desktop-updates/latest.json/+server.ts`): publish the SAME tarball under BOTH `darwin-aarch64` AND `darwin-x86_64` keys — `tauri-plugin-updater 2.11.0` derives its platform key per compiled slice and never requests `darwin-universal`.
5. Optional smoke (recommended): Rosetta on the runner + nodejs.org `darwin-x64` dist, rerun the headless sidecar smoke with `arch -x86_64 node` to exercise the x64 half (sharp native module).

## UI build hardening (prod pin + dev-fallback assert)

`ui:build` = `scripts/ui-build.mjs`, pins `NODE_ENV=production` in-process (a shell `export` prefix dies on Windows cmd.exe) so every local and Windows-CI build compiles the release arms regardless of the invoking shell. Why: SvelteKit resolves `$app/environment` at build time — a leaked `NODE_ENV=development` compiles the `localhost:7799` dev fallbacks into the shipped server bundle (incidents 2026-10-18 + 2026-10-29: gear sync hit the dev web, proof upload 502, presign 401). After build, `scripts/assert-release-build.mjs` fails (exit 1 + offender list) if `http://localhost:7799` appears anywhere in `build/**/*.{js,mjs,cjs,html,css}` or `https://kelp.market` is absent. `http://localhost:3003` is deliberately NOT forbidden — runtime `$env/dynamic` fallback in legitimate release bundles, masked by Rust-shell env injection.

## Action pin policy (node24)

Every `uses:` pin is SHA-pinned with a `# <version>` comment; all pinned actions force-run Node 24: `desktop-release.yml` → `upload-artifact` v7.0.2, `download-artifact` v8.0.2; `audit-alerts.yml` → `cache`/`cache/save` v6.1.0 (restore/save); `common-turbo-ci.yaml` → `woss/exiftool-action@main` ref (node24, exiftool 13.54 — the action has NO version input, binary baked per ref, and its `v13.59` tag still declares `runs.using: node20`, hence the intentional `main` pin). CI-vs-vendored skew (13.54 vs `EXIFTOOL_VERSION = '13.59'` in `provision.ts`) is accepted: CI smoke only runs `exiftool -ver`; production vendors 13.59 at startup. Runner requirement for the v7/v8/v6 pins: ≥ 2.327.1 (satisfied).

## Workflow YAML is JS-free — composite actions only

`run:` blocks in `.github/workflows/*.yml` never inline JavaScript: no `node -e`, `node -p`, node heredocs, or `actions/github-script` (contract grep enforced; see `docs/infra/ci-custom-actions.md`). JS lives in a composite action under `.github/actions/<name>/` (`action.yml` + `<name>.mjs`); the workflow only wires inputs/env. (The AI release-notes action shipped 2026-11-05 was retired 2026-11-06 — notes moved to CHANGELOG.md, no JS needed in the cut path.)

## Self-hosted runner: results-upload hang (runner 2.338)

`Runner.Worker` 2.338.0 hangs indefinitely uploading step/job logs to the results service (`Starting upload of step log file … ResultsLog` → `TaskCanceledException`; GitHub shows the job `in_progress` forever, **zero steps**). Shell-level egress is fine; the hang is inside 2.338's Azure-SDK upload path (upstream actions/runner#4351; 2.337.0 fine). Stuck-job signature: a live worker finished locally while GitHub still shows in_progress = results upload never landed; killing the local `Runner.Worker` process marks the job failed and frees the run. Mitigation applied on `woss-mac-arm`:

```bash
ln -sfn bin.2.337.0 bin            # runner root holds bin.<ver> dirs; bin is a symlink
chmod 555 ~/actions-runner-kelp    # freeze root against re-update: updater stages bin.<new>/.runner_migrated INTO the root; read-only root makes its exception-caught skip-update path fail; _diag/_work keep own perms
launchctl kickstart -k gui/501/actions.runner.kelp-hq-kelp-market.woss-mac-arm
gh run cancel <id>                 # if the zombie attempt still holds the run
gh run rerun <id> --failed
```

## Local verification recipe (mirrors CI proof)

```sh
tar -tzf "src-tauri/target/release/bundle/macos/Kelp Market.app.tar.gz" | grep -c 'Resources/server/node_modules/'  # hundreds
codesign --verify --deep --strict <extracted>.app   # exit 0, flags=0x2(adhoc)
```

Sidecar smoke: `node <app>/Contents/Resources/server/desktop-server.mjs <app>/Contents/Resources/server/build` with `KELP_DESKTOP=1 PORT=20117 KELP_APP_DATA=… KELP_LOG_DIR=… KELP_DESKTOP_EXIFTOOL_DIR=…` (dir containing `exiftool` + `lib` symlinks), stdin held open (e.g. `sleep 300 |`), then `curl /api/desktop/health` → `{"ok":true}`; `/` → 303 first-run redirect.

## Actionlint noise (pre-existing, accepted)

`SC2005` shellcheck style (`echo $(cmd)`) in desktop-release; unknown runner labels for custom self-hosted runners (`self-hosted-macos`, `self-hosted-windows`, `[self-hosted, kelp]`).
