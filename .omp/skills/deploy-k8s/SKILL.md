---
name: deploy-k8s
description: >
  Production rollout runbook for the kelp-market stack on the kube-hetzner
  cluster (kubectl context `kelp`, namespace `kelp-market`). Use when the user
  says "deploy to prod", "deploy kelp market", "redeploy tag", "rollback
  deploy", "kubectl prod", "rotate secrets", "scanner shield", or references
  deploy-market.yml / ci.yml deploy jobs. Covers image tagging, kustomize
  apply, SOPS secrets, credential rotation, DNS/TLS, go-live verification, and
  rollback. Never auto-runs a manual deploy — human go required.
---

# Deploy Kelp Market to Kubernetes

Context `kelp`, namespace `kelp-market`. Local dev cluster is OrbStack
(`--context orbstack`, overlays `local`/`local-prod`). SurrealDB is NOT
deployed here — cluster runs it (`svc/surrealdb:8000`, from kelp-infra
`envs/prod/3-data`).

## Workloads

| Workload | Image | Replicas | Port |
| --- | --- | --- | --- |
| market-web | `docker.io/kelpdigital/monobackend-market:<tag>` | 2 | 7799→3000 |
| market-worker | `monobackend-market:<tag>` | 2 | — |
| market-mcp | `monobackend-market:<tag>` | 1 | 3100 |
| kelp-sso | `monobackend-market:<tag>` | 1 | 3003→3000 |
| postgres | `postgres:17` | 1 | 5432 (5Gi PVC, kelp_sso DB) |
| rampp-worker | `docker.io/kelpdigital/rampp-worker:latest` | 1 | `ai` profile only, needs weights PVC |

## Human-approval gates (NEVER auto-run)

- Manual deploys, tag redeploys, and rollbacks run ONLY on the user's explicit
  go in the current conversation. Landing to `main` also never happens without
  explicit approval.
- The ONLY automatic path: a green `main` push (after an approved land) is
  path-gated by `ci.yml`'s final `deploy` job → dispatches `deploy-market.yml`
  at that sha. Commits touching only `docs/`, `plans/`, `*.md`, `.github/`,
  `market/apps/desktop/` do NOT deploy.
- No PRs unless the user explicitly asks.

## Image tags & workflow concurrency

- Tags: `<UTC date>-<short-sha>` of the deploy commit (e.g.
  `2026.11.06-abc1234`), plus `latest`. The same string is the Datadog version
  everywhere: web RUM `version` (build arg → `__BUILD_VERSION__`) and the
  `tags.datadoghq.com/version` pod label (sed'd pre-apply → `DD_VERSION` via
  the admission controller). Dispatch with empty `tag` input = fresh build
  from `main`; non-empty = redeploy that tag (rollback path).
- `deploy-market.yml` concurrency: `cancel-in-progress: true`, group
  `deploy-market` — a newer landing kills the older run mid-build (last
  landing wins). Manual tag redeploys use group `deploy-market-manual-tag` so
  a rollback never cancels a main deploy, and vice versa.
- Every deploy records a GitHub Deployment: the job references
  `environment: production` (url `https://kelp.market`) — visible on the
  repo's Deployments page incl. tag rollbacks; statuses follow the job
  result. The env carries no protection rules (required reviewers / wait
  timers are public-repo-only on GitHub Team) — the human go stays a
  process gate, not a GitHub-enforced wall.
- Path-gated rollouts: the workflow diffs each deployment's running commit vs
  the new one and re-pins unaffected deployments to their previous image.
  web-only commits don't restart mcp/sso; desktop/, worker/, docs/plans/
  `.github`/`*.md` restart nothing. Shared sources (packages, libs, lockfile,
  k8s manifests, build context) roll everything, as do rollback dispatches and
  unknown previous commits.
- Builds pass NO `TURBO_TOKEN/TURBO_API/TURBO_TEAM` — the remote cache once
  served a stale sso build. Don't re-enable it for image builds.
- Docker Hub auth: macOS runner cannot `docker login` (keychain credsStore
  denies CI, error -25308). The workflow pre-writes a file-based `auths` entry
  into a temp `DOCKER_CONFIG`. NEVER reintroduce docker/login-action.

## Parameterized values (fill once per deploy)

1. **Secrets** — one Secret per service, two sources of truth:
   - Local: `~/.omp/secrets/kelp-market/market.env` is the single local file.
     Run `market/k8s/secrets/split-env.sh` BEFORE every
     `kustomize build`/`kubectl apply -k` — it derives per-service env files
     into `market/k8s/overlays/{local,local-prod}/secrets/` (gitignored) for
     kustomize `secretGenerator`. Hash-suffixed Secret names auto-roll the
     consuming Deployments on any credential change.
   - Prod: SOPS+age-encrypted Secret manifests in `market/k8s/secrets/prod/`
     (committed). Decrypt with
     `export SOPS_AGE_KEY_FILE=~/.config/sops/age/keys.txt` (never commit the
     key; back it up in a password manager). Do NOT list the encrypted files
     as kustomize resources — applying ciphertext poisons the Secret.
