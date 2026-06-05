import { createRequire } from 'node:module';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ElicitRequestSchema } from '@modelcontextprotocol/sdk/types.js';

// Resolve the built approvals-mcp server binary from the workspace.
const serverEntry = createRequire(import.meta.url).resolve('@approvals-mcp/server');

function childEnv(): Record<string, string> {
  const env: Record<string, string> = { APPROVALS_TRANSPORT: 'stdio' };
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  env.APPROVALS_TRANSPORT = 'stdio';
  return env;
}

function structured(result: unknown): unknown {
  return (result as { structuredContent?: unknown }).structuredContent;
}

async function main(): Promise<void> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverEntry],
    env: childEnv(),
  });

  const client = new Client(
    { name: 'example-agent', version: '0.1.0' },
    { capabilities: { elicitation: {} } },
  );

  // Stand in for a human reviewer. A real deployment surfaces this in the
  // reviewer web app; here we answer inline so the demo needs no second actor.
  client.setRequestHandler(ElicitRequestSchema, async (request) => {
    console.log(`\n  [reviewer] ${request.params.message}`);
    console.log('  [reviewer] -> approve (a human would decide this)\n');
    return { action: 'accept', content: { decision: 'approve', reason: 'looks good' } };
  });

  await client.connect(transport);
  console.log('connected to approvals-mcp over stdio');

  const { tools } = await client.listTools();
  console.log(`tools: ${tools.map((t) => t.name).join(', ')}`);

  console.log('\nagent: proposing a send_message action for approval...');
  const result = await client.callTool({
    name: 'request_approval',
    arguments: {
      kind: 'send_message',
      summary: 'Reply to a new member in #general',
      payload: { channel: '#general', text: 'Welcome aboard! Glad to have you.' },
    },
  });

  console.log(`\noutcome: ${JSON.stringify(structured(result))}`);
  console.log('\nThe action only ran because the reviewer approved it. Without elicitation,');
  console.log('it would stay pending until a human approved it in the reviewer app.');

  await client.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
