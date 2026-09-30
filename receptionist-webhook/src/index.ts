import type { KvNamespace } from '@telnyx/edge-runtime';
import { handleActorRoute } from './actor_routes.js';
import type { DaySlotNamespace } from './day_slot_binding.js';
import { logEvent, maskPhone, redact } from './log.js';
import { lookupPatient } from './patient_lookup.js';

export interface WebhookEnv {
  CACHE: KvNamespace;
  DAY_SLOT: DaySlotNamespace;
  SECRETS: { get(handle: string): Promise<string> };
}

/** Constant-time string compare: both sides are hashed so lengths never leak and buffers always match in size. */
async function safeEqual(a: string, b: string): Promise<boolean> {
  const enc = new TextEncoder();
  const [x, y] = await Promise.all([crypto.subtle.digest('SHA-256', enc.encode(a)), crypto.subtle.digest('SHA-256', enc.encode(b))]);
  const xb = new Uint8Array(x);
  const yb = new Uint8Array(y);
  let diff = 0;
  for (let i = 0; i < xb.length; i++) diff |= xb[i] ^ yb[i];
  return diff === 0;
}

/** True only when a secret is configured AND the presented value matches it. A missing secret never authenticates. */
async function authorised(env: WebhookEnv, handle: string, presented: string): Promise<boolean> {
  let secret = '';
  try {
    secret = await env.SECRETS.get(handle);
  } catch {
    secret = ''; // secret not created: fail closed
  }
  return secret !== '' && (await safeEqual(presented, secret));
}

export async function handleRequest(req: Request, env: WebhookEnv): Promise<Response> {
  const started = Date.now();
  const url = new URL(req.url);
  const request_id = req.headers.get('x-request-id') ?? crypto.randomUUID();
  const respond = (status: number, json: unknown, log: { route: string; outcome: string } & Record<string, unknown>) => {
    logEvent({ request_id, latency_ms: Date.now() - started, status, ...log });
    return Response.json(json, { status, headers: { 'x-request-id': request_id } });
  };

  try {
    if (req.method === 'GET' && url.pathname === '/health') {
      return new Response('OK');
    }

    // Assistant dynamic-variables webhook (event_type assistant.initialization). It returns a patient's
    // name and appointment details for whatever number it is asked about, so it is NOT public: the
    // assistants are configured with a URL carrying ?token=<WEBHOOK_TOKEN>. (Telnyx's own webhook
    // signature is a further hardening step - see docs/TODO.md.)
    if (req.method === 'POST' && url.pathname === '/') {
      if (!(await authorised(env, 'WEBHOOK_TOKEN', url.searchParams.get('token') ?? ''))) {
        return respond(401, { error: 'Unauthorized' }, { route: 'dynamic_variables', outcome: 'unauthorized' });
      }
      const body = (await req.json().catch(() => ({}))) as {
        data?: { payload?: { telnyx_end_user_target?: string; call_control_id?: string } };
      };
      const payload = body.data?.payload ?? {};
      const phone = payload.telnyx_end_user_target;
      const lookupStart = Date.now();
      const { vars, kvReads } = await lookupPatient(env.CACHE, phone);
      return respond(200, { dynamic_variables: vars }, {
        route: 'dynamic_variables',
        node: 'identify_caller',
        caller: maskPhone(phone),
        call_control_id: payload.call_control_id,
        outcome: vars.is_returning_patient === 'true' ? 'returning_patient' : 'new_caller',
        kv_reads: kvReads,
        lookup_ms: Date.now() - lookupStart,
        waitlist_mode: vars.waitlist_mode,
      });
    }

    // Internal actor proxy for receptionist-mcp.
    const actorMatch = /^\/actor\/([a-z]+)$/.exec(url.pathname);
    if (req.method === 'POST' && actorMatch) {
      const route = `actor/${actorMatch[1]}`;
      const bearer = (req.headers.get('authorization') ?? '').replace(/^Bearer /, '');
      if (!(await authorised(env, 'ACTOR_PROXY_SECRET', bearer))) {
        return respond(401, { error: 'Unauthorized' }, { route, outcome: 'unauthorized' });
      }
      const body = await req.json().catch(() => undefined);
      const { status, json } = await handleActorRoute(actorMatch[1], body, env.DAY_SLOT);
      const result = json as { success?: boolean; reason?: string };
      const b = (body ?? {}) as { date?: string; start?: string; callerId?: string };
      return respond(status, json, {
        route,
        node: 'actor_proxy',
        caller: maskPhone(b.callerId),
        slot: b.date && b.start ? `${b.date}T${b.start}` : undefined,
        outcome: status !== 200 ? 'bad_request' : result.success ? 'ok' : (result.reason ?? 'rejected'),
      });
    }

    return respond(404, { error: 'not found' }, { route: url.pathname, outcome: 'not_found' });
  } catch (err) {
    return respond(500, { error: 'internal error' }, {
      route: url.pathname,
      outcome: 'error',
      error: redact(err instanceof Error ? err.message : String(err)),
    });
  }
}

export default {
  fetch(req: Request, env: WebhookEnv): Promise<Response> {
    return handleRequest(req, env);
  },
};
