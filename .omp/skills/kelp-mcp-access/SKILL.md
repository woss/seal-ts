---
name: kelp-mcp-access
description: >
  Diagnose and fix 401s on the kelp-market/kelp-admin MCPs (dev + prod entries): bring up
  port-forwards via .devops/tools/dev-mcp.sh, verify key against kelp-sso,
  check/unbrick the bricked apikey row, mint fresh admin key. Use on any
  MCP "Invalid or revoked API key" or connection failure.
---

# Kelp MCP access: connection, 401 diagnosis, key lifecycle

Four MCP entries in `.omp/mcp.json` (`kelp-market-{dev,prod}`, `kelp-admin-{dev,prod}`), all auth via `x-api-key` read from `~/.omp/secrets/` files, all verify keys **live** against kelp-sso (the `-dev` servers run locally with `SSO_URL` pointed at prod SSO):

| MCP | URL | Key file | Tools |
|---|---|---|---|
| `kelp-market-prod` | `http://10.43.74.179:3100/mcp` | `kelp-mcp-api-key` | datasets, licensing purchase (buyer/public only — no admin surface) |
| `kelp-market-dev` | `http://127.0.0.1:3100/mcp` | `kelp-market-dev-api-key` | same tool surface; local `pnpm dev` server verifying against **local** SSO (`market/apps/mcp/.env` → local kelp-sso on :3003) |
| `kelp-admin-prod` | `http://10.43.121.55:3101/mcp` | `kelp-mcp-api-key` | `analytics_query`, `llm_cost_report`, `bug_report_list/fetch/status`, dataset admin (`dataset_publish/unpublish/retire`, `dataset_list_admin`) |
| `kelp-admin-dev` | `http://127.0.0.1:3101/mcp` | `kelp-admin-dev-api-key` | same tool surface; local `pnpm dev` server verifying against **local** SSO |

**Dev keys ≠ prod keys** (2026-11-12): dev servers verify against the local kelp-sso DB, so prod keys 401 on `-dev` and dev keys 401 on `-prod`. Dev admin keys are minted in the local `kelp_sso` Postgres via the better-auth apiKey plugin (name `laptop-dev-mcp`, prefix `kelp_adm_`, user `daniel@woss.io` whose local role is `admin` — the admin gate reads the user role, not key permissions).

Both prod MCPs are ClusterIP-only (no Ingress). Locally, reach them directly via Tailscale (subnet router `kelp-tailscale` routes the service CIDR) — the ClusterIPs are **pinned** in the Service manifests (`market/k8s/components/apps/mcp*.yaml`), so delete/recreate keeps them. Off-cluster DNS to `10.43.0.10` is hijacked by a public forwarder on the subnet-router path — do NOT rely on `*.svc.cluster.local` names from the Mac. Port-forward fallback (only if Tailscale is down — kubectl also rides Tailscale, so usually equally dead):

```sh
.devops/tools/dev-mcp.sh   # market-mcp → 3100, market-mcp-admin → 3101, idempotent, daemonized
```

(The kelp-market MCP can also run as a dev server: `pnpm dev` in `market/apps/mcp`, or the `dev-local.sh` stack — port 3100. Use the forward unless developing the MCP itself.)

## 401 "Invalid or revoked API key"

1. **Confirm server is up**: `curl -s -o /dev/null -w '%{http_code}' http://localhost:3100/mcp` — 406 on bare GET = listening.
2. **Test the key directly** (bypasses MCP):
   `curl -s https://sso.kelp.market/api/verify-api-key -H 'content-type: application/json' -d "{\"key\":\"$(cat ~/.omp/secrets/kelp-mcp-api-key)\"}"`
   - `{"valid":true,...}` → key fine; problem is server-side (wrong env, restart dev server).
   - `{"valid":false,"error":"Invalid API key"}` → continue.
3. **Check the key row** (prod kelp_sso, read-only):
   ```sh
   kubectl --context kelp -n kelp-market exec postgres-0 -- psql -U postgres -d kelp_sso \
     -c "SELECT name, request_count, rate_limit_enabled, enabled, revoked_at FROM apikey ORDER BY created_at DESC LIMIT 10;"
   ```
4. **Bricked** (`request_count >= 10` + `rate_limit_enabled = true`, `revoked_at` null): legacy better-auth rate-limit rows brick mid-session even though the plugin option was disabled 2026-10-19 — old rows keep `rate_limit_enabled = true`. Unbrick (documented remedy, one row):
   ```sh
   kubectl --context kelp -n kelp-market exec postgres-0 -- psql -U postgres -d kelp_sso \
     -c "UPDATE apikey SET request_count = 0, rate_limit_enabled = false WHERE name = '<key name>';"
   ```
5. **Revoked / rotated** (`revoked_at` set): mint fresh — sign in at `sso.kelp.market` as admin (`daniel@woss.io` = `admin`), then:
   ```sh
   curl -s https://sso.kelp.market/api/api-keys -H 'content-type: application/json' \
     --cookie <session cookie> \
     -d '{"name":"<name>","permissions":{...}}'
   ```
   Use kelp-sso's `/api/api-keys` (**not** better-auth's `/api/auth/api-key/create` — rejects `permissions`). Key shown once → store in 1Password `kelp-pvt` + `~/.omp/secrets/<file>` (mode 600, never commit).
6. MCP headers re-read via `!cat` at session load — new/minted keys register **next omp session**.

## Gotchas

- "Invalid or revoked API key" (HTTP 401 from MCP) vs "Invalid API key" (from sso verify) — same root, MCP wraps it.
- Verification is live per request; a locally cached key file that still exists proves nothing.
- Full auth model + minting details: `docs/analytics/mcp-access.md`.