2. **Domain** — `MARKET_DOMAIN: kelp.market` in
   `market/k8s/overlays/prod/domain-patch.yaml`. Hosts: apex `kelp.market`
   (web + API — NOT `market.kelp.market`), `sso.`, `mcp.`, `upload.`.
3. **Cookie domain** — prod configmap patch must set
   `KELP_COOKIE_DOMAIN: kelp.market` so the session cookie is shared across
   apex and SSO subdomain.
4. **Image build args** — `PUBLIC_*` vars are inlined at build time; Dockerfile
   defaults are `*.localhost` dev domains:
   `--build-arg PUBLIC_KELP_SSO_URL=https://sso.kelp.market
   --build-arg PUBLIC_SSO_URL=https://sso.kelp.market
   --build-arg PUBLIC_COMPANION_URL=https://upload.kelp.market`

## Deploy (core stack)

```sh
# 0. Secrets first (idempotent re-apply on every change):
#    local:
market/k8s/secrets/split-env.sh && kubectl --context orbstack apply -k market/k8s/overlays/local
#    prod:
for f in market/k8s/secrets/prod/*-env.yaml; do \
  SOPS_AGE_KEY_FILE=~/.config/sops/age/keys.txt sops -d "$f" \
  | kubectl --context kelp -n kelp-market apply -f -; done
#    then provision scoped DB users (context + namespace as args;
#    umami is deployed + provisioned by kelp-infra envs/<env>/3.5-umami):
market/k8s/secrets/provision-pg-sso-role.sh <context> <namespace>
market/k8s/secrets/provision-surreal-user.sh <context> <k8s-ns> kelp_market market \
  "$(sed -n 's/^KELP_MARKET_DB_USERNAME=//p' ~/.omp/secrets/kelp-market/market.env)" \
  "$(sed -n 's/^KELP_MARKET_DB_PASSWORD=//p' ~/.omp/secrets/kelp-market/market.env)"
#    prod user/pass come from `sops -d market/k8s/secrets/prod/web-env.yaml`;
#    local overlays need --root-secret surreal-root-env

# 1. Manual fallback (explicit user go only) — set tag, build, apply:
perl -pi -e 's/newTag: SET_AT_DEPLOY_TIME/newTag: <tag>/' \
  market/k8s/overlays/prod/kustomization.yaml
kustomize build market/k8s/overlays/prod | kubectl --context kelp apply -f -
# Gate: kubectl --context kelp -n kelp-market get pods
#   → all pods Running/Ready (web×2, worker×2, mcp, sso, companion, postgres)
```

## Deploy (ai profile, optional)

Enables rampp-worker (RAM++ tagging):

```sh
cd market && skaffold deploy -p ai
# Copy model weights (~3GB) into the PVC via the helper pod:
kubectl --context kelp -n kelp-market cp \
  ram_plus_swin_large_14m.pth kelp-market/rampp-weights-copy:/models/ -c copy
```

Helper pod lives 2h; rampp-worker is useless until `RAMPP_WEIGHTS` exists on
the PVC.

## One-time data init

- **SurrealDB user**: provision the database-scoped `market` user (apps NEVER
  sign in as root):
  `market/k8s/secrets/provision-surreal-user.sh kelp kelp-market kelp_market market <user> <pass>`
  with values from `sops -d market/k8s/secrets/prod/web-env.yaml`.
- **SurrealDB schema**: `surreal-schema` initContainers in market-web and
  market-mcp apply it idempotently on every pod start. Concurrent appliers
  race on MVCC (`WriteConflict`, retryable); losers retry with backoff —
  `MAX_SCHEMA_ATTEMPTS = 40` in `market/packages/db-ops/scripts/apply-schema.ts`
  ≈ 16 min per window. `rollout status --timeout=3600s` in deploy-market.yml
  waits truthfully for convergence; a slow rollout is success, not a red X.
- **Postgres role**: provision non-superuser `kelp_sso_app` via
  `provision-pg-sso-role.sh kelp kelp-market` — sso-migrate initContainer runs
  drizzle migrations as that role. Superuser (`PG_USER` in `postgres-env`) is
  admin-only, never consumed by apps. Major-version bump requires PVC wipe or
  pg_upgrade.
- **Umami analytics**: the umami SERVER is owned by kelp-infra — nothing
  umami-server-side lives here. Prod: https://analytics.kelp.market (Caddy
  ingress, automatic HTTPS, Cloudflare DNS → cluster LB). Local:
  `kubectl --context orbstack -n kelp-market port-forward svc/umami 3000:3000`.
  Setup: log in `admin`/`umami`, change password, create websites
  `kelp.market` + `kelp-market-mcp`, put the UUIDs into market.env as
  `UMAMI_WEBSITE_ID` / `UMAMI_MCP_WEBSITE_ID`, re-run `split-env.sh`, re-apply
  (prod: sops-apply), then `rollout restart deploy/market-web deploy/market-mcp`.
  Until the UUIDs are set, tracking silently no-ops.

