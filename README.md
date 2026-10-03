# Riverside Dental - AI Receptionist (Telnyx FDE Challenge)

A voice receptionist for a dental clinic, built on Telnyx Voice AI (multi-assistant Conversation
Workflows), a custom MCP server, and Telnyx Edge Compute (Edge Functions, KV, Stateful Actors).
Callers can book, reschedule or cancel an appointment, ask billing/insurance or general questions, and
returning callers are recognised by phone number.

| | |
|---|---|
| **Phone number** | `+1 (218) 506-9277` |
| **Portal-assigned** | Yes |
| **Verified-numbers restriction** | Account requires caller numbers to be verified (`D61` block for unverified callers). Demo audience may need their numbers added via Portal > Numbers > Verified Numbers. |
| **Dynamic-variables webhook** | `https://receptionist-webhook-baaf7d07-b.telnyxcompute.com` (`POST /?token=...`, token-protected) |
| **MCP server** | `https://receptionist-mcp-f366a7db-0.telnyxcompute.com/mcp` (bearer-protected) |
| **Actor owner function** | `https://day-slot-actor-4cabbc85-0.telnyxcompute.com` (no public surface; called through the webhook function) |
| **Assistant IDs** | [`assistants/ids.json`](assistants/ids.json) |

Design docs: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) (decisions and trade-offs),
[`docs/REQUIREMENTS.md`](docs/REQUIREMENTS.md) (challenge checklist), [`docs/TODO.md`](docs/TODO.md)
(status, manual test checklist). Both endpoints above are protected on purpose, so they cannot be
exercised with a bare `curl`; to try the system, call the number or run the test suites below.

## Architecture

```
 Caller (phone)
      |
      v
 Front Desk assistant ----------------- dynamic variables webhook ----> receptionist-webhook (Edge Function)
   Greeting (speak, verbatim)           POST /?token=...                   |  1 KV round trip:
     -> Identify Intent (prompt)        -> is_returning_patient,           |  flag/waitlist_mode + patient/{phone}
        |-- LLM edges ---+---> Answer FAQ (prompt)   patient_name,         |
        |                +---> Escalate (speak)      next_appointment,      +--> KV  (patient index, bookings, flag)
        |   variable edge: telnyx_conversation_      appointment_count,     +--> /actor/{hold,confirm,release}
        |   duration_secs >= 300 -> Escalate         waitlist_mode                    |
        v                                                                             v
   hand-off (assistant edges)                                          DaySlotActor (Stateful Actor, one per clinic day)
   |                    |                                               hold -> confirm | alarm auto-releases stale holds
   v                    v                                                             ^
 Scheduling Specialist   Billing Specialist                                            | HTTP + x-request-id
   Collect -> Check Availability -> Confirm -> Book                       receptionist-mcp (Express + MCP SDK)
   + Change/Cancel branch, Waitlist, Escalate      ---- MCP tools ---->     check_availability
   (3 MCP tools attached here only)                                         book_appointment
                                                                            cancel_or_reschedule_appointment
```

### Which primitive for which job

| State | Where | Why |
|---|---|---|
| Two callers racing for one time slot | **`DaySlotActor`** (one instance per clinic day) | A genuine read-modify-write across callers. The actor's single-threaded execution makes hold/confirm atomic without a lock; the alarm gives stale holds a timeout. |
| Bookings, appointment records, patient index | **KV** | A shared record other functions read. Honest caveat: with no database in this project, KV is the system of record for appointments, not just a cache. |
| `flag/waitlist_mode` | **KV** | Flip a workflow path live with no redeploy (read on every webhook call, cached 5 s in isolate memory). |
| Availability | **computed on read** from the grid + real bookings | Deliberately *not* cached: a cached answer is wrong the moment someone books. |
| Per-call conversation state | **Telnyx** (dynamic variables, workflow position) | Not ours to store. |

**Why the webhook function holds the actor binding, not the MCP server:** `telnyx-edge types` refuses an
`[[actors]]` binding in a classic (`func.toml`) project, and the MCP server has to be classic (the MCP SDK's
Streamable HTTP transport needs a real Node server). So the MCP server reaches the actor over an authenticated
HTTP route on `receptionist-webhook` (`telnyx.toml` style, which can hold the binding). Details and the
rejected alternative are in `docs/ARCHITECTURE.md`.

### Workflow design choices

- **Speak nodes** where wording must not vary (AI/recording disclosure, closings, escalation, waitlist).
- **Variable-comparison edges** for anything deterministic: returning vs new caller
  (`is_returning_patient == "true"`), the KV `waitlist_mode` flag, and the 300-second time box on every
  conversational node. **LLM edges** only for real intent decisions.
- **Tool scoping:** workflow nodes can only take *shared* tools, not MCP tools, so scoping is per assistant:
  Scheduling has the three MCP tools; Front Desk and Billing have none.
