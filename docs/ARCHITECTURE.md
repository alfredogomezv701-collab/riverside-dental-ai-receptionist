# Architecture — Riverside Dental AI Receptionist

## Use case

Phone line for a dental clinic. Callers can book, reschedule, or cancel an appointment,
ask billing/insurance questions, or ask general FAQs. Returning callers are recognized
and greeted with context about their existing appointment.

## Why this use case

Evaluated against the challenge's required primitives (workflow, MCP, dynamic variables,
Edge Function, KV, Stateful Actor):

- Most "receptionist/support/order" ideas only need per-caller state, which is already
  single-threaded within one call — a Stateful Actor there is decorative.
- Appointment slot booking is the one case with **genuine cross-caller contention**: two
  callers can try to grab the same time slot at once. That's exactly the read-modify-write
  race the Actor's single-threaded execution model is for, not a per-caller convenience.
- Extended with a **hold-then-confirm lifecycle** (see Actors below), the Actor goes from
  "serializes one write" to "owns a stateful lifecycle with a timeout" — this is what
  pushed the design past a minimal single-node use of the primitive.

## Assistants (multi-assistant routing)

1. **Front Desk** (main, entry point) — greeting, caller identification, intent routing
2. **Scheduling Specialist** — book/reschedule/cancel flow, own tool scope
3. **Billing Specialist** — insurance/payment questions, different persona/voice, own tools

Rationale: distinct personas and distinct tool scopes per specialist keep each node's
tool list short (per the challenge's own guidance: fewer tools per node = more reliable
tool selection), and this is the cleanest way to demonstrate real multi-assistant routing
rather than just more nodes in one assistant.

## Conversation Workflow

### Front Desk

```
Greeting (speak — clinic name + disclosure)
  → Identify Caller (dynamic webhook variables: known patient? existing appt?)
  → Identify Intent (prompt)
      ├── Scheduling   [LLM condition]        → handoff to Scheduling Specialist
      ├── Billing      [LLM condition]        → handoff to Billing Specialist
      ├── FAQ          [LLM condition]        → Answer FAQ (prompt, no handoff)
      └── Escalate     [LLM condition]        → Escalate (speak)
  Variable comparison, on every conversational node (the API has no "from any node" edge, so
  it is repeated per node):
      telnyx_conversation_duration_secs >= 300 → Escalate
  Greeting → returning-caller intent node   when is_returning_patient == "true" (else the default edge)
```

### Scheduling Specialist

```
Collect Details (prompt: service type, preferred date/time)
  → Check Availability (MCP tool: check_availability; computed from real bookings, not cached)
        └── waitlist_mode == "true" [variable comparison on the KV flag] → Waitlist (speak) → hang up
            (new-booking path only: the same node also handles cancel/reschedule, which must never hit it)
  → Confirm (prompt: repeat back, get verbal yes)
      ├── Confirmed                              → Book (MCP tool: book_appointment)
      │                                              ├── success → Closing (speak)
      │                                              └── slot_already_booked / invalid_slot / slot_unavailable
      │                                                    └── re-prompt with fresh availability
      │                                                        (attempt_count >= 3 -> waitlist: not built)
      └── Not confirmed                          → back to Collect Details
  Collect Details → Change/Cancel (MCP tool: cancel_or_reschedule_appointment) → Closing (change/cancel)
        └── failures (not found, new slot taken) → back to Check Availability / Collect Details
  Every conversational node: telnyx_conversation_duration_secs >= 300 → Escalate (speak)
```

**Implementation note — this differs from the original per-node hold/confirm split
sketched during planning, worth flagging since it's a real design decision, not just
a naming change:** `book_appointment` (the MCP tool) calls the actor's `holdSlot` and
`confirmSlot` back-to-back internally, in one tool call — there is no separately
exposed "hold" MCP tool the workflow calls before the verbal confirm step. That means:

- The actor's hold window (~3 min) now exists to make the book-time check-then-set
  atomic against a *concurrent caller*, not to span the *in-conversation* verbal
  confirmation dialogue the way "Hold Slot → Confirm → Commit Booking" as three
  separate nodes would have implied.
- The verbal "repeat back, get a yes" Confirm node has to happen **before** calling
  `book_appointment`, not between a hold and a confirm call — since there's no
  MCP-visible hold state to sit in the middle of.
