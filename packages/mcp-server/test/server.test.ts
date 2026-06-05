import { type ApprovalService, InMemoryDecisionStore } from '@approvals-mcp/core';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import {
  type ClientCapabilities,
  type ElicitRequest,
  ElicitRequestSchema,
  type ElicitResult,
} from '@modelcontextprotocol/sdk/types.js';
import { describe, expect, it } from 'vitest';
import type { ServerConfig } from '../src/config';
import { createApp } from '../src/factory';
import { buildServer } from '../src/server';

function testConfig(): ServerConfig {
  return { transport: 'http', port: 0, webhookSecret: 'test-secret' };
}

type ElicitHandler = (req: ElicitRequest) => Promise<ElicitResult>;

async function connect(
  opts: { capabilities?: ClientCapabilities; elicit?: ElicitHandler } = {},
): Promise<{ client: Client; service: ApprovalService }> {
  const deps = createApp({ config: testConfig(), store: new InMemoryDecisionStore() });
  const server = buildServer({ service: deps.service, specs: deps.specs });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);

  const client = new Client(
    { name: 'test-client', version: '1.0.0' },
    { capabilities: opts.capabilities ?? {} },
  );
  if (opts.elicit) client.setRequestHandler(ElicitRequestSchema, opts.elicit);
  await client.connect(clientTransport);
  return { client, service: deps.service };
}

function sc(result: unknown): Record<string, unknown> {
  return ((result as { structuredContent?: unknown }).structuredContent ?? {}) as Record<
    string,
    unknown
  >;
}

function isError(result: unknown): boolean {
  return (result as { isError?: boolean }).isError === true;
}

const message = {
  kind: 'send_message',
  summary: 'Welcome a new member',
  payload: { channel: '#general', text: 'Hi!' },
};

describe('tool surface', () => {
  it('exposes the agent-facing tools', async () => {
    const { client } = await connect();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(
      expect.arrayContaining([
        'submit_for_approval',
        'request_approval',
        'check_decision',
        'execute_if_approved',
        'cancel_request',
        'list_pending_approvals',
      ]),
    );
  });

  it('does not expose approve/reject as agent tools', async () => {
    const { client } = await connect();
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    expect(names).not.toContain('approve_decision');
    expect(names).not.toContain('reject_decision');
  });
});

describe('submit_for_approval', () => {
  it('queues a pending decision', async () => {
    const { client } = await connect();
    const res = await client.callTool({ name: 'submit_for_approval', arguments: message });
    expect(sc(res).status).toBe('pending');
    expect(sc(res).decision_id).toMatch(/^dec_/);
  });

  it('rejects an invalid payload', async () => {
    const { client } = await connect();
    const res = await client.callTool({
      name: 'submit_for_approval',
      arguments: { kind: 'send_message', summary: 'x', payload: { text: 'no channel' } },
    });
    expect(isError(res)).toBe(true);
  });
});

describe('the human gate', () => {
  it('refuses to execute until a human approves', async () => {
    const { client, service } = await connect();
    const submitted = await client.callTool({ name: 'submit_for_approval', arguments: message });
    const id = sc(submitted).decision_id as string;

    const early = await client.callTool({
      name: 'execute_if_approved',
      arguments: { decision_id: id },
    });
    expect(sc(early).reason).toBe('not_approved');

    await service.approve(id, { reviewer: 'human' });
    const done = await client.callTool({
      name: 'execute_if_approved',
      arguments: { decision_id: id },
    });
    expect(sc(done).executed).toBe(true);
    expect(sc(done).status).toBe('executed');
  });

  it('cancels a pending request', async () => {
    const { client } = await connect();
    const submitted = await client.callTool({ name: 'submit_for_approval', arguments: message });
    const id = sc(submitted).decision_id as string;
    const cancelled = await client.callTool({
      name: 'cancel_request',
      arguments: { decision_id: id },
    });
    expect(sc(cancelled).status).toBe('cancelled');
  });
});

describe('resources', () => {
  it('lists and reads the pending queue and a decision', async () => {
    const { client } = await connect();
    const submitted = await client.callTool({ name: 'submit_for_approval', arguments: message });
    const id = sc(submitted).decision_id as string;

    const { resources } = await client.listResources();
    expect(resources.map((r) => r.uri)).toContain('approvals://queue');

    const queue = await client.readResource({ uri: 'approvals://queue' });
    expect(JSON.stringify(queue.contents)).toContain(id);

    const decision = await client.readResource({ uri: `approvals://decision/${id}` });
    expect(JSON.stringify(decision.contents)).toContain(id);

    const audit = await client.readResource({ uri: `approvals://audit/${id}` });
    expect(JSON.stringify(audit.contents)).toContain('submitted');
  });
});

describe('prompts', () => {
  it('renders the review-card prompt', async () => {
    const { client } = await connect();
    const { prompts } = await client.listPrompts();
    expect(prompts.map((p) => p.name)).toContain('summarize_for_review');

    const prompt = await client.getPrompt({
      name: 'summarize_for_review',
      arguments: { kind: 'send_message', summary: 'hi', payload_json: '{}' },
    });
    const first = prompt.messages[0]?.content;
    expect(first?.type).toBe('text');
    if (first?.type === 'text') expect(first.text).toContain('approval card');
  });
});

describe('request_approval with elicitation', () => {
  it('approves and executes when the human accepts inline', async () => {
    const { client } = await connect({
      capabilities: { elicitation: {} },
      elicit: async () => ({ action: 'accept', content: { decision: 'approve' } }),
    });
    const res = await client.callTool({ name: 'request_approval', arguments: message });
    expect(sc(res).executed).toBe(true);
    expect(sc(res).status).toBe('executed');
  });

  it('rejects when the human declines inline', async () => {
    const { client } = await connect({
      capabilities: { elicitation: {} },
      elicit: async () => ({
        action: 'accept',
        content: { decision: 'reject', reason: 'off-policy' },
      }),
    });
    const res = await client.callTool({ name: 'request_approval', arguments: message });
    expect(sc(res).status).toBe('rejected');
    expect(sc(res).executed).toBe(false);
  });

  it('leaves the decision pending when the client cannot elicit', async () => {
    const { client } = await connect();
    const res = await client.callTool({ name: 'request_approval', arguments: message });
    expect(sc(res).status).toBe('pending');
    expect(sc(res).executed).toBe(false);
  });
});
