# Runbook

How to run, deploy, and operate approvals-mcp.

## Prerequisites

- Node 20 or newer
- pnpm 10
- A Postgres database for any multi-process deployment (the server and the reviewer must share one)

## Local development

Install and build once:

```bash
pnpm install
pnpm build
```

Run the whole loop in one command, no database and no keys:

```bash
pnpm --filter @approvals-mcp/example-agent start
```

This spawns the server over stdio, connects as an MCP client, proposes an action, approves it inline through elicitation, and executes it.

To work with the HTTP server and the reviewer:

```bash
pnpm --filter @approvals-mcp/server start      # http://localhost:8787/mcp
pnpm --filter @approvals-mcp/reviewer dev       # http://localhost:3000
```

Without `DATABASE_URL` the reviewer uses an embedded Postgres (PGlite) stored under `.pglite-reviewer`. That is per-process, so the standalone HTTP server (which defaults to an in-memory store) and the reviewer will not see each other's decisions until you point both at the same Postgres.

## Running against Postgres

Set `DATABASE_URL` for both processes so they share state:

```bash
export DATABASE_URL=postgres://user:pass@host:5432/approvals
```

The schema is created on first connection (`CREATE TABLE IF NOT EXISTS`). For a managed production database, run that once as a migration rather than relying on first-boot creation.

## Deploying the server

The server is a Node process. On Railway or Render:

- Build: `pnpm install && pnpm build`
- Start: `node packages/mcp-server/dist/index.js`
- Environment: `APPROVALS_TRANSPORT=http`, `PORT` (the platform provides it), `DATABASE_URL`, `APPROVALS_WEBHOOK_SECRET`, and `APPROVALS_WEBHOOK_URL` if you want outbound webhooks.
- Health check: `GET /healthz` returns `{"ok":true}`.

MCP clients connect to `POST /mcp`. An `initialize` request returns an `mcp-session-id` header that the client sends on subsequent requests.

## Deploying the reviewer

The reviewer is a Next.js app. On Vercel:

- Root directory: `apps/reviewer`
- Build: `next build` (the default)
- Environment: `DATABASE_URL` pointing at the same Postgres as the server.

The DB drivers load native and WASM assets through runtime paths, so they are listed in `serverExternalPackages` and must not be bundled. This is already configured in `next.config.ts`.

## Secrets

`APPROVALS_WEBHOOK_SECRET` signs outbound webhooks and verifies inbound ones. To rotate it, set the new value on the server and on every webhook receiver at the same time. There is no second-secret grace window, so rotate during a quiet period or add one before relying on rotation in production.

Never commit a real secret. `.env` is gitignored; `.env.example` lists the variables.

## Webhooks

Set `APPROVALS_WEBHOOK_URL` to receive a signed POST on every decision change. Each delivery carries an `x-approvals-signature` header (`sha256=<hmac>`) and an `idempotency-key`. Verify the signature over the raw request body and drop duplicate keys. The inbound receiver at `POST /webhooks/inbound` does exactly this and is a reference for your own receiver.

Delivery retries network errors, 5xx, 429, and 408 with bounded backoff and a per-attempt timeout. A 4xx other than 429 and 408 is treated as permanent.

## Operating

**Inspect the queue.** Read the `approvals://queue` resource over MCP, call `list_pending_approvals`, or open the reviewer. Against Postgres: `SELECT id, status, action->>'summary' FROM decisions WHERE status = 'pending' ORDER BY created_at;`

**A decision is stuck pending.** Pending decisions expire after their TTL (24 hours by default). An agent that no longer wants a proposal can call `cancel_request`.

**An execution failed.** A failed decision is terminal but recoverable. Call `service.retry(id)` (exposed in the core) to re-arm it as approved, which preserves the original audit trail, then execute it again once the downstream issue is fixed.

**An action ran twice?** It cannot. Execution is guarded by a compare-and-set claim; a second call returns `already_executed` without running anything.

## Observability

Every transition appends to the decision's audit trail, visible on the decision page in the reviewer and in the `approvals://audit/{id}` resource. The `ApprovalService` also takes an `onEvent` callback that fires once per transition; wire it to your tracing or metrics. Outbound webhooks carry the same events.

## Troubleshooting

- **Reviewer returns 500 on every page.** The DB driver is being bundled. Confirm `@electric-sql/pglite` and `postgres` are in `serverExternalPackages` in `next.config.ts`.
- **`pnpm test` fails to start.** Native build scripts may be blocked. The repo lists the ones it needs under `pnpm.onlyBuiltDependencies`; run `pnpm install` again after pulling.
- **Server returns "no valid session id".** The client sent a non-`initialize` request without an `mcp-session-id`. Initialize first, then reuse the returned session id.
