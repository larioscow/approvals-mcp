export interface ServerConfig {
  transport: 'http' | 'stdio';
  port: number;
  webhookSecret: string;
  webhookUrl?: string;
  slackWebhookUrl?: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  return {
    transport: env.APPROVALS_TRANSPORT === 'stdio' ? 'stdio' : 'http',
    port: Number.parseInt(env.PORT ?? '8787', 10) || 8787,
    webhookSecret: env.APPROVALS_WEBHOOK_SECRET ?? 'change-me',
    ...(env.APPROVALS_WEBHOOK_URL ? { webhookUrl: env.APPROVALS_WEBHOOK_URL } : {}),
    ...(env.SLACK_WEBHOOK_URL ? { slackWebhookUrl: env.SLACK_WEBHOOK_URL } : {}),
  };
}