- This is simpler and already built/tested (see `receptionist-mcp`'s `book_appointment`
  tool and its actor integration tests). If a true multi-turn "we're holding your slot
  while you decide" experience turns out to matter for the demo, splitting
  `book_appointment` into separate `hold_slot`/`confirm_booking` MCP tools is a small,
  well-scoped follow-up — the actor already supports it, only the tool surface would
  change.

Reschedule/cancel follow the same shape, calling `cancel_or_reschedule_appointment`.

## Stateful Actors

**`DaySlotActor`** — one instance per clinic-day. Owns that day's slot map.

- `holdSlot(slot, callerId)`: read current state, reject if taken/held, otherwise mark
  held and schedule an **alarm** (~3 min) to auto-release if not confirmed.
- `confirmSlot(slot, callerId)`: cancels the pending alarm, marks the slot booked.
- `releaseSlot(slot, callerId)`: explicit release (caller changes mind).
- `onAlarm()`: if the hold was never confirmed, releases the slot back to available.

This is the one true single-threaded read-modify-write requirement in the system: without
it, two simultaneous callers could both read "2pm available" and both book it.

**Known limitation, flagged for Q&A rather than hidden**: the conflict key is
`slot:{start}` — exact start time only, no duration, so the actor alone would let a
90-minute root canal at 09:00 and a 30-minute cleaning at 09:30 coexist. The MCP layer closes that
gap without changing the actor: `book_appointment` and reschedule list the day's bookings and reject
any that overlap in real time (`findConflict`). That check is check-then-act, not atomic, so two
simultaneous *overlapping-but-not-identical* bookings could still both pass; identical starts are
still race-safe in the actor. The complete fix would be to hold every 30-minute quantum an
appointment occupies inside the actor, in one atomic call.