- Confirm always precedes Book (no edge reaches Book from anywhere else); a lost slot race loops back to fresh
  availability; the waitlist edge applies only to the new-booking path so nobody calling to *cancel* is turned away.

## Running it

**Prerequisites:** Node 20+, the [`telnyx-edge` CLI](https://github.com/team-telnyx/edge-compute/releases)
authenticated (`telnyx-edge auth api-key set ...`), a Telnyx API key, OpenCode with `@telnyx/opencode`
(see [`docs/OPENCODE_SETUP.md`](docs/OPENCODE_SETUP.md)).

```bash
# 1. secrets (account-wide; there is no way to read one back, so keep what you generate)
telnyx-edge secrets add ACTOR_PROXY_SECRET "$(openssl rand -hex 32)"   # MCP -> webhook /actor/*
telnyx-edge secrets add SHARED_SECRET      "$(openssl rand -hex 32)"   # assistant -> MCP bearer
telnyx-edge secrets add WEBHOOK_TOKEN      "$(openssl rand -hex 32)"   # ?token= on the dynamic-variables URL
telnyx-edge secrets add ACTOR_PROXY_URL    "https://<receptionist-webhook invoke URL>"

# 2. deploy, in this order (the webhook's actor binding needs the owner to exist)
(cd day-slot-actor       && npm install && telnyx-edge ship)
(cd receptionist-webhook && npm install && telnyx-edge ship)
(cd receptionist-mcp     && npm install && npm run bundle && telnyx-edge ship)   # bundle first, see note

# 3. assistants (needs TELNYX_API_KEY, MCP_SHARED_SECRET, WEBHOOK_TOKEN in the environment)
node assistants/setup.mjs            # dry run: prints every request body
node assistants/setup.mjs --apply    # creates the secret, MCP server, hang-up tool and 3 assistants
node assistants/update.mjs --apply   # later: push edits to definitions.mjs

# 4. assign a phone number to the *Front Desk* assistant in the Portal
```

> **Why `npm run bundle`:** shipping a classic project from Windows lost nested `src/` files on the builder
> (`TS6053 ... not found`), so `receptionist-mcp` ships one esbuild bundle, `server.mjs`. It is generated, and
> gitignored, so run the bundle step before every ship of that function.

## Testing

| Command | What it covers | Cost |
|---|---|---|
| `cd receptionist-mcp && npm test` | tool logic: calendar, validation, overlap, idempotency, multi-appointment records, rollback on partial failure, auth, logging; integration tests drive the **real `DaySlotActor`** over a real local HTTP round trip | free |
| `cd receptionist-webhook && npm test` | token auth (fail-closed), phone validation, one-round-trip lookup, the actor proxy through the real actor | free |
| `cd day-slot-actor && npm test` | hold / confirm / release / alarm sweep | free |
| `cd assistants && npm test` | workflow graph integrity, rubric coverage, every `{{variable}}` and edge variable is defined, tool allowlist vs MCP source | free |
| `cd assistants && npm run test:probe` | just the deployed-function checks and the no-LLM end-to-end backend test (a fast synthetic monitor) | free |
| `cd assistants && npm run test:live` | deployed assistants vs definitions; deployed functions; **a deterministic no-LLM end-to-end backend test**; real chat conversations through workflow + MCP + actor + KV | a little inference credit |

The live suite loads `TELNYX_API_KEY`, `MCP_SHARED_SECRET` and `WEBHOOK_TOKEN` from the environment, uses random
dates and phone numbers, and cancels every booking it makes. Conversations are driven over Telnyx's chat API
(`POST /ai/conversations`, `POST /ai/assistants/{id}/chat`), whose messages expose `assistant_id`,
`active_flow_node_id` and tool calls, so routing is asserted rather than eyeballed.

## Observability

**What is logged.** Every request on both edge functions writes one JSON line
(`telnyx-edge logs <fn> --type runtime`):

- webhook, dynamic variables: `request_id, caller (last 4 digits only), outcome (returning_patient | new_caller | unauthorized | error), kv_reads, lookup_ms, latency_ms, waitlist_mode`
- webhook, actor proxy: `request_id, route, slot, caller, outcome (ok | already_booked | already_held_by_other | unauthorized | bad_request)`
- MCP, per tool call: `request_id, tool, caller, outcome, latency_ms` (and `error`, with phone digits redacted)

**Tracing one booking.** The MCP server generates a `request_id` per `/mcp` request and forwards it as
`x-request-id` to the actor proxy, so one booking is reconstructable across MCP -> webhook -> actor by grepping a
single id. **Signals beyond logs:** `latency_ms` / `lookup_ms` / `kv_reads` on the critical-path webhook (this is what
exposed the latency bug below), plus the per-tool `outcome` field, which groups into a rate.

**How I'd know within a minute that the assistant is broken, and what I'd look at first**

1. **Something is failing outright:** `telnyx-edge logs receptionist-webhook --type runtime --since 5m` and
   `... receptionist-mcp ...`, filtering for `"outcome":"error"` and `"outcome":"unauthorized"`. A burst of
   `unauthorized` on the webhook means the assistants' `?token=` no longer matches the `WEBHOOK_TOKEN` secret (every
   caller would silently be treated as new); on the MCP server it means the integration secret and `SHARED_SECRET`
   have drifted (every tool call fails).
