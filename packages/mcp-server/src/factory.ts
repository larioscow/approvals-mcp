import {
  type ApprovalEvent,
  ApprovalService,
  type DecisionStore,
  deliverWebhook,
  InMemoryDecisionStore,
  type JsonValue,
  type WebhookEvent,
} from '@approvals-mcp/core';
import { type ActionSpec, buildRegistry, defaultActions } from './actions';
import { loadConfig, type ServerConfig } from './config';

export interface AppDeps {
  service: ApprovalService;
  specs: ActionSpec[];
  config: ServerConfig;
}

/** Wires config → executors → service. One service (state) backs many sessions. */
export async function createApp(
  opts: { config?: ServerConfig; store?: DecisionStore } = {},
): Promise<AppDeps> {
  const config = opts.config ?? loadConfig();
  const specs = defaultActions(
    config.slackWebhookUrl ? { slackWebhookUrl: config.slackWebhookUrl } : {},
  );
  const executors = buildRegistry(specs);
  const store = opts.store ?? (await resolveStore(config));
  const service = new ApprovalService({
    store,
    executors,
    ...(config.webhookUrl
      ? { onEvent: webhookEmitter(config.webhookUrl, config.webhookSecret) }
      : {}),
  });
  return { service, specs, config };
}

/** Postgres when DATABASE_URL is set (shared with the reviewer), else in-memory. */
async function resolveStore(config: ServerConfig): Promise<DecisionStore> {
  if (config.databaseUrl) {
    const { createPostgresStore } = await import('@approvals-mcp/db/postgres');
    const { store } = await createPostgresStore(config.databaseUrl);
    return store;
  }
  return new InMemoryDecisionStore();
}

function webhookEmitter(url: string, secret: string): (event: ApprovalEvent) => void {
  return (event) => {
    const wire: WebhookEvent = {
      type: `decision.${event.type}`,
      decisionId: event.decision.id,
      data: event.decision as unknown as JsonValue,
    };
    void deliverWebhook({
      url,
      secret,
      event: wire,
      // Stable per transition, so a redelivery is deduped by the receiver.
      idempotencyKey: `${event.decision.id}:${event.type}:${event.decision.audit.length}`,
    });
  };
}
