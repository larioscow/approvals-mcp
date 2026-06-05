import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { AppDeps } from './factory';
import { buildServer } from './server';

export async function startStdio(deps: AppDeps): Promise<void> {
  const server = buildServer({ service: deps.service, specs: deps.specs });
  await server.connect(new StdioServerTransport());
  console.error('approvals-mcp ready on stdio');
}
