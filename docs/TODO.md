# Project status and TODO

The README has the architecture, runbook and bug stories; `docs/LEARNINGS.md` (gitignored) has the private
notes. Commit history: 7 commits so far, `d475a9c` is current HEAD ("Duration-aware actor holds, webhook
signature verification, actor stats, Telnyx Portal tests").

## Blocked on credits

- [ ] **Use Telnyx's own Tests functionality in the Portal UI** (there's a dedicated Tests section for AI
      Assistants) to validate the assistants, not just our own `assistants/test/` suite

## Code review: everything up to current HEAD (done, in two passes)

Both passes used a subagent briefed on `code_challenge.md`'s actual grading rubric, not generic review.

**Pass 1** (`receptionist-mcp` + `day-slot-actor`, pre-actor-wiring state): 5 findings, all fixed or
consciously deferred — see the "Done so far" entry in the Historical section below for the detail.

**Pass 2** (`6890be8..40cbcf7` — the `75ad071`/`40cbcf7` build-out batch: actor, webhook, MCP, assistants,
tests). Verdict: strong, deliberate work — Actor use genuinely justified (not shoehorned), KV usage matches
documented scope, hold/release/rollback logic unusually careful about partial-failure cases, tests assert
real state transitions (actual races, real HTTP round trips, a real `DaySlotActor` imported across project
boundaries in webhook tests too). 3 real findings:
- [x] **Fixed**: `receptionist-mcp/index.ts`'s `/mcp` POST handler had no try/catch around the transport
      plumbing (`server.connect`/`transport.handleRequest`) — unlike `receptionist-webhook`, which wraps
      everything and returns a structured 500. A transport-level failure (outside any registered tool call,
      so `logToolCall` never sees it) would have become an unhandled rejection with no JSON response. Now
      wrapped, logs with `request_id`, returns a structured 500 if headers aren't already sent. 106/106
      tests pass.
- **Not a current issue, but a real finding at the reviewed commit**: at `40cbcf7`, `docs/TODO.md` claimed
  4 of the 5 edge-case-audit fallback edges were implemented when only `e_confirm_unclear` actually existed
  in `definitions.mjs` — a real doc/code mismatch on a grading-relevant point at that point in history. Note
  for the record only: this was already resolved in the very next commit (`d475a9c`, reviewed separately in
  Pass 1's successor check), which actually added all 4 missing edges (`e_billing_faq`, `e_book_unclear`,
  `e_manage_unclear`, `e_faq_unclear`) — confirmed present in the current file. No action needed now.
- **Known gap, not fixed**: `assistants/test/flow.test.mjs`'s "never dead-ends a prompt node" test only
  asserts a node has *some* outgoing edge, not that an ambiguous/off-script utterance specifically has
  somewhere to go — it would have stayed green even with the missing unclear-edges above. Worth knowing for
  Q&A if asked why the test suite didn't catch that gap itself.

## Where things stand

| Piece | State |
|---|---|
| `day-slot-actor` (Stateful Actor, alarm) | shipped, 17 tests |
| `receptionist-webhook` (dynamic variables + actor proxy) | shipped and verified live, 34 tests (token auth, phone validation, multi-appointment record) |
| `receptionist-mcp` (3 tools) | shipped and verified live, 103 tests |
| Assistants (Front Desk, Scheduling, Billing) | created via API and updated to the current definitions (`update.mjs --apply` run) |
| `assistants/` tests | 51 offline (incl. fallback-edge & AI routing stubs); live suite trimmed to 1 LLM-based E2E booking test + no-LLM backend suite; 4 Telnyx Portal AI Tests ready to create via `scripts/create-telnyx-tests.mjs` |
| Phone number | assigned to Front Desk; real call succeeded 2026-09-30 |
| README / demo script | written; phone number filled in (`+1 (218) 506-9277`) with verified-numbers disclaimer |

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
- [x] `node assistants/update.mjs --apply` and `npm run test:live`: 30/30 green (before trimming)
- [ ] Ship `/health` endpoints: `npm run bundle` in receptionist-mcp, then `telnyx-edge ship` all three functions
- [ ] Run `node scripts/create-telnyx-tests.mjs --apply` and verify 4/4 Portal AI Tests pass
- [ ] Portal > AI Assistants: three assistants listed; Front Desk's Workflow tab renders nodes/edges/hand-offs and is editable
- [x] Assign the phone number to the **Front Desk** assistant — done, real call succeeded 2026-09-30.
- [x] **Verified-numbers / account-tier block — RESOLVED 2026-09-30.** Was: every inbound PSTN call refused
      (`telnyx_error_code: D61`, no verified numbers on the account). Fixed via Portal > Numbers > Verified
      Numbers (or tier upgrade); a real call went through afterward. If a demo audience calls from numbers
      that still aren't verified, they'll hit the same D61 — worth a reminder close to demo day

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

