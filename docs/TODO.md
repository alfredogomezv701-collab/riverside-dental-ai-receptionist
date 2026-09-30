# Project status and TODO

Nothing here is committed yet (holding per instruction). The README has the architecture, runbook and bug
stories; `docs/LEARNINGS.md` (gitignored) has the private notes.

## Where things stand

| Piece | State |
|---|---|
| `day-slot-actor` (Stateful Actor, alarm) | shipped, 17 tests |
| `receptionist-webhook` (dynamic variables + actor proxy) | shipped and verified live, 34 tests (token auth, phone validation, multi-appointment record) |
| `receptionist-mcp` (3 tools) | shipped and verified live, 103 tests |
| Assistants (Front Desk, Scheduling, Billing) | created via API and updated to the current definitions (`update.mjs --apply` run) |
| `assistants/` tests | 44 offline; live suite 30/30 passing (incl. a no-LLM end-to-end backend test), leaves KV clean |
| Phone number | not assigned |
| README / demo script | written; one `TODO` placeholder (the phone number) |

## Ship sequence used for the last batch (done)

`.env.local` (gitignored) holds `WEBHOOK_TOKEN` and `MCP_SHARED_SECRET`; both were also set on Telnyx
(`telnyx-edge secrets add`), and the MCP integration secret `receptionist_mcp_token` was recreated with the new bearer.

```powershell
$cli = "C:\Users\Bruce\bin\telnyx-edge.exe"
cd receptionist-mcp;     npm run bundle; & $cli ship      # first
cd ..\receptionist-webhook;               & $cli ship
# then: node assistants/update.mjs --apply ; npm run test:probe ; npm run test:live
```

Until both ships finish the assistants' MCP calls will 401 (they now present the rotated bearer) and the old webhook
ignores the token; harmless (nobody is calling yet), but do the ships back to back.

## Manual checklist: things no script here can do

