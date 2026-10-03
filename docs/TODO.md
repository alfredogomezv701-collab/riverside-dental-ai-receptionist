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
| `day-slot-actor` (Stateful Actor, alarm) | shipped, 31 tests |
| `receptionist-webhook` (dynamic variables + actor proxy) | shipped and verified live, 44 tests |
| `receptionist-mcp` (4 tools incl. `join_waitlist`) | shipped and verified live (incl. `kv_reads`/`lookup_ms` latency breakdown on `check_availability`), 137 tests |
| Assistants (Front Desk, Scheduling, Billing) | `setup.mjs --apply` + `update.mjs --apply` both run clean after fixing 3 real bugs hit along the way (double-`idOf` unwrap, `tool_ids` vs. resolved `tools` on GET, missing `.data` envelope on `/ai/mcp_servers/{id}` — see docs/LEARNINGS.md). Live-verified: Scheduling has `n_waitlist_join`/`e_book_waitlist`, the `update_dynamic_variables` tool attached, and the MCP server's `allowed_tools` has all 4 tools (confirmed by `test:probe`'s "lists exactly the four tools" assertion) |
| `assistants/` tests | 56 offline; live suite trimmed to 1 LLM-based E2E booking test + no-LLM backend suite; probe suite (free, no inference) passing against the newly-deployed state |
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
- [ ] **Right before dialing, warm the webhook:** `node scripts/warm-webhook.mjs` (needs `WEBHOOK_TOKEN`). The measured latency is the
      KV round-trip itself, not container cold-start (back-to-back runs: 3080ms, then 2518ms — barely moves), so this mostly just
      moves that ~2.5-3s hit to before the call instead of eating it live. Hitting `/health` instead would NOT help: that handler
      never touches KV.

## Not built (decide: build or explain)

- ~~`attempt_count >= 3 -> waitlist` edge (needs a counter variable); a persisted waitlist~~ **Built (this batch).**
  See the "Upgrades" item 3 below for the mechanism and the honest trade-off it took to ship it.
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
- [ ] **3. `attempt_count >= 3` waitlist edge + a real waitlist.** **Built (this batch, pending review/apply). A
      true variable-comparison edge (mirrors `durationOver`) is on `n_book -> n_waitlist`; the counter is
      computed server-side (per-caller-per-date KV, incremented on each `slot_already_booked`); `join_waitlist`
      MCP tool persists `waitlist/{date}/{phone10}` so the waitlist message is now truthful; the
      `update_dynamic_variables` shared tool (built-in Telnyx type, the only platform-supplied mid-call variable
      write — see docs/LEARNINGS.md) lets the model mirror the count into the conversation variable the edge
      reads. Honest trade-off, recorded in LEARNINGS.md: the count is server-authoritative, the edge decision
      is LLM-gated (the model must call `update_attempt_count`); the safe-failure direction is more retries, not
      a wrong waitlist. Pending before the assistant goes live: `node assistants/setup.mjs --apply` (creates
      the new `update_dynamic_variables` shared tool), then `node assistants/update.mjs --apply` (pushes the new
      edge / `tool_ids` / 4-tool MCP allowlist / reworded waitlist message to live Scheduling). 137/137 MCP +
      54/54 flow + 44/44 webhook + 31/31 actor tests pass locally; dry-run of `update.mjs` reports it would
      update each assistant. Live tests updated for the 4-tool allowlist + a waitlist end-to-end assertion.**
      *Originally:* Small `join_waitlist(date, service, patientName, patientPhone)` MCP tool writing
      `waitlist/{date}/...` to KV; the waitlist message can then truthfully say the request was noted. Adds the
      second variable-comparison edge from `docs/REQUIREMENTS.md`. Needs a counter variable (e.g. count
      `slot_already_booked` results via the webhook or an `update_dynamic_variables` tool). Update the
      assistant flow test, the prompt-variable lint and the live suite.
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
- [x] **Model comparison note**: written up in README.md, "Model comparison and dogfooding notes" —
      GLM-5.2 → Kimi-K2.6 → GLM-5.2 again, with the actual reasons for each switch (autonomy/confirmation
      friction, scope-creep/token burn, code quality, context-window/session-restart behavior), not just
      a generic "both were good" summary.
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

**Booking-confirmation SMS does not actually reach a phone** on this account: the clinic's longcode number has no 10DLC
campaign registered (`GET /v2/10dlc/brand` → zero records), so US carriers silently filter the A2P traffic one hop past
Telnyx's API, which still reports `sent: true`. The code path, fire-and-forget behavior, and error handling are implemented
and fully tested (142/142, including the SMS cases); only live carrier delivery is blocked, and fixing that means
registering a 10DLC brand/campaign (business verification, carrier review takes hours-to-days) — outside a challenge
timeline. Detail in `docs/LEARNINGS.md`.

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

**First `update.mjs --apply` attempt failed outright** — Telnyx's API rejected `e_billing_faq` with error
10015: `type: 'default'` edges are only valid on tool/speak nodes, and all 6 of the new fallback edges
(the 5 above + one more from a codegen loop) were `default` edges attached to **prompt** nodes. A second,
related constraint was found the same way: Telnyx also rejects self-looping edges
(`start_node_id === target`), which `e_faq_unclear`'s original loop-to-itself design hit too.

**Fixed** by converting all 6 to `llm(...)` catch-all conditions, and adding a shared `n_clarify` speak
node that Front Desk's three prompt-node fallbacks (`n_intent`, `n_intent_returning`, `n_faq`) route to —
a speak node can legally carry the `default` edge back to `n_intent`, sidestepping both constraints.
Scheduling's own fallbacks (`n_book`, `n_manage`) stay local (retry within Scheduling) rather than
bouncing to `n_clarify`, which is the right call since the caller hasn't left that sub-flow.

**Verified, not just claimed** (after the `40cbcf7` incident where a similar checklist turned out to be
aspirational — see the code-review log above): 51/51 offline tests pass, AND the live API was queried
directly for all 3 assistants to confirm zero `default` edges on non-speak/tool nodes and zero self-loops
exist on the deployed flows, not just locally.

- [x] Add `e_intent_unclear` → `n_clarify` (Front Desk) — **live-verified structurally**; still needs an
      actual ambiguous-caller phone call to confirm the LLM condition fires naturally
- [x] Add `e_faq_unclear` → `n_clarify` (Front Desk) — same: structurally live, needs a real off-script
      follow-up call to verify
- [x] Add `e_book_unclear` → `n_offer` (Scheduling) — structurally live, needs a real tool-error scenario
      to verify (hard to trigger deliberately without faking a tool failure)
- [x] Add `e_manage_unclear` → `n_collect` (Scheduling) — structurally live, needs a real changed-topic
      call to verify
- [x] Add `e_billing_faq` → Front Desk handoff (Billing) — structurally live, needs a real
      general-question-during-billing call to verify

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