- `attempt_count >= 3 -> waitlist` edge (needs a counter variable); a persisted waitlist
- A reminder function reading the same actor (shared-actor stretch; the reference binding pattern is already proven by the webhook)
- Object storage (deliberately skipped)

## Upgrades: small, bounded improvements

Each is a couple of hours at most and shows a different skill; all are good candidates to build with OpenCode and a
Telnyx-hosted model. Suggested order: 1, 2, 3, then 5 if time allows, plus the model note.

- [x] **1. Verify Telnyx's webhook signature on `POST /`** (closes the biggest "not built" item).
      Implemented in `receptionist-webhook/src/verify_webhook.ts` using WebCrypto `subtle.verify` with Ed25519.
      Added `TELNYX_WEBHOOK_PUBLIC_KEY` secret binding in `telnyx.toml`. Verified before URL token check
      (defence in depth). Unit tests cover valid signature, tampered body, stale timestamp (>5min),
      wrong key, missing headers, and fallback when key is not configured. All 43 webhook tests pass.
- [x] **2. Hold-to-booking metrics in `DaySlotActor`**: implemented. `confirmSlot` increments a
      `conversions` counter, the alarm sweep increments `expirations` (only on primary quantums).
      Stats stored in actor storage (`stats` key). Exposed via `/actor/stats` route on the HTTP surface
      and proxied through the webhook's `/actor/stats` GET route. Returns `{conversions, expirations,
      conversionRate}`. 31/31 day-slot-actor tests pass.
- [ ] **3. `attempt_count >= 3` waitlist edge + a real waitlist.** Small `join_waitlist(date, service, patientName, patientPhone)`
      MCP tool writing `waitlist/{date}/...` to KV; the waitlist message can then truthfully say the request was noted. Adds the
      second variable-comparison edge from `docs/REQUIREMENTS.md`. Needs a counter variable (e.g. count `slot_already_booked` results
      via the webhook or an `update_dynamic_variables` tool). Update the assistant flow test, the prompt-variable lint and the live suite.
- [ ] **4. A reminder function that reads the same actor** (real "shared actors" demo): a scheduled function asks the actor, through
      the webhook function's proxy route, for tomorrow's bookings and logs/sends reminders. Third function, clean division of labour.
- [x] **5. Atomic multi-slot holds in the actor**: implemented. `holdSlot` now accepts `durationMinutes`
      (default 30) and holds every 30-min quantum atomically. `confirmSlot` and `releaseSlot` operate
      on all quantums. `findConflict` in MCP layer kept as belt-and-suspenders. Tested with mock
      context: 90-min appointment holds 3 quantums, rival can't book any of them, confirming books
      all, alarm sweeps all, expiration counted once. 31/31 day-slot-actor tests pass; 106/106 MCP
      tests pass; 43/43 webhook tests pass.
- [x] **6. `/health` reports version and secret presence**: implemented on all 3 functions. Returns `{status, version, secrets: {NAME: boolean}}`.
      Probe test verifies deployed `/health` endpoints. Needs ship (`npm run bundle && telnyx-edge ship`) to take effect live.
- [ ] **Model comparison note**: run one small task (e.g. item 3) with two Telnyx-hosted models, write a few lines on what worked and what
      did not. The brief explicitly asks for the model choice and dogfooding experience.
- [ ] **Prompt quality pass with scripted callers** — PARTIALLY MIGRATED to Telnyx Portal AI Tests
  (see `scripts/create-telnyx-tests.mjs`). Remaining: a real interrupt test and a mind-changer test
  that exercise turn-taking and barge-in (voice-only, not testable in chat).

## Telnyx Portal AI Tests (created via API, not in repo)

Four behavioral tests are defined in `scripts/create-telnyx-tests.mjs` and ready to be created
in the Portal with `--apply`. They validate the scenarios removed from `live.test.mjs`:

| # | Test Name | What it validates | Assistant |
|---|---|---|---|
| 1 | Front Desk: Disclosure + Hours FAQ | Greeting has verbatim disclosure; FAQ returns hours without "not certain" | Front Desk |
| 2 | Front Desk: Route booking to Scheduling | "I want to book" → hands off to Scheduling | Front Desk |
| 3 | Front Desk: Route insurance to Billing | Insurance question → Billing, no booking tools called | Front Desk |
| 4 | Scheduling: Availability from tool | `check_availability` is called, slots are real not hallucinated | Scheduling |

**Why this matters for the demo:** it shows we use Telnyx's native testing infrastructure (A/B
versioning, traffic distribution, Portal test runs) rather than relying solely on custom scripts.
**Cost:** creating tests is free; running them costs ~same inference as the chat-based tests they replaced.

To create: `node scripts/create-telnyx-tests.mjs --apply` (needs `TELNYX_API_KEY`).
To run: Portal > AI Tests > Run, or API `POST /ai/tests/{id}/run`.

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

Fixes to apply before demo day (implemented; require live-call verification):
- [x] Add `e_intent_unclear` → loop back or ask for clarification on Front Desk intent nodes *(implemented, tested offline — needs live ambiguous-caller verification)*
- [x] Add `e_faq_unclear` → stay on FAQ or route to goodbye on Front Desk FAQ node *(implemented, tested offline — needs live off-script follow-up verification)*
- [x] Add `e_book_unclear` → retry or escalate on Scheduling book node (covers unexpected tool errors) *(implemented, tested offline — needs live tool-error verification)*
- [x] Add `e_manage_unclear` → retry or escalate on Scheduling manage node *(implemented, tested offline — needs live changed-topic verification)*
- [x] **Add `e_billing_faq` → handoff to Front Desk** so Billing can route general questions out *(implemented, tested offline — needs live general-question-in-Billing verification)*

## Live URLs

- day-slot-actor: https://day-slot-actor-4cabbc85-0.telnyxcompute.com
- receptionist-webhook: https://receptionist-webhook-baaf7d07-b.telnyxcompute.com
- receptionist-mcp: https://receptionist-mcp-f366a7db-0.telnyxcompute.com/mcp
- KV namespace `receptionist-cache`: `3c826291-8337-4141-821c-080f0bb32c28`

---

## Historical: original planning log (pre-shipping)

Written and maintained by hand through the planning/local-build phase, before anything was shipped or the
assistants existed. Never committed at the time (commits were held per instruction), so when the `75ad071`
commit introduced a new `docs/TODO.md` from scratch, this version wasn't in git history to merge from —
reconstructed here from the session transcript instead, so nothing from that phase is lost. Superseded by
the sections above for current status; kept for the record of *why* things were built the way they were
(architecture decisions, what was tested and how, what was explicitly deferred and why).

### Done so far (at time of writing)

- [x] Repo scaffolded: `docs/REQUIREMENTS.md`, `docs/ARCHITECTURE.md`, `docs/OPENCODE_SETUP.md`,
      `docs/EDGE_COMPUTE_SETUP.md`
- [x] OpenCode installed, `@telnyx/opencode` plugin wired locally (`.opencode/`)
- [x] `telnyx-edge` CLI installed (Windows build) and authenticated
- [x] KV namespace `receptionist-cache` created (real, provisioned)
- [x] `receptionist-mcp` function registered (real `func_id`, not yet shipped)
- [x] `check_availability` MCP tool implemented — real `env.CACHE` KV binding (not a stub), 15 passing
      tests, clean `tsc` build
- [x] **Full code review run** (subagent, briefed on `code_challenge.md`'s actual grading rubric) against
      `receptionist-mcp` + `day-slot-actor`. Verdict: solid, deliberate work, no undocumented `any`/unsafe
      casts, tests assert real state transitions. 5 findings, all resolved or consciously deferred:
  - **Fixed**: `book_appointment` orphaned the actor's hold if `confirmSlot` failed right after a
    successful `holdSlot` — slot stayed locked up to 3 min for every other caller even though the current
    caller was told booking failed. Fixed with a `releaseSlot` call in that branch; regression test added.
  - **Fixed**: stray stale compiled `.js` files sitting next to `.ts` sources in `day-slot-actor` (not from
    any build script — removed); `.gitignore` extended to cover `dist-test/` too.
  - **Fixed**: `@telnyx/edge-runtime` was pinned to `latest` in `day-slot-actor` vs. `^0.16.0` in
    `receptionist-mcp` — risk of silent drift between the two hand-synced type contracts
    (`day_slot_binding.ts`). Both pinned to `^0.16.0`.
  - **Documented, not fixed**: `ARCHITECTURE.md` overstated KV's role — claimed "cache/session/flag only,"
    but the actual appointment record (patient name/phone/service/time) lived in KV with no TTL and no
    other backing store, which really is acting as a system of record. Corrected to state this plainly as
    an accepted trade-off (no provisioned DB), not glossed over.
  - **Documented, not fixed**: `DaySlotActor`'s conflict key was exact start-time only, no duration — a
    90-min and a 30-min appointment with overlapping but different start times don't collide. Flagged as a
    known Q&A item rather than built out at the time.
  - 42/42 tests passing in `receptionist-mcp` at that point, 17/17 in `day-slot-actor`.

### MCP server (`receptionist-mcp/`) build-out

- [x] `book_appointment(service, date, start, patient)` tool — KV-backed, 8 tests
- [x] `cancel_or_reschedule_appointment(appointmentId, action, ...)` tool — KV-backed, 10 tests. Both tools'
      MCP descriptions noted that slot-conflict checking was, at that point, a best-effort KV get-then-put,
      not race-safe — explicitly flagged as the actor's job once it existed, not silently papered over
- [x] All 3 required MCP tools built; 34/34 tests passing at that point, clean `tsc` build

### `DaySlotActor` (Stateful Actor) build-out

- [x] `telnyx-edge new-func --actor --language=ts --name=day-slot-actor` (real func_id, registered)
- [x] `holdSlot(start, callerId, holdDurationMs?)` — read-check-write + reschedules the actor's single
      alarm to the earliest pending hold expiry
- [x] `confirmSlot(start, callerId)` — marks booked, reschedules/clears the alarm
- [x] `releaseSlot(start, callerId)` — explicit release (also used for cancellation)
- [x] `alarm(alarmInfo)` — sweeps all expired holds (not just one — the runtime gives each actor exactly
      ONE alarm, not one per hold, so every hold-changing call recomputes the single alarm to the
      next-earliest expiry across all pending holds)
- [x] 17 tests against a hand-written mock `ActorContext`/`ActorStorage` (matching the real
      `@telnyx/edge-runtime` interfaces), including the actual race scenario: two callers holding the same
      slot, only one wins

### Actor-wiring decision: HTTP proxy, not a native binding

- [x] **Actor wired into `receptionist-mcp`** via HTTP, not a native binding:
  - `book_appointment` calls `holdSlot` then `confirmSlot`; `cancel_or_reschedule`'s cancel path calls
    `releaseSlot`; reschedule secures the *new* slot via the actor **before** releasing the old one, so a
    failed reschedule can't lose the patient's original booking (this reordering also fixed a real bug: the
    original code deleted the original KV booking before checking whether the new slot was even available)
  - Falls back to a KV-only best-effort check only when the actor proxy isn't configured (e.g. local dev) —
    not race-safe, documented as such
  - Integration tests spin up a real local HTTP server backed by the **actual `DaySlotActor` class**
    (cross-project import via a `tsconfig.test.json` with `rootDir: ".."`) and exercise the real production
    HTTP client (`createHttpDaySlotNamespace`) against it — real network round trips, including an
    auth-rejection case and an actual concurrent-race test (`Promise.all` of two booking attempts for the
    same slot — exactly one wins)
- [x] **Real platform constraint discovered while wiring this (not previously known):** `telnyx-edge types`
      refuses to type `[[actors]]` bindings in a "classic" `func.toml` project — actors only work in
      `telnyx.toml`-style projects. `receptionist-mcp` had to stay classic (Express + the MCP SDK's
      `StreamableHTTPServerTransport` need a real Node server), so it **cannot** hold `DAY_SLOT` as a
      native binding. Resolved by keeping `receptionist-mcp` on `func.toml` and reaching the actor over
      HTTP through `receptionist-webhook` instead (which holds the real binding, no server-framework
      constraint there). Rejected alternative: rewriting `receptionist-mcp` to worker-style so it could
      hold the binding directly — real risk, since the MCP SDK's transport has no official support for the
      Fetch `Request`/`Response` model. Full writeup in `docs/ARCHITECTURE.md`, "Cross-function actor
      access."
  - `src/actors/day_slot_binding.ts` — hand-rolled `DaySlotNamespace`/`DaySlotStub` type contract
    (interface only)
  - `src/actors/day_slot_http_client.ts` — HTTP implementation of that contract
    (`createHttpDaySlotNamespace`), reads `ACTOR_PROXY_URL`/`ACTOR_PROXY_SECRET`
  - Handler code (`book_appointment_handler.ts`, etc.) only knows the interface, not which implementation
    backs it — swapping HTTP for a native binding later would touch one file

### Webhook Edge Function — planned shape (before it was built)

- [ ] Needs to be `telnyx.toml`/worker-style (NOT classic) specifically so it can hold the `DAY_SLOT` actor
      binding — see "Cross-function actor access" in `docs/ARCHITECTURE.md`
- [ ] `[[actors]]` binding to `DaySlotActor` (`binding = "DAY_SLOT"`)
- [ ] Caller lookup (phone → patient record; mock data store or KV-cached)
- [ ] Returns `is_returning_patient`, `patient_name`, `next_appointment`
- [ ] Reads/writes `avail:*` and `flag:waitlist_mode:*` KV keys where relevant
- [ ] `/actor/hold`, `/actor/confirm`, `/actor/release` routes — the proxy contract
      `receptionist-mcp`'s `createHttpDaySlotNamespace` calls; bearer-auth with `ACTOR_PROXY_SECRET`
      (separate secret from the assistant's own webhook auth).
      `receptionist-mcp/test/day_slot_integration.test.ts` was effectively the spec for these routes

### Nice to have, as originally prioritized (see `docs/REQUIREMENTS.md` for rationale)

- [ ] Alarms in `DaySlotActor` (folded into the actor work — high priority, done alongside the actor)
- [ ] Multi-assistant routing (folded into the workflow work)
- [ ] Shared actor access — a second (reminder) function reading `DaySlotActor`
- [ ] KV feature flag (`waitlist_mode`) actually gating a workflow path
- [ ] Distributed tracing (folded into observability work)
- [ ] Extra variable-comparison edge (`attempt_count >= 3` → waitlist)
- [ ] Object storage — deprioritized, likely skipped

### Open questions at the time

- [ ] Calendar backend: keep the current deterministic mock, or wire something real?
- [ ] Confirm actor alarm API specifics once `day-slot-actor` is scaffolded
- [ ] Whether `TELNYX_API_KEY` secret is needed on the MCP function at all (only if a tool calls the Telnyx
      API directly — original tools didn't)
