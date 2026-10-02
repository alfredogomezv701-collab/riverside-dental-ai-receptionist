import express from 'express';
import { env } from '@telnyx/edge-runtime';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { registerCheckAvailability } from './src/tools/check_availability_handler.js';
import { registerBookAppointment } from './src/tools/book_appointment_handler.js';
import { registerCancelOrReschedule } from './src/tools/cancel_or_reschedule_appointment_handler.js';
import { createHttpDaySlotNamespace } from './src/actors/day_slot_http_client.js';
import { bearerMatches } from './src/auth.js';
import { redact } from './src/log.js';

// receptionist-mcp is a classic (func.toml) project and can't hold the
// DAY_SLOT actor binding directly (see src/actors/day_slot_http_client.ts).
// Reach it over HTTP through receptionist-webhook instead; undefined when
// unconfigured falls back to the best-effort KV-only check in the tool
// handlers (documented there — not race-safe, dev/local use only).
const actorProxyUrl = process.env.ACTOR_PROXY_URL;
const actorProxySecret = process.env.ACTOR_PROXY_SECRET;
// One namespace per request so the request id rides along as x-request-id and shows up in the
// webhook's /actor/* log lines (MCP -> webhook -> actor traceable from logs alone).
const daySlotFor = (requestId: string) =>
  actorProxyUrl && actorProxySecret ? createHttpDaySlotNamespace(actorProxyUrl, actorProxySecret, requestId) : undefined;
if (!(actorProxyUrl && actorProxySecret)) {
  console.warn(
    'ACTOR_PROXY_URL/ACTOR_PROXY_SECRET not set - booking conflict-safety falls back to ' +
      'the non-race-safe KV-only check. Set both before deploying.',
  );
}

const sharedSecret = process.env.SHARED_SECRET;
const port = parseInt(process.env.PORT || '8080', 10);
const VERSION = process.env.VERSION || 'dev';

function secretPresent(name: string): boolean {
  const v = process.env[name];
  return v !== undefined && v !== '';
}

const app = express();
app.use(express.json());

app.get('/health', (_req, res) => res.status(200).json({
  status: 'ok',
  version: VERSION,
  secrets: {
    SHARED_SECRET: secretPresent('SHARED_SECRET'),
    ACTOR_PROXY_SECRET: secretPresent('ACTOR_PROXY_SECRET'),
    ACTOR_PROXY_URL: secretPresent('ACTOR_PROXY_URL'),
  },
}));
app.get('/health/liveness', (_req, res) => res.status(200).send('OK'));
app.get('/health/readiness', (_req, res) => res.status(200).send('OK'));

// Fail closed for EVERY method on /mcp: no secret configured is an outage, not an open door.
if (!sharedSecret) {
  console.warn('SHARED_SECRET is not set - /mcp refuses all requests. Set SHARED_SECRET before deploying.');
}
app.use('/mcp', (req, res, next) => {
  if (!sharedSecret) {
    res.status(503).json({
      error: 'SHARED_SECRET not configured',
      message: 'Run: telnyx-edge secrets add SHARED_SECRET "$(openssl rand -hex 32)"',
    });
    return;
  }
  if (!bearerMatches(req.headers.authorization, sharedSecret)) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  next();
});

app.post('/mcp', async (req, res) => {
  const server = new McpServer({
    name: 'receptionist-mcp',
    version: '1.0.0',
  });

  const requestId = (req.headers['x-request-id'] as string | undefined) ?? crypto.randomUUID();
  const ctx = {
    kv: env.CACHE,
    daySlot: daySlotFor(requestId),
    requestId,
  };
  registerCheckAvailability(server, ctx);
  registerBookAppointment(server, ctx);
  registerCancelOrReschedule(server, ctx);

  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on('close', () => {
    transport.close();
    server.close();
  });

  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error(
      JSON.stringify({
        ts: new Date().toISOString(),
        service: 'receptionist-mcp',
        request_id: requestId,
        outcome: 'transport_error',
        error: redact(err instanceof Error ? err.message : String(err)),
      }),
    );
    // Transport failures (malformed Streamable-HTTP framing, connect() throwing, etc.) happen
    // outside any registered tool handler, so logToolCall never sees them — this is the only
    // place that can. A thrown tool error is already turned into a JSON-RPC error result by the
    // SDK before it gets here, so headers are typically still open at this point.
    if (!res.headersSent) {
      res.status(500).json({ error: 'internal error', request_id: requestId });
    }
  }
});

app.listen(port, () => {
  console.info(`receptionist-mcp listening on port ${port}`);
});
