import { ApprovalService, ExecutorRegistry } from '@approvals-mcp/core';
import { createPgliteStore, createPostgresStore } from '@approvals-mcp/db';

const globalForService = globalThis as unknown as {
  approvalsService?: Promise<ApprovalService>;
};

async function build(): Promise<ApprovalService> {
  const url = process.env.DATABASE_URL;
  const { store } = url
    ? await createPostgresStore(url)
    : await createPgliteStore('.pglite-reviewer');
  // The reviewer only records human decisions; it never executes. Execution is
  // the agent's job (it calls execute_if_approved over MCP after approval), so an
  // empty executor registry is correct here.
  return new ApprovalService({ store, executors: new ExecutorRegistry() });
}

/** One service per server process, reused across requests and dev HMR. */
export function getService(): Promise<ApprovalService> {
  globalForService.approvalsService ??= build();
  return globalForService.approvalsService;
}
