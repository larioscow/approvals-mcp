import { randomUUID } from 'node:crypto';
import { IDEMPOTENCY_HEADER, SIGNATURE_HEADER, verifySignature } from '@approvals-mcp/core';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import express, { type Express, type Request, type Response } from 'express';
import type { AppDeps } from './factory';
import { buildServer } from './server';

export function createHttpApp(deps: AppDeps): Express {
  const app = express();
  // Raw body on the webhook path so the HMAC is verified over the exact bytes.
  app.use('/webhooks', express.raw({ type: '*/*' }));
  app.use(express.json());

  const transports = new Map<string, StreamableHTTPServerTransport>();

  app.get('/healthz', (_req, res) => {
    res.json({ ok: true });
  });

  app.post('/mcp', async (req: Request, res: Response) => {
    const sessionId = req.header('mcp-session-id');
    const existing = sessionId ? transports.get(sessionId) : undefined;

    let transport: StreamableHTTPServerTransport;
    if (existing) {
      transport = existing;
    } else if (!sessionId && isInitializeRequest(req.body)) {
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (sid: string) => {
          transports.set(sid, transport);
        },
      });
      transport.onclose = () => {
        if (transport.sessionId) transports.delete(transport.sessionId);
      };
      await buildServer({ service: deps.service, specs: deps.specs }).connect(transport);
    } else {
      res.status(400).json({
        jsonrpc: '2.0',
        error: { code: -32000, message: 'Bad Request: no valid session id' },
        id: null,
      });
      return;
    }
    await transport.handleRequest(req, res, req.body);
  });

  const session = async (req: Request, res: Response): Promise<void> => {
    const sessionId = req.header('mcp-session-id');
    const transport = sessionId ? transports.get(sessionId) : undefined;
    if (!transport) {
      res.status(400).send('Invalid or missing session id');
      return;
    }
    await transport.handleRequest(req, res);
  };
  app.get('/mcp', session);
  app.delete('/mcp', session);

  // Inbound receiver: verify the signature, dedupe by idempotency key.
  const seen = new Set<string>();
  app.post('/webhooks/inbound', (req: Request, res: Response) => {
    const raw = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : '';
    if (!verifySignature(deps.config.webhookSecret, raw, req.header(SIGNATURE_HEADER) ?? '')) {
      res.status(401).json({ error: 'bad signature' });
      return;
    }
    const key = req.header(IDEMPOTENCY_HEADER);
    if (key && seen.has(key)) {
      res.status(200).json({ ok: true, duplicate: true });
      return;
    }
    if (key) seen.add(key);
    res.status(202).json({ ok: true });
  });

  return app;
}

export async function startHttp(deps: AppDeps): Promise<void> {
  const app = createHttpApp(deps);
  await new Promise<void>((resolve) => {
    app.listen(deps.config.port, () => {
      console.log(`approvals-mcp listening on :${deps.config.port} (POST /mcp)`);
      resolve();
    });
  });
}
