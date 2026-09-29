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
  Global edge — variable comparison:
      telnyx_conversation_duration_secs >= 300 → Escalate (from any node)
```

### Scheduling Specialist

```
Collect Details (prompt: service type, preferred date/time)
  → Check Availability (MCP tool: check_availability; KV-cached)
  → Hold Slot (Actor: DaySlotActor.holdSlot — starts an alarm)
  → Confirm (prompt: repeat back, get verbal yes)
      ├── Confirmed                              → Commit Booking (Actor: confirmSlot; MCP: book_appointment)
      ├── attempt_count >= 3 [variable comparison, reads KV flag] → Waitlist
      └── (no confirmation before alarm fires)    → hold auto-released by actor alarm, re-prompt
  → Closing (speak: confirmation + change/cancel instructions)
```

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

**Shared access**: a separate reminder function (invoked on a schedule, or chained from
the actor's own alarm mechanism) reads the same `DaySlotActor` to identify tomorrow's
bookings and trigger reminders — demonstrates the actor being addressed from more than
one call site.

## KV

- `avail:{service}:{date}` → cached `check_availability` results, short TTL. Avoids
  re-querying the (mock) calendar backend on every "what about 3pm instead?" turn.
- `flag:waitlist_mode:{service}:{date}` → feature flag, toggled without redeploy, read by
  the variable-comparison edge to reroute into a waitlist path when a day fills up.
- `patient:{phone}` → optional cache backing the dynamic webhook variable lookup (returning
  patient / next appointment), avoiding a repeat lookup within a short window.

Deliberately **not** used as a system of record — KV holds cache/session/flag data only,
per the challenge's own guidance ("pragmatic use of KV ... not a database replacement").
The actor is the source of truth for slot state.

## MCP server

Three tools, each scoped to the node(s) that need it:

1. `check_availability(service, date)` — used by Collect Details / Check Availability
2. `book_appointment(slot, patient)` — used by Commit Booking, only after the actor has
   confirmed the hold
3. `cancel_or_reschedule_appointment(appointment_id, ...)` — used by the reschedule/cancel
   path

## Dynamic Webhook Variables

Webhook receives the caller's number (`from`) from the Telnyx call event, looks up a
patient record (mock data store or KV cache), and returns:

- `is_returning_patient`
- `patient_name`
- `next_appointment` (if any)

These feed a personalized greeting and let Identify Intent route a returning caller with
an upcoming appointment straight into "manage existing appointment" instead of generic
intent detection.

## Observability

- **Structured logs**: every webhook invocation logs `{request_id, caller, node, outcome,
  latency_ms}` as JSON.
- **Request ID / tracing**: a request ID is generated at the Edge Function entry point and
  threaded through the Actor call and MCP tool calls, so a single call's path can be
  reconstructed from logs alone (covers the "distributed tracing" stretch goal as a
  byproduct of doing observability properly).
- **Metric beyond logs**: hold→confirm success rate (holds that convert to bookings vs.
  holds that expire via alarm). A spike in alarm-releases is the signal that something in
  the Confirm step is broken.
- **"How we'd know within a minute"**: TBD in detail once logs/metrics are wired up —
  planned answer is watching the hold-expiry rate and MCP tool error rate; documented
  fully in the README once implemented.
- **Debugging story**: to be filled in with a real incident hit during development
  (required for demo day — evidence, not vibes).

## Explicitly deferred / out of scope

- Object storage integration (no natural artifact from a voice-only flow)
- Real payment processing
- Any external vendor beyond Telnyx + a lightweight/mock calendar data source

## Open questions / decisions still needed

- [ ] Calendar backend: fully mocked in-memory data, or a real lightweight scheduling API?
- [ ] Exact hold TTL for `DaySlotActor` (proposed: 3 minutes)
- [ ] Where the MCP server is hosted (Edge Function vs. separate host) — see
      `docs/OPENCODE_SETUP.md` / Edge Compute docs once reviewed
