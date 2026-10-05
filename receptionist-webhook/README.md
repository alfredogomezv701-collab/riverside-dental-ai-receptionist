# receptionist-webhook

A Telnyx Edge Compute project (`telnyx.toml`, worker-style). Does two jobs for the AI receptionist:

1. **Dynamic-variables webhook** for the AI Assistants (`POST /?token=...`) — looks up the caller's
   phone number and returns `is_returning_patient`, `patient_name`, `next_appointment`,
   `appointment_count`, and the `flag/waitlist_mode` KV flag as conversation variables.
2. **Actor proxy** (`POST /actor/hold` / `/actor/confirm` / `/actor/release`, bearer-protected) —
   this is the only function that holds the real `DAY_SLOT` actor binding (a *reference* binding;
   `DaySlotActor` is owned by `day-slot-actor`, see its `telnyx.toml`), so `receptionist-mcp` reaches
   the actor through these routes instead of holding the binding itself. Why: `docs/ARCHITECTURE.md`,
   "Cross-function actor access."

Also verifies Telnyx's own webhook signature (Ed25519) before trusting the request body at all.

## Layout

| File | Purpose |
| --- | --- |
| `telnyx.toml` | Declares the `DAY_SLOT` actor reference binding, the `CACHE` KV namespace, and three secrets (`ACTOR_PROXY_SECRET`, `WEBHOOK_TOKEN`, `TELNYX_WEBHOOK_PUBLIC_KEY`). |
| `src/index.ts` | Entry point: routes `/` (dynamic variables), `/actor/*` (proxy), `/health`. |
| `src/patient_lookup.ts` | The dynamic-variables lookup: reads the waitlist flag and the patient's KV record concurrently, in one round trip. |
| `src/actor_routes.ts` | The `/actor/hold` / `/actor/confirm` / `/actor/release` proxy handlers. |
| `src/day_slot_binding.ts` | Type mirror of `DaySlotActor`'s public methods (kept in sync by hand - see the comment in the file). |
| `src/verify_webhook.ts` | Telnyx webhook signature verification (Ed25519 via WebCrypto). |
| `src/log.ts` | Structured logging with phone/token redaction. |
| `test/` | Unit tests against the HTTP entry point directly (no deploy needed). |

## Deploy

```sh
npm install
telnyx-edge ship
```

(No separate bundle step needed - worker-style projects are bundled client-side by the CLI itself,
unlike `receptionist-mcp`'s classic project.)

## Secrets

```sh
telnyx-edge secrets add WEBHOOK_TOKEN "$(openssl rand -hex 32)"
telnyx-edge secrets add ACTOR_PROXY_SECRET "$(openssl rand -hex 32)"
telnyx-edge secrets add TELNYX_WEBHOOK_PUBLIC_KEY "-----BEGIN PUBLIC KEY-----\n...\n-----END PUBLIC KEY-----"
```