## Credential rotation

Every flow: edit ONE file → re-apply → provision → roll. Local Secrets are
hash-suffixed (consumers auto-roll); prod Secret names are fixed
(`sops -e -i` changes content only), so `rollout restart` the affected
Deployment.

| Credential | Edit | Then |
| --- | --- | --- |
| SSO Postgres `SSO_PG_PASSWORD` | `~/.omp/secrets/kelp-market/market.env` → `split-env.sh` (local) or `sops -d/-e -i prod/sso-env.yaml` | re-apply → `provision-pg-sso-role.sh <ctx> <ns>` (ALTER path) → `rollout restart deploy/kelp-sso` |
| SurrealDB `market` user `KELP_MARKET_DB_PASSWORD` | market.env → split (local) or sops prod web/worker/mcp/rampp-env | re-apply → `provision-surreal-user.sh` → restart web/worker/mcp |
| SurrealDB ROOT (`surrealdb-auth`) | kelp-infra terragrunt var (`infra/modules/kv-stack/main.tf`) | module apply → update consumer scripts if Secret keys change |
| Local SurrealDB root `SURREALDB_ROOT_PASS` | market.env → `split-env.sh` | re-apply local overlay (`surreal-root-env` Secret only) |
| Stripe `STRIPE_SECRET_KEY`/`STRIPE_WEBHOOK_SECRET` | market.env → split, or sops prod web/worker/mcp-env | re-apply → auto-roll (local) or `rollout restart` (prod) |
| S3 `S3_ACCESS_KEY`/`S3_SECRET_KEY` | market.env → split, or sops prod web/worker/mcp/companion/rampp-env | re-apply → all consumers roll |
| BETTER_AUTH_SECRET / MCL_* / COMPANION_SECRET | market.env → split, or sops prod sso/companion-env | re-apply → sso/companion roll |

Blast-radius drill: change `STRIPE_SECRET_KEY` in market.env → `split-env.sh`
→ `kubectl --context orbstack -n kelp-dev apply -k market/k8s/overlays/local`
→ web/worker/mcp roll via new hash-suffixed Secrets; kelp-sso pod age stays
untouched.

## DNS + go-live

- DNS for `kelp.market` + `sso.` / `mcp.` / `upload.` subdomains → prod
  ingress LB. Ingress file: `market/k8s/components/ingress/ingress.yaml`
  (included by overlays running apps in-cluster). Prod web host is the apex.
- Stripe webhook endpoint: `https://kelp.market/api/webhooks/stripe` (live
  secret must match `STRIPE_WEBHOOK_SECRET`).
- TLS: cert-manager ingress annotation `cluster-issuer: letsencrypt` — adjust
  issuer name if the cluster differs.
- **Caddy XFF edge (ops, no repo change)**: better-auth's rate limiter keys on
  the first `X-Forwarded-For` entry. Caddy must sanitize/spoof-reject XFF
  (`trusted_proxies` + `client_ip_headers`) before the ingress, or clients can
  rotate spoofed XFF to bypass `/api/auth/*` rate limiting. Re-verify after
  any Caddy upgrade.

## Scanner shield (apex host)

`market/k8s/overlays/prod/scanner-shield.yaml` (+ `-ingress-patch.yaml`):
2-replica Caddy between caddy-ingress and market-web, apex host only — 403s
path-scanner probes (`/wp-admin*`, `/.env*`, `/.git*`, `/phpmyadmin*`, …),
proxies everything else to `market-web:7799`. Prod ingress `rules[0]` points
`kelp.market` → `market-scanner-shield:8080`; sso/mcp hosts bypass it.
Invariants:
- The ingress patch is strategic-merge and must carry **all** rules (lists
  have no merge key) — update it together with `domain-patch.yaml` when hosts
  change. JSON6902 cannot substitute: kustomize v5 applies it before
  path-form patches, hitting the base placeholder rule.
- `header_up X-Forwarded-Proto https` is mandatory (operator→shield is plain
  HTTP; better-auth must see https); XFF passes through verbatim.
- securityContext keeps `NET_BIND_SERVICE` in the bounding set and
  `no_new_privs` off — dropping ALL caps makes exec of caddy's filecap'd
  binary fail EPERM → CrashLoopBackOff → apex 502.
- Verify: `curl -sI https://kelp.market/wp-admin/setup-config.php | head -1`
  → 403; `curl -sI https://kelp.market/` → 200.

## Go-live verification gate

- `curl -I https://kelp.market/datasets` → 200
- MCP initialize handshake at `https://mcp.kelp.market/mcp` → JSON-RPC response
- SSO sign-in → dashboard loads, session cookie set
- Upload one asset → `pipeline_presets=done` + thumbnail renders
- Test Stripe purchase → `checkout.session.completed` webhook received

## Rollback

Redeploy the previous `<date>-<shortsha>` tag via `deploy-market.yml`
`workflow_dispatch` with the non-empty tag input — only on the user's explicit
go. Data volumes (postgres PVC, object storage) persist.