2. **Callers are slow to get a reply:** `lookup_ms` / `latency_ms` on `dynamic_variables` lines. The assistants
   time the webhook out at 3000 ms; healthy is ~0.5-0.8 s. Creeping toward 3 s means a KV round trip got slower or
   `kv_reads` went above 1.
3. **Bookings failing:** MCP lines with `outcome` other than `ok` / `slot_already_booked`, and the matching
   `request_id` on the webhook's `actor/*` lines.
4. **A one-command synthetic check** (no inference credit): `cd assistants && npm run test:probe` runs the deployed-functions
   and no-LLM end-to-end backend suites; if that is green and calls still fail, the fault is in the assistant/workflow config, so
   start from the conversation's messages (`GET /ai/conversations/{id}/messages`) and look at `active_flow_node_id`.

### Bugs found while building, and how (the evidence trail)

1. **`500` on the first live webhook call.** `/health` and the actor proxy worked; `POST /` returned
   `{"error":"internal error"}`. The webhook's own log line said it: `outcome:"error"`, `env KV get("flag:waitlist_mode")
   failed: HTTP 400 ... Invalid key format. Allowed characters: a-z A-Z 0-9 - _ / = .`. Telnyx KV rejects `:` in keys and
   every key used it; unit tests passed because the in-memory KV fake accepted anything. Fixed with `/` separators, and
   both test fakes now enforce the real character set.
2. **MCP endpoint returned `-32700 Parse error` for every authenticated call.** `index.ts` never called
   `server.connect(transport)` and passed the server object where the parsed body belongs. 42 unit tests passed because
   they called the tool handlers directly, never the HTTP entry point. Found by the first live call.
3. **Book-then-call-back greeted a known patient as new.** The chat-driven live test booked successfully, then the
   webhook said `is_returning_patient: false`. Logs showed the webhook had been called when the conversation *started*
   (`new_caller`), and my 60-second lookup cache had stored that answer. The fix was to delete the cache entirely.
4. **A 2.7 s webhook against a 3 s timeout, with no failing test.** `latency_ms` in the logs showed 1.6-3.5 s per
   call; the cause was 3-4 *sequential* KV round trips (~0.5-0.9 s each), and the webhook fires on **every chat turn**
   (4 turns = 4 log lines). Fix: read the flag and the patient record concurrently, denormalise appointments into the
   patient record, drop the cache. Measured afterwards from the same logs: ~0.5-0.8 s, `kv_reads: 1`.
5. **"What time do you open?" answered "I'm not certain".** The chat harness showed the reply on a routing turn is still
   generated by the node being *left*; the clinic facts were only in the FAQ node. Moved to assistant-level instructions.
6. **Code review of the finished system found real gaps**, all fixed and test-covered: availability ignored bookings; the
   webhook was unauthenticated while returning names and appointment ids; a junk caller ID collapsed to the bare key
   `patient/` and leaked one caller's details to others; a waitlist edge sat on the node that also handles cancellations;
   partial KV failures could leave the actor holding a slot with no appointment record.

## Known limitations

- **Real phone calls are the least-tested path.** Everything above was exercised through the text chat API; voice
  behaviour (hand-off audio, the Front Desk greeting re-playing after a hand-back, the webhook firing once per call
  rather than per turn) is on the manual checklist in `docs/TODO.md`.
- The calendar is a deterministic mock (`slotGrid`, with some slots marked busy); real bookings are real. Appointments live
  in KV with no database behind them.
- The actor keys holds by exact start time. Overlap between different-length appointments is enforced in the MCP layer
  from the KV bookings (check-then-act), not atomically in the actor.
- The patient record is a read-modify-write on one key: two simultaneous bookings for the *same phone* could lose an update.
- The dynamic-variables webhook is protected by a URL token; verifying Telnyx's own webhook signature is a further hardening step.
- The clinic time zone is fixed to America/Chicago; whether the `telnyx_current_time_America/Chicago` variable renders on a live
  call is still to be confirmed.
- No waitlist is persisted; the waitlist message says so.

## Demo script (about 10 minutes)

1. **Architecture** (2 min): the diagram above; why the actor is used for slots and KV for the rest; why the MCP server
   reaches the actor through the webhook function.
2. **Live call, new caller** (3 min): greeting speak node, hand-off to Scheduling, `check_availability`, confirm, book.
   Watch `telnyx-edge logs receptionist-webhook --type runtime --tail` and `... receptionist-mcp ...` alongside, and follow
   one `request_id` through MCP -> webhook -> actor.
3. **Live call, returning caller** (1 min): same number, greeted by name with the appointment (dynamic variables +
   variable-comparison edge).
4. **Race and fallback** (1 min, one phone): right before calling, run `node scripts/book-test-slot.mjs <date> <start>` to
   book that slot under a decoy patient directly through MCP (no second phone, no inference cost). Then call and ask for
   that same slot live: the assistant hits `slot_already_booked` and falls back to fresh availability on the call; show
   the actor's `already_booked` in the logs. Flip `flag/waitlist_mode` in KV with
   `telnyx-edge storage kv key put <ns> flag/waitlist_mode on` and show the deterministic waitlist path with no redeploy,
   same call. Cancel the decoy appointment afterward (the script prints the exact command).
5. **Observability + one bug** (2 min): pick bug 4 (latency): the log line, the change, the before/after numbers.
6. **Tests** (1 min): `npm run test:live`, especially the no-LLM end-to-end backend test.

## OpenCode configuration

`.opencode/opencode.json` has the `@telnyx/opencode` plugin active; setup is in [`docs/OPENCODE_SETUP.md`](docs/OPENCODE_SETUP.md).

### Model comparison and dogfooding notes

Two Telnyx-hosted models drove most of the actual implementation work in this repo, in this order:

**GLM-5.2** (OpenCode's own default when you install the Telnyx plugin) — first pass. Coming from
Claude Sonnet as a baseline, the friction was autonomy: give Claude a reasonably clear instruction
and it infers the steps and just runs them; GLM, on that first pass, tended to lay out everything it
planned to do and stop for confirmation even when the ask had already been explicit. Not an
unreasonable default behavior in general, but it meant more back-and-forth than expected for
already-clear instructions.

**Kimi-K2.6** — switched to this next, partly to get away from the confirmation friction, and partly
because this was still before the promo code landed and credits were tight, so comparing models
mattered. Kimi had the opposite problem: it ran things immediately without over-checking, which was
the autonomy I wanted, but it also frequently did *more* than asked — scope creep in the other
direction, something I recognize from Claude too, just more pronounced here.

The clearest example: I asked it to write tests for the live API. It wrote far more test code than
needed — enough that a lot of it turned out redundant and got discarded later, which is the actual
origin of `assistants/test/live.test.mjs` later getting trimmed down to one LLM-based end-to-end test
plus the no-LLM backend suite (see `docs/TODO.md`). Worse, it then **ran those tests itself before I'd
asked it to** — and because live tests place real inference calls (writing the tests, executing them,
reading back the results all cost tokens, and the same inference budget pays for both my coding
assistant and the assistant-under-test), that one unprompted step alone burned about $2 of account
balance at a moment when I had roughly $3 left and was being deliberately conservative. That incident —
spending real money without being asked, right when the budget was tightest — is a big part of why I
moved off Kimi once the promo code came through and I didn't need to tolerate it anymore.

Code quality was also the weaker of the two — enough that I started routing code reviews through
Claude Code instead of trusting Kimi's own review output, which was also a reasonable call
given credits were already tight at that point.

**Back to GLM-5.2** — once the promo code came through and the pressure to economize on model choice
eased, I went back to GLM. The second impression was considerably better than the first: faster, and
better at actually running/producing correct code. On context: the two read roughly the same number
of files for comparable work, but GLM simply has a much larger context window, so it takes longer to
fill up and I restart/summarize sessions less often with it. That's a real trade-off, not a pure win —
a bigger window sitting fuller for longer can make an individual GLM session more expensive than it
looks, and GLM being faster end-to-end is what actually offsets that, not the window size itself. I
still restart/summarize early as a matter of habit regardless of model, since it's cheap insurance
either way. I'll also caveat that GLM's code reviews surfacing fewer issues than Kimi's is confounded
by timing — by the time GLM was reviewing, the codebase was already in better shape from earlier
fixes, so it's not a clean apples-to-apples comparison of review quality.

The early "asks for confirmation on everything" behavior from the first GLM session didn't recur in
later ones — unclear whether that's because I got more explicit in how I prompt it, or whether the
first session was just an unlucky sample (it was only one session before the second attempt). Either
way, net verdict: GLM ended up the stronger model for this work once I'd learned how to prompt it,
close enough to Claude Sonnet for this kind of task that the gap felt small by the end — even though
Kimi logged more total hours across the project simply because the rocky first GLM impression came
before credits were secure enough to freely experiment.
