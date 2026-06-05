import {
  type Executor,
  ExecutorRegistry,
  type JsonValue,
  type RiskTier,
} from '@approvals-mcp/core';
import { z } from 'zod';

/** Payload schema for the bundled example action. */
export const messageSchema = z.object({
  channel: z.string().min(1).describe('Channel or member handle, e.g. #general'),
  text: z.string().min(1).describe('Message body'),
});

/** Binds an action kind to its payload schema, default risk, and executor. */
export interface ActionSpec {
  kind: string;
  description: string;
  schema: z.ZodTypeAny;
  defaultRiskTier: RiskTier;
  executor: Executor;
}

export interface MessageExecutorOptions {
  /** When set, approved messages POST here; otherwise they are logged. */
  slackWebhookUrl?: string;
  fetchImpl?: typeof fetch;
}

export function createMessageExecutor(opts: MessageExecutorOptions = {}): Executor {
  const post = opts.fetchImpl ?? fetch;
  return {
    kind: 'send_message',
    async execute(payload): Promise<JsonValue> {
      const { channel, text } = messageSchema.parse(payload);
      if (opts.slackWebhookUrl) {
        const res = await post(opts.slackWebhookUrl, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ channel, text }),
        });
        if (!res.ok) throw new Error(`Slack webhook responded ${res.status}`);
        return { delivered: true, via: 'slack', channel };
      }
      console.log(`[send_message] ${channel}: ${text}`);
      return { delivered: true, via: 'console', channel };
    },
  };
}

export function defaultActions(opts: MessageExecutorOptions = {}): ActionSpec[] {
  return [
    {
      kind: 'send_message',
      description: 'Post a message to a channel or member.',
      schema: messageSchema,
      defaultRiskTier: 'medium',
      executor: createMessageExecutor(opts),
    },
  ];
}

export function buildRegistry(specs: ActionSpec[]): ExecutorRegistry {
  const executors = new ExecutorRegistry();
  for (const spec of specs) executors.register(spec.executor);
  return executors;
}