**A. After the ships**
- [x] `node assistants/update.mjs --apply` and `npm run test:live`: 30/30 green
- [ ] Portal > AI Assistants: three assistants listed; Front Desk's Workflow tab renders nodes/edges/hand-offs and is editable
- [ ] Assign the phone number to the **Front Desk** assistant only; put it in the README
- [ ] **Real calls are refused until the caller's number is verified (or the account tier is upgraded).** Every inbound PSTN call
      showed up as a carrier record with `hangup_cause: USER_BUSY`, SIP 486, `telnyx_error_code: D61` ("Account tier requires verified
      numbers"), no `connection_id` and zero duration; the Portal web test works because it bypasses the phone network. The account has
      **no verified numbers** (`GET /v2/verified_numbers` is empty). Fix: Portal > Numbers > Verified Numbers, verify the cell phone(s)
      that will call (and the number for the Portal's "Call me" button), or upgrade the account tier. Then re-test a call and confirm a
      `call_initiated` event and an `ai-voice-assistant` record appear (`GET /v2/call_events`, `GET /v2/detail_records`).
      A demo audience's phones will ALSO be refused unless the tier is upgraded, so sort this out before demo day

**B. Real phone calls** (keep `telnyx-edge logs receptionist-webhook --type runtime --tail` open)
- [ ] New caller, happy path: disclosure heard verbatim **once** (chat showed a repeat quirk after a hand-off), hand-off to
      Scheduling, real slots offered, confirm, book; the `booking/{date}/{HHMM}` key exists
- [ ] **Count the `dynamic_variables` log lines for one call: expect 1** (chat fires it every turn; voice should be once per docs)
- [ ] Returning caller from the same number: greeted by name, told about the soonest appointment
- [ ] Two appointments on one number: assistant mentions the soonest, and says only the soonest is on file when cancelling
- [ ] Billing / insurance question: Billing persona and voice, no booking tools; "and I also want an appointment" hands to Scheduling
- [ ] FAQ (hours) answered without "I'm not certain"
- [ ] Cancel / reschedule by voice; after a cancel the closing says "All done", not "We'll see you"
- [ ] Slot race: two phones, same slot; the second hears the fresh-availability fallback
- [ ] Hand-off audio: `voice_mode` "distinct" (Front Desk -> specialists) sounds intentional; name/service carry over
- [ ] Scheduling -> Front Desk hand-back ("actually I have a billing question"): does the AI/recording disclosure replay? If so
      decide whether that matters (a hand-back always re-enters Front Desk's start node)
- [ ] Escalation: set `ESCALATION_SECS` to ~20, `update.mjs --apply`, stay on the line: Escalate message then hang-up.
      **Set it back to 300 and re-apply**
- [ ] Waitlist: `telnyx-edge storage kv key put 3c826291-8337-4141-821c-080f0bb32c28 flag/waitlist_mode on`, call to *book*:
      Waitlist message with no redeploy (allow ~5 s for the flag cache); call to *cancel* while it is on: the cancel still works.
      Then set the flag back to `off`
- [ ] Hang-up tool ends the call cleanly after Closing / Waitlist / Escalate
- [ ] **Chicago time zone (pending, untested on a call):** say "3pm" with no zone (assumes Central); say "I'm in Pacific" (asks and
      converts); confirm `{{telnyx_current_time_America/Chicago}}` renders rather than appearing literally
- [ ] Silence, barge-in and a noisy line behave acceptably (`user_idle_timeout_secs` 20)
- [ ] Webhook latency on real calls: `lookup_ms` well under 3000 (it was 0.5-0.8 s); any `new_caller` for a known number means a timeout
- [ ] Caller ID blocked/anonymous: treated as a new caller, and booking asks for a real number

**C. Demo prep**
- [ ] `telnyx-edge metrics receptionist-webhook --since 24h` shows something usable for the "signal beyond logs" story
- [ ] Rehearse "how would you know within a minute": break something on purpose (wrong `WEBHOOK_TOKEN`), find it from logs alone
      (`unauthorized` burst), restore it
- [ ] Decide whether to pin a model (unpinned: Telnyx default resolved to Kimi-K2.6); pin with `ASSISTANT_MODEL` + `update.mjs --apply`
- [ ] Balance was $4.92; confirm the promo credit with Stephen before heavy testing
- [ ] Fill the README's `TODO` placeholder for the phone number
- [ ] Ada Lovelace's record (`+15551234567`, 2026-10-07 10:00, older record shape) is kept as returning-caller demo data. It will be in
      the past by demo day, so `next_appointment` will be empty; book a fresh demo appointment instead

## Not built (decide: build or explain)

- Verify Telnyx's own webhook signature on `POST /` (the URL token is the current protection)
- `attempt_count >= 3 -> waitlist` edge (needs a counter variable); a persisted waitlist
- hold->confirm conversion counters from the actor's alarm sweep (a metric beyond logs)
- Atomic multi-quantum holds in the actor (overlap is currently a check-then-act in the MCP layer)
- A reminder function reading the same actor (shared-actor stretch; the reference binding pattern is already proven by the webhook)
- Object storage (deliberately skipped)

## Upgrades: small, bounded improvements

Each is a couple of hours at most and shows a different skill; all are good candidates to build with OpenCode and a
Telnyx-hosted model. Suggested order: 1, 2, 3, then 5 if time allows, plus the model note.

- [ ] **1. Verify Telnyx's webhook signature on `POST /`** (closes the biggest "not built" item).
      Telnyx signs the request with ed25519 headers (`telnyx-signature-ed25519`, `telnyx-timestamp`); needs the account public key
      as a new secret. Unit-test valid, tampered, wrong-key and stale-timestamp cases without a live call. Keep the URL token as
      defence in depth. Confirm against the Telnyx webhook-signing docs, and check that the runtime's WebCrypto supports Ed25519.
- [ ] **2. Hold-to-booking metrics in `DaySlotActor`**: count holds that convert to bookings vs holds that expire in the alarm
      sweep, store the counters in actor storage, expose them (e.g. `getStats()` through a new `/actor/stats` route). This is the
      "signal beyond logs" the brief asks for and a good use of actor storage. Test in `day-slot-actor` with the mock context.
- [ ] **3. `attempt_count >= 3` waitlist edge + a real waitlist.** Small `join_waitlist(date, service, patientName, patientPhone)`
      MCP tool writing `waitlist/{date}/...` to KV; the waitlist message can then truthfully say the request was noted. Adds the
      second variable-comparison edge from `docs/REQUIREMENTS.md`. Needs a counter variable (e.g. count `slot_already_booked` results
      via the webhook or an `update_dynamic_variables` tool). Update the assistant flow test, the prompt-variable lint and the live suite.
- [ ] **4. A reminder function that reads the same actor** (real "shared actors" demo): a scheduled function asks the actor, through
      the webhook function's proxy route, for tomorrow's bookings and logs/sends reminders. Third function, clean division of labour.
- [ ] **5. Atomic multi-slot holds in the actor**: hold every 30-minute quantum an appointment occupies in ONE actor call, so overlap
      stops being check-then-act in the MCP layer. Turns the documented limitation into a strength; the best answer to
      "what happens with different-length appointments?". Keep `findConflict` as a belt-and-braces check. Needs an actor change and a ship of
      `day-slot-actor` (5-9 min) as well as the other two.
- [ ] **6. `/health` reports version and secret presence**: on each function, return the deployed git commit and whether each
      expected secret exists (never the value), so a deploy can be verified at a glance and the probe test can assert the expected version.
- [ ] **Model comparison note**: run one small task (e.g. item 3) with two Telnyx-hosted models, write a few lines on what worked and what
      did not. The brief explicitly asks for the model choice and dogfooding experience.
- [ ] **Prompt quality pass with scripted callers** using the chat harness: an interrupter, someone who gives everything in one sentence,
      someone who changes their mind mid-booking, someone who asks for a person. Turn each failure it finds into a regression test.

## Known limitations to state in Q&A

MCP tools can't be scoped per node (only shared tools can), so scoping is per assistant. The calendar grid is a mock; bookings
are real; KV is the system of record. `patient/{phone10}` is a non-atomic read-modify-write. Chat and voice differ (webhook per
turn vs per call). The clinic time zone is fixed. Full list in the README.

## Edge-case routing audit (prompt nodes without fallback edges)

These prompt nodes have **only LLM-conditioned edges** and no deterministic fallback. If the caller says something ambiguous
the model does not confidently classify, the conversation stays on the node and the assistant goes silent.

| Assistant | Node | Risk | Scenario |
|---|---|---|---|
| Front Desk | `n_intent` / `n_intent_returning` | **Medium** | Caller says something ambiguous like "I'm not sure what I need" or "Can you tell me what you do?" |
| Front Desk | `n_faq` | Low | Caller gives a follow-up thank-you or asks another FAQ after the first answer |
| Scheduling | `n_collect` | Low | Caller says something off-script like "This is a test call" or gives random input |
| Scheduling | `n_offer` | Low | Caller says "I'll think about it" or "Let me call back later" |
| Scheduling | `n_book` | **Medium** | Tool returns an unexpected error (network timeout, 500, etc.) that is not `slot_already_booked` / `slot_unavailable` / `invalid_slot` |
| Scheduling | `n_manage` | **Medium** | Caller changes topic mid-cancel/reschedule, or tool returns an unexpected error |
| **Billing** | `n_billing` | **HIGH** | Caller asks a general FAQ (hours, location) — Billing has **no FAQ node and no handoff to Front Desk**, so the call gets stuck |

Fixes to apply before demo day:
- [ ] Add `e_intent_unclear` → loop back or ask for clarification on Front Desk intent nodes
- [ ] Add `e_faq_unclear` → stay on FAQ or route to goodbye on Front Desk FAQ node
- [ ] Add `e_book_unclear` → retry or escalate on Scheduling book node (covers unexpected tool errors)
- [ ] Add `e_manage_unclear` → retry or escalate on Scheduling manage node
- [ ] **Add `e_billing_faq` → handoff to Front Desk** so Billing can route general questions out

## Live URLs

- day-slot-actor: https://day-slot-actor-4cabbc85-0.telnyxcompute.com
- receptionist-webhook: https://receptionist-webhook-baaf7d07-b.telnyxcompute.com
- receptionist-mcp: https://receptionist-mcp-f366a7db-0.telnyxcompute.com/mcp
- KV namespace `receptionist-cache`: `3c826291-8337-4141-821c-080f0bb32c28`
