# Requirements Checklist

Source: `code_challenge.md` (Telnyx FDE coding challenge). Split into **Required** (graded
as core deliverables) and **Nice to have** (stretch goals — bonus, not required).
Everything here, required or not, should be planned for up front so the architecture
doesn't need rework later; nice-to-haves are cut first if time runs short.

## Required

- [ ] **AI Assistant with Conversation Workflow**
  - [ ] Multiple nodes (not a single prompt)
  - [ ] At least one prompt node (LLM-driven step)
  - [ ] At least one speak node (verbatim scripted message)
  - [ ] Conditional edges: at least one LLM condition, at least one variable comparison
  - [ ] Callable via a real phone number
- [ ] **Custom MCP server**
  - [ ] At least 3 tools the workflow's nodes can call
  - [ ] Publicly accessible
- [ ] **Dynamic Webhook Variables**
  - [ ] Backed by the Edge Function webhook
  - [ ] Personalizes the conversation / influences routing
- [ ] **Telnyx Edge Compute deployment**
  - [ ] At least one Edge Function deployed via `telnyx-edge ship`, serving the dynamic
        webhook
  - [ ] KV used for at least one of: session state, cached responses, feature flags
  - [ ] At least one Stateful Actor managing per-entity state, using single-threaded
        read-modify-write for something that would otherwise need a lock
- [ ] **Observability**
  - [ ] Structured logs on the Edge Function (caller, node, outcome, per call)
  - [ ] At least one signal beyond logs (counter, latency measurement, or a request trace
        through Function → KV/Actor → MCP)
  - [ ] README section: how we'd know within a minute the assistant broke, and what we'd
        check first
  - [ ] A real "here's a bug we hit and how we found it" story, with evidence
- [ ] **Telnyx Inference via OpenCode plugin**
  - [ ] `@telnyx/opencode` installed, authenticated with Telnyx API key
  - [ ] Actually used as the coding model for building this project (not just configured)
- [ ] **Public deployment & docs**
  - [ ] Live Edge Function URL(s)
  - [ ] Working phone number
  - [ ] MCP server publicly reachable
  - [ ] README with setup + architecture + observability story
  - [ ] `opencode.jsonc`/`opencode.json` committed, showing the Telnyx plugin active

## Nice to have (stretch goals)

Priority order reflects fit for our use case (see `docs/ARCHITECTURE.md` for rationale —
some stretch goals are a natural fit for appointment scheduling, others are weak fits and
explicitly deprioritized).

- [ ] **Alarms in Stateful Actors** — hold-then-confirm slot booking; alarm auto-releases
      an unconfirmed hold. High priority: this is the one stretch goal that meaningfully
      deepens the required Actor requirement rather than adding a new surface.
- [ ] **Multi-assistant routing** — Front Desk → Scheduling Specialist / Billing
      Specialist, different persona/tools per assistant. High priority.
- [ ] **Shared actors** — a second function (reminder/no-show follow-up) reads the same
      `DaySlotActor`. Medium priority, falls out of the alarm work almost for free.
- [ ] **KV-based feature flags** — `waitlist_mode` flag reroutes workflow without
      redeploy. Medium priority, cheap to add.
- [ ] **Distributed tracing** — request ID threaded through Function → Actor/KV → MCP
      logs. Medium priority — folds into the required observability work anyway.
- [ ] **Variable comparison edges (extra)** — beyond the required one
      (`telnyx_conversation_duration_secs >= 300`), add `attempt_count >= 3` → waitlist.
      Low priority, cheap.
- [ ] **Object storage integration** — deprioritized. No natural artifact is produced by
      a voice-only booking flow; would be bolted on purely to check a box. Skip unless
      all required + high-priority stretch items are done early.
- [ ] **Custom dynamic variables webhook (advanced)** — largely covered by the required
      dynamic-variables work (returning-patient lookup). No separate task needed.

## Explicitly out of scope

- Real payment processing (not relevant to a dental scheduling use case)
- Object storage / media handling (see above)
- Anything requiring a second external vendor beyond Telnyx + a mock/lightweight
  calendar data source
