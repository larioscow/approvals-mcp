# Architecture

approvals-mcp is a monorepo with one rule running through it: a proposed action is held until a human decides, and then it runs at most once. Everything else is in service of making that guarantee correct, observable, and reusable.

## Layers

```
@approvals-mcp/core      pure state machine, no I/O, no dependencies
        │
        ├── @approvals-mcp/db        DecisionStore over Postgres (Drizzle)
        │
        └── @approvals-mcp/server    MCP tools/resources/prompts + transports
                    │
   @approvals-mcp/reviewer            human surface (Next.js), shares the store
   apps/example-agent                 an MCP client that drives the loop
```

The core owns the logic and knows nothing about MCP, HTTP, or a database. The server and the reviewer are two front ends onto the same `ApprovalService`. In a deployment they point at the same Postgres, so an action an agent submits over MCP shows up in the reviewer, and an approval in the reviewer unblocks the agent.

## The decision lifecycle

```
pending ─approve─▶ approved ─claim─▶ executing ─▶ executed
   │                  │                             │
   ├─reject─▶ rejected│                             └─(fail)─▶ failed ─retry─▶ approved
   ├─cancel─▶ cancelled
   └─(ttl)──▶ expired
```

A `Decision` carries the proposed `Action`, its status, who decided it and why, an optional execution result, and an append-only audit trail. Actions are JSON; the store deep-copies them and they can be sent over a webhook, so payloads are typed as `JsonValue`.

## Exactly-once, and why it needs a compare-and-set

The dangerous moments are the transitions out of `pending` and the move from `approved` into execution. Two reviewers might approve at once; an agent might call `execute_if_approved` twice; an approval might race a TTL expiry. A plain read-modify-write loses one of the writes and can fire an event twice.

Every guarded transition goes through a single store primitive:

```ts
transition(id, expectedStatus, next): Promise<Decision | undefined>
```

It replaces the stored decision with `next` only if the current status still equals `expectedStatus`, and returns the saved decision on a win or `undefined` if it lost. `approve`, `reject`, `cancel`, expiry, and the approved-to-executing claim are all built on it, and an event is emitted only after a win. So concurrent callers resolve to one winner and one event.

Both stores implement the same contract. The in-memory store relies on single-threaded Map operations being atomic between the status check and the write. The Postgres store implements it as one conditional statement:

```sql
UPDATE decisions SET ... WHERE id = $1 AND status = $expected RETURNING *
```

The same exactly-once property is tested at both layers, including a concurrent-execute race that asserts the executor runs once.

## The human gate

The agent-facing MCP tools are `submit_for_approval`, `request_approval`, `check_decision`, `execute_if_approved`, `cancel_request`, and `list_pending_approvals`. None of them approve or reject. A decision is granted in one of two places: the reviewer app, or an MCP elicitation prompt that the connecting client answers. `request_approval` uses elicitation when the client supports it and otherwise leaves the decision pending for review.

These two paths have different trust properties. The reviewer app is a separate surface with no agent access, so it is a human gate no matter what client the agent connects with. Elicitation is answered by whatever client is connected, so it is a human gate only when that client puts the prompt in front of a person. An autonomous single-actor client could answer its own elicitation, and the example agent does exactly that for a self-contained demo. Rely on the reviewer app as the gate; treat elicitation as human only when the client is.

Execution is also kept on the agent side. The reviewer records the human decision and nothing else; it is constructed with an empty executor registry. The agent calls `execute_if_approved` once the decision is approved. Splitting the decision from the side effect keeps the reviewer free of credentials and side effects.

## Transports and sessions

The server speaks Streamable HTTP for remote use and stdio for local use. The HTTP layer is stateful: each session gets its own `mcp-session-id` and its own short-lived `McpServer`, while all sessions share one `ApprovalService` and therefore one store. The same Express app exposes a health check and a webhook receiver.

## Webhooks

Each state change can be delivered to `APPROVALS_WEBHOOK_URL` as a signed event. Delivery uses an HMAC signature, a per-attempt timeout, bounded exponential backoff, and an idempotency key derived from the decision and transition. Retries cover network errors, 5xx, 429, and 408; other 4xx responses are treated as permanent. The inbound receiver verifies the signature in constant time and dedupes by idempotency key.

## Risk tiers and policy

Each action has a risk tier (`low`, `medium`, `high`). A policy can auto-approve at or below a tier and sets the pending TTL, per action kind or as a default. High-risk actions are never auto-approved. The default policy requires a human for everything.

## Testing

The core runs with no network, no database, and no keys: all I/O is injected (store, clock, executors, sleep), and time is a fake clock. The MCP layer is tested by connecting a real client to the server over an in-memory transport and exercising tools, resources, prompts, and all three elicitation paths. The Postgres store is tested against PGlite, an in-process Postgres, by running the real `ApprovalService` over it, so the SQL compare-and-set and pagination are covered against real SQL rather than a mock.

`exactOptionalPropertyTypes` is on for the libraries (`core`, `db`). It is off for the application packages (`server`, `reviewer`, `example-agent`), where it only adds noise at the boundary with third-party SDKs that predate the flag.

## Deliberate non-goals

These were considered and left out of the first version on purpose, not by omission:

- A pluggable auto-approval predicate (auto-approve based on payload contents, not just risk tier).
- An approval-validity window so an approval goes stale if it is not executed in time.
- Jitter on retry backoff for high-fan-out callers.
- Per-attempt execution progress events for long-running executors.

Each is additive and would not change the existing contract.