**Shared access**: a separate reminder function (invoked on a schedule, or chained from
the actor's own alarm mechanism) reads the same `DaySlotActor` to identify tomorrow's
bookings and trigger reminders — demonstrates the actor being addressed from more than
one call site.

## Cross-function actor access: HTTP proxy, not a native binding

`DaySlotActor` lives in its own deployed function (`day-slot-actor/`), a `telnyx.toml`
(worker-style) project. `receptionist-mcp` — the MCP server that calls `holdSlot`/
`confirmSlot`/`releaseSlot` from the `book_appointment` and `cancel_or_reschedule_appointment`
tools — is an Express server, because the MCP TypeScript SDK's
`StreamableHTTPServerTransport` needs a real Node request/response server, not the
`fetch(req, env)` handler shape Telnyx's worker-style functions use.

That matters because of a real platform constraint, found empirically while wiring this
up (not something either function's docs stated up front): **`telnyx-edge types`
refuses to type an `[[actors]]` binding inside a "classic" (`func.toml`) project.**
Actor bindings only work in `telnyx.toml`-style projects. Since `receptionist-mcp` has
to stay classic (Express/MCP SDK constraint above), it **cannot hold `DaySlotActor` as a
native binding**, no matter how the manifest is written.

Two ways to resolve that were considered:

- **Rewrite `receptionist-mcp` to worker-style**, so it can hold the binding directly.
  Rejected: the MCP SDK's transport has no official support for the Fetch
  `Request`/`Response` model worker-style functions use, so this would mean hand-rolling
  a replacement for the Streamable HTTP transport — real risk of subtle protocol bugs,
  for a rewrite of code that was already tested and working, with no upstream
  precedent to lean on.
- **Keep `receptionist-mcp` classic, and reach the actor over HTTP** through
  `receptionist-webhook` (also `telnyx.toml`/worker-style, and needs building anyway for
  the dynamic-webhook requirement) — which holds the real `DAY_SLOT` binding and exposes
  three internal routes the MCP server calls with a shared secret, the same way it would
  call any other edge function:

  - `POST /actor/hold` → `{ date, start, callerId, holdDurationMs? }` → `DaySlotHoldResult`
  - `POST /actor/confirm` → `{ date, start, callerId }` → `DaySlotConfirmResult`
  - `POST /actor/release` → `{ date, start, callerId }` → `DaySlotReleaseResult`

  **Chosen.** Lower risk (doesn't touch already-tested Express/MCP SDK code), and the
  webhook function needed building regardless. It also better demonstrates "choosing
  the right edge primitive for each job" — a classic container for the piece that needs
  a real server, a worker-style function for the piece that needs a binding — rather
  than forcing one execution model to do both jobs.

Implementation: `book_appointment_handler.ts` and `cancel_or_reschedule_appointment_handler.ts`
are written against a `DaySlotNamespace`/`DaySlotStub` interface
(`src/actors/day_slot_binding.ts`) that mirrors `DaySlotActor`'s public method shapes —
they have no idea whether it's backed by a native binding or HTTP.
`src/actors/day_slot_http_client.ts` implements that interface over `fetch()`. If a
future need justified giving `receptionist-mcp` a real binding after all, only that one
file would change.

**Trade-off accepted**: an extra network hop and one more shared secret
(`ACTOR_PROXY_URL`/`ACTOR_PROXY_SECRET`) versus a same-process call. Given `DaySlotActor`
holds are short-lived (~3 min) and this is a booking flow, not a latency-critical
real-time path, that cost is acceptable.

**Tested, not just described**: `receptionist-mcp/test/day_slot_integration.test.ts`
spins up a real local HTTP server backed by the actual `DaySlotActor` class (imported
across the project boundary), and runs the production `createHttpDaySlotNamespace`
client against it — exercising the real HTTP round trip (including an auth-rejection
case for a wrong shared secret), not a same-process stand-in.

## KV

Telnyx KV keys may only contain `a-z A-Z 0-9 - _ / = .` (a `:` separator was the first bug hit
live), so every key uses `/` and times drop the colon (`0900`).

- `flag/waitlist_mode` → feature flag (`on`), toggled without redeploy. The webhook reads it on
  every call (cached 5 s in isolate memory) and returns it as the `waitlist_mode` variable that
  the Scheduling workflow's variable-comparison edge tests.
- `patient/{phone10}` → **the record the dynamic-variables webhook answers from, in one read**:
  `{ patientName, appointments: [{ appointmentId, service, date, start }] }`. The appointments are
  denormalised into it because KV reads are ~0.5 s each and that lookup blocks the start of every
  conversation. `book_appointment`, reschedule and cancel keep it in step (`src/patients.ts`);
  cancelling the last appointment deletes it. It is keyed on the last 10 digits, and a caller ID
  with fewer than 10 digits is never looked up (nor accepted at booking), so an anonymous or junk
  number can never collapse onto a shared key. Two older shapes are still read (one extra read).
- `booking/{date}/{HHMM}` → one record per booked slot; `check_availability` and the booking
  overlap check list the day's prefix to see what is taken.
- `appointment/{id}` → the appointment record `cancel_or_reschedule_appointment` operates on.

**Deliberately not cached:** availability. It was cached at first (`avail/{service}/{date}`, 60 s),
but a cached answer is wrong the moment someone books, which is exactly when the next caller asks;
and the dynamic-variables lookup cache went stale the same way (a caller who booked and rang back
within its TTL was greeted as new). Both caches were removed rather than invalidated: fewer places
that must remember to keep something in step, and the uncached reads are cheap enough.

For *slot conflict state* specifically, KV is deliberately not the source of truth — the
actor owns that, per the challenge's own guidance ("pragmatic use of KV ... not a
database replacement").

**Honest caveat, not glossed over**: the appointment *record* itself (patient name,
phone, service, date/time — `booking/...`, `appointment/...`, `patient/...`) lives in KV with no
TTL and no other backing store. That's really acting as the system of record for bookings, not a
cache — there's no provisioned database in this project, and KV is what's available. This is a
scope trade-off worth being upfront about, not something the architecture claims is "just
caching." Its read-modify-write on `patient/{phone10}` is also not atomic (two simultaneous
bookings for the same phone could lose an update); the per-slot race the challenge cares about
is the actor's job.

## MCP server

Three tools, each scoped to the node(s) that need it:

All three share one calendar module (`src/calendar.ts`) so what is *offered* and what is *accepted*
cannot disagree: a known service, a real future weekday (clinic-local date), a start time on that
service's grid (back-to-back slots inside 09:00-17:00) that the mock backend doesn't mark busy, and no
overlap with an existing booking of any length.

1. `check_availability(service, date)` — the service's grid minus everything already booked that day
   (including slots inside a longer appointment). Never cached.
2. `book_appointment(service, date, start, patientName, patientPhone)` — validates the slot, then the
   actor's `holdSlot` + `confirmSlot` back-to-back in one call (see the implementation note under
   Scheduling Specialist above), then writes the booking, appointment and patient records together.
   A retry of the identical booking returns the existing appointment (`alreadyBookedByYou`). If the KV
   writes fail after the actor confirmed the slot, the slot is released and the writes that did land are
   undone, so a slot can never be booked with nobody holding an appointment for it.
3. `cancel_or_reschedule_appointment(appointmentId, action, ...)` — reschedule secures and confirms the
   *new* slot first, writes, and only then lets go of the old one (any failure leaves the original booking
   intact and gives the new slot back); cancel frees the slot then deletes the records (retry-safe).

## Dynamic Webhook Variables

Telnyx POSTs an `assistant.initialization` event to the webhook (`telnyx_end_user_target` = the
caller's number). It answers from `flag/waitlist_mode` and `patient/{phone10}`, read concurrently
(one KV round trip; no cache, no writes on the request path), and returns strings:

- `is_returning_patient` (`"true"`/`"false"`), `patient_name`
- `next_appointment` / `next_appointment_id` — the soonest appointment that hasn't passed
  (clinic-local date), and `appointment_count` of upcoming ones
- `waitlist_mode` — the KV flag

The webhook fires when a conversation starts, which on a *voice* call should be once (per the docs)
but on the *chat* channel is every turn (observed) — another reason it must be fast (about 0.5-0.8 s
against the 3000 ms timeout configured on the assistants; the defaults on the assistants make a
timeout look like a new caller).

**It is not public.** It returns a person's name and appointment id for whatever number it is asked
about, so the assistants are configured with `.../?token=<WEBHOOK_TOKEN>` and the route compares it
in constant time, failing closed if the secret was never created. Verifying Telnyx's own webhook
signature is a further hardening step, not done.

These feed a personalised greeting, and a deterministic edge (`is_returning_patient == "true"`) sends
a returning caller to a different intent node than a new one.

**Project type**: `receptionist-webhook` must be a `telnyx.toml`/worker-style project
(scaffolded with `telnyx-edge new-func --actor --language=ts`, same as `day-slot-actor`),
not a classic `func.toml` one — it needs to hold the `DAY_SLOT` actor binding directly
and expose the `/actor/hold` / `/actor/confirm` / `/actor/release` proxy routes
`receptionist-mcp` calls over HTTP. See "Cross-function actor access" above for why
`receptionist-mcp` itself can't hold that binding and has to reach it this way.

## Observability

All implemented; the runbook and the debugging stories are in the README.

- **Structured logs**: every request on the webhook logs one JSON line (`request_id`, masked `caller`,
  `outcome`, `latency_ms`, plus `kv_reads`/`lookup_ms` on the dynamic-variables route and `slot` on the
  actor proxy); every MCP tool call logs `request_id`, `tool`, masked caller, `outcome`, `latency_ms`.
  Callers are masked to the last four digits and long digit runs are redacted from error text (a KV
  error can quote a key such as `patient/5551234567`).
- **Request ID / tracing**: the MCP server generates a request id per `/mcp` request and forwards it as
  `x-request-id` to the actor proxy, where the webhook logs it, so one booking is reconstructable
  MCP -> webhook -> actor by grepping one id (covers the "distributed tracing" stretch goal).
- **Signals beyond logs**: `latency_ms` / `lookup_ms` / `kv_reads` on the critical-path webhook (this is
  what exposed the 2.7 s latency bug), and the per-tool `outcome` field, which groups into an error rate.
  Not built: hold→confirm conversion counters from the actor's alarm sweep.
- **A synthetic monitor**: `npm run test:probe` in `assistants/` exercises the deployed functions and a
  full no-LLM booking round trip, and doubles as a "did the last deploy break anything" check.

## Explicitly deferred / out of scope

- Object storage integration (no natural artifact from a voice-only flow)
- Real payment processing
- Any external vendor beyond Telnyx + a lightweight/mock calendar data source

## Open questions / decisions still needed

- [x] Calendar backend: the *grid* (which slots exist, and which the "backend" marks busy) is a
      deterministic mock in `src/calendar.ts`, but availability now reflects real bookings and
      booking validates against the same module, so what is offered is what is accepted
- [x] Hold TTL for `DaySlotActor`: 3 minutes (`DEFAULT_HOLD_DURATION_MS`), implemented
- [x] MCP server hosting: Telnyx Edge Compute itself, classic (`func.toml`) project —
      settled as part of the actor-wiring work; see "Cross-function actor access" above
- [ ] Whether `book_appointment`'s collapsed hold+confirm (vs. separate MCP tools) needs
      splitting apart for a true multi-turn "holding your slot" conversational
      experience — see the implementation note under Scheduling Specialist above
