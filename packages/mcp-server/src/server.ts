import type { ApprovalService, JsonValue, RiskTier } from '@approvals-mcp/core';
import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { ActionSpec } from './actions';

const RISK_TIERS = ['low', 'medium', 'high'] as const;

export interface BuildServerOptions {
  service: ApprovalService;
  specs: ActionSpec[];
  name?: string;
  version?: string;
}

function ok(structured: Record<string, JsonValue>, text: string): CallToolResult {
  return { content: [{ type: 'text', text }], structuredContent: structured };
}

function one(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return value[0] ?? '';
  return value ?? '';
}

/**
 * Builds a fresh MCP server bound to a shared ApprovalService. The agent-facing
 * tools expose no approve or reject verb. A decision is granted in the reviewer
 * app or by whoever answers an elicitation prompt, never by these tools.
 */
export function buildServer(opts: BuildServerOptions): McpServer {
  const { service } = opts;
  const byKind = new Map(opts.specs.map((s) => [s.kind, s] as const));
  const kinds = opts.specs.map((s) => s.kind);
  const kindSchema = kinds.length > 0 ? z.enum(kinds as [string, ...string[]]) : z.string();

  const server = new McpServer({
    name: opts.name ?? 'approvals-mcp',
    version: opts.version ?? '0.1.0',
  });

  function resolvePayload(kind: string, payload: Record<string, unknown>): JsonValue {
    const spec = byKind.get(kind);
    if (!spec) throw new Error(`Unknown action kind: ${kind}`);
    const parsed = spec.schema.safeParse(payload);
    if (!parsed.success) throw new Error(`Invalid payload for ${kind}: ${parsed.error.message}`);
    return parsed.data as JsonValue;
  }

  function riskFor(kind: string, override: RiskTier | undefined): RiskTier {
    return override ?? byKind.get(kind)?.defaultRiskTier ?? 'medium';
  }

  // ---- Tools (agent-facing) ----

  server.registerTool(
    'submit_for_approval',
    {
      title: 'Submit an action for approval',
      description:
        'Queue a proposed side effect for human approval. Returns a decision_id. Policy may auto-approve low-risk kinds.',
      inputSchema: {
        kind: kindSchema.describe('The action kind, e.g. send_message'),
        summary: z.string().min(1).describe('One-line summary shown to the reviewer'),
        payload: z.record(z.unknown()).describe('Action data, validated against the kind'),
        risk_tier: z.enum(RISK_TIERS).optional().describe('Override the default risk tier'),
        idempotency_key: z
          .string()
          .optional()
          .describe('Repeat submits with this key return the same decision'),
      },
      outputSchema: { decision_id: z.string(), status: z.string() },
    },
    async (args) => {
      const decision = await service.submit({
        action: {
          kind: args.kind,
          summary: args.summary,
          payload: resolvePayload(args.kind, args.payload),
          riskTier: riskFor(args.kind, args.risk_tier),
        },
        ...(args.idempotency_key ? { idempotencyKey: args.idempotency_key } : {}),
      });
      return ok(
        { decision_id: decision.id, status: decision.status },
        `Queued ${decision.id}: ${decision.status}.`,
      );
    },
  );

  server.registerTool(
    'request_approval',
    {
      title: 'Request approval, asking the human inline when possible',
      description:
        'Submit an action and, if the client supports elicitation, ask the reviewer to approve or reject right now (and execute on approval). Otherwise leave it pending for the reviewer app.',
      inputSchema: {
        kind: kindSchema,
        summary: z.string().min(1),
        payload: z.record(z.unknown()),
        risk_tier: z.enum(RISK_TIERS).optional(),
      },
      outputSchema: { decision_id: z.string(), status: z.string(), executed: z.boolean() },
    },
    async (args) => {
      const decision = await service.submit({
        action: {
          kind: args.kind,
          summary: args.summary,
          payload: resolvePayload(args.kind, args.payload),
          riskTier: riskFor(args.kind, args.risk_tier),
        },
      });

      if (decision.status === 'approved') {
        const outcome = await service.execute(decision.id);
        return ok(
          { decision_id: decision.id, status: outcome.decision.status, executed: outcome.executed },
          `Auto-approved by policy and ${outcome.executed ? 'executed' : 'not executed'}.`,
        );
      }

      try {
        const result = await server.server.elicitInput({
          message: `Approve this ${args.kind}? ${args.summary}`,
          requestedSchema: {
            type: 'object',
            properties: {
              decision: {
                type: 'string',
                enum: ['approve', 'reject'],
                title: 'Decision',
                description: 'Approve or reject the action',
              },
              reason: { type: 'string', title: 'Reason' },
            },
            required: ['decision'],
          },
        });

        if (result.action !== 'accept' || !result.content) {
          return ok(
            { decision_id: decision.id, status: decision.status, executed: false },
            'No inline decision; left pending for the reviewer app.',
          );
        }

        const choice = result.content as { decision?: string; reason?: string };
        const reason = typeof choice.reason === 'string' ? choice.reason : undefined;
        if (choice.decision === 'approve') {
          await service.approve(decision.id, {
            reviewer: 'human-via-elicitation',
            ...(reason ? { reason } : {}),
          });
          const outcome = await service.execute(decision.id);
          return ok(
            {
              decision_id: decision.id,
              status: outcome.decision.status,
              executed: outcome.executed,
            },
            `Approved and ${outcome.executed ? 'executed' : 'not executed'}.`,
          );
        }

        const rejected = await service.reject(decision.id, {
          reviewer: 'human-via-elicitation',
          ...(reason ? { reason } : {}),
        });
        return ok(
          { decision_id: decision.id, status: rejected.status, executed: false },
          'Rejected by reviewer.',
        );
      } catch {
        // Client does not support elicitation; fall back to out-of-band review.
        return ok(
          { decision_id: decision.id, status: decision.status, executed: false },
          `Pending ${decision.id}; approve in the reviewer app.`,
        );
      }
    },
  );

  server.registerTool(
    'check_decision',
    {
      title: 'Check a decision',
      description: 'Look up the current status of a decision by id.',
      inputSchema: { decision_id: z.string() },
      outputSchema: {
        status: z.string(),
        decided_by: z.string().optional(),
        reason: z.string().optional(),
      },
    },
    async ({ decision_id }) => {
      const d = await service.get(decision_id);
      return ok(
        {
          status: d.status,
          ...(d.decidedBy ? { decided_by: d.decidedBy } : {}),
          ...(d.reason ? { reason: d.reason } : {}),
        },
        `Decision ${d.id} is ${d.status}.`,
      );
    },
  );

  server.registerTool(
    'execute_if_approved',
    {
      title: 'Execute an approved decision',
      description:
        'Run the side effect if (and only if) the decision is approved. Idempotent. Never runs twice.',
      inputSchema: { decision_id: z.string() },
      outputSchema: { executed: z.boolean(), reason: z.string(), status: z.string() },
    },
    async ({ decision_id }) => {
      const outcome = await service.execute(decision_id);
      return ok(
        { executed: outcome.executed, reason: outcome.reason, status: outcome.decision.status },
        `Execute ${decision_id}: ${outcome.reason}.`,
      );
    },
  );

  server.registerTool(
    'cancel_request',
    {
      title: 'Cancel a pending request',
      description: 'Withdraw a still-pending proposal the agent no longer wants reviewed.',
      inputSchema: { decision_id: z.string(), reason: z.string().optional() },
      outputSchema: { status: z.string() },
    },
    async ({ decision_id, reason }) => {
      const d = await service.cancel(decision_id, {
        actor: 'agent',
        ...(reason ? { reason } : {}),
      });
      return ok({ status: d.status }, `Cancelled ${decision_id}.`);
    },
  );

  server.registerTool(
    'list_pending_approvals',
    {
      title: 'List pending approvals',
      description: 'Page through the decisions currently awaiting a human.',
      inputSchema: {
        limit: z.number().int().min(1).max(100).optional(),
        cursor: z.string().optional(),
      },
    },
    async ({ limit, cursor }) => {
      const page = await service.listPending({
        ...(limit ? { limit } : {}),
        ...(cursor ? { cursor } : {}),
      });
      const rows = page.items.map((d) => ({
        decision_id: d.id,
        kind: d.action.kind,
        summary: d.action.summary,
        risk_tier: d.action.riskTier,
        created_at: d.createdAt,
      }));
      return {
        content: [
          { type: 'text', text: JSON.stringify({ total: page.total, items: rows }, null, 2) },
        ],
        structuredContent: {
          total: page.total,
          items: rows,
          ...(page.nextCursor ? { next_cursor: page.nextCursor } : {}),
        },
      };
    },
  );

  // ---- Resources (browsable state) ----

  server.registerResource(
    'pending-queue',
    'approvals://queue',
    {
      title: 'Pending approvals',
      description: 'Decisions currently awaiting a human decision',
      mimeType: 'application/json',
    },
    async (uri) => {
      const page = await service.listPending({ limit: 100 });
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: 'application/json',
            text: JSON.stringify(page.items, null, 2),
          },
        ],
      };
    },
  );

  server.registerResource(
    'decision',
    new ResourceTemplate('approvals://decision/{id}', { list: undefined }),
    {
      title: 'Decision',
      description: 'A single decision, addressable by id',
      mimeType: 'application/json',
    },
    async (uri, variables) => {
      const decision = await service.get(one(variables.id));
      return {
        contents: [
          { uri: uri.href, mimeType: 'application/json', text: JSON.stringify(decision, null, 2) },
        ],
      };
    },
  );

  server.registerResource(
    'audit',
    new ResourceTemplate('approvals://audit/{id}', { list: undefined }),
    {
      title: 'Decision audit trail',
      description: 'The append-only audit log for a decision',
      mimeType: 'application/json',
    },
    async (uri, variables) => {
      const decision = await service.get(one(variables.id));
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: 'application/json',
            text: JSON.stringify(decision.audit, null, 2),
          },
        ],
      };
    },
  );

  // ---- Prompts (reusable templates) ----

  server.registerPrompt(
    'summarize_for_review',
    {
      title: 'Summarize an action for a human reviewer',
      description: 'Render a proposed action into a concise approval card.',
      argsSchema: {
        kind: z.string(),
        summary: z.string(),
        payload_json: z.string(),
      },
    },
    ({ kind, summary, payload_json }) => ({
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text: [
              `Prepare an approval card for a human reviewer of this ${kind} action.`,
              'In 2-3 lines: restate what it does, flag anything risky, and end with a clear recommendation.',
              '',
              `Summary: ${summary}`,
              `Payload: ${payload_json}`,
            ].join('\n'),
          },
        },
      ],
    }),
  );

  server.registerPrompt(
    'triage_risk',
    {
      title: 'Assess the risk tier of an action',
      description: 'Classify a proposed action as low, medium, or high risk.',
      argsSchema: { kind: z.string(), payload_json: z.string() },
    },
    ({ kind, payload_json }) => ({
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text: `Classify the risk of this ${kind} action as low, medium, or high, and justify in one sentence.\nPayload: ${payload_json}`,
          },
        },
      ],
    }),
  );

  return server;
}
