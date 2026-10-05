# Setting up Telnyx Edge Compute

Source: [`team-telnyx/edge-compute`](https://github.com/team-telnyx/edge-compute) README
and [`team-telnyx/ai`](https://github.com/team-telnyx/ai) `guides/edge-compute.md`.
Covers challenge requirement 4 (Edge Functions, KV, Stateful Actors).

## Two repos, two jobs

- **`team-telnyx/edge-compute`** — the actual product: `telnyx-edge` CLI + source
  examples (`examples/ts`, `examples/js`, `examples/go`, `examples/python`). This is
  where `ship`, `inspect`, `actors`, `secrets`, `bindings`, `storage kv`, etc. live.
- **`team-telnyx/ai`** — orchestration/agent-workflow layer on top (`telnyx-agent
  setup-edge-mcp`, `setup-edge-webhook`, `edge-doctor`). Optional convenience, not
  required — we can drive `telnyx-edge` directly.

We'll use `telnyx-edge` directly rather than the `telnyx-agent` wrappers, since we want
to actually understand each step for the demo-day walkthrough.

## Install & authenticate

```bash
VERSION=$(curl -s https://api.github.com/repos/team-telnyx/edge-compute/releases/latest | grep '"tag_name"' | cut -d'"' -f4)
curl -sSL https://github.com/team-telnyx/edge-compute/releases/download/$VERSION/telnyx-edge-$VERSION-linux-amd64.tar.gz | tar -xzf -
sudo mv telnyx-edge-$VERSION-linux-amd64/telnyx-edge /usr/local/bin/telnyx-edge
chmod +x /usr/local/bin/telnyx-edge

telnyx-edge --version

# Non-interactive auth (avoid literal key in shell history)
export TELNYX_API_KEY='***'
telnyx-edge auth api-key set "$TELNYX_API_KEY"

telnyx-edge auth status
telnyx-edge status   # full readiness check: config + credentials + API connectivity
```

> We're on Windows; the release page has the right archive for the dev machine (WSL or
> a Linux CI runner is the safe bet if the native Windows build is missing — confirm
> against the [releases page](https://github.com/team-telnyx/edge-compute/releases)
> before assuming).

Function names: 1–64 chars, alphanumeric + dashes, no leading/trailing dash.

## Plan: what we're deploying

| Piece | CLI approach |
|---|---|
| Dynamic webhook (Edge Function) | `new-func --language=ts` — scaffold, don't clone an example verbatim, since it's mostly custom logic (caller lookup, KV cache, calls into the Actor) |
| MCP server | `new-func --from-dir` off `examples/ts/mcp-server` — closest match to "custom MCP server," then adapt the scheduling tools in (ended up as 4: check_availability, book_appointment, cancel_or_reschedule_appointment, join_waitlist) |
| `DaySlotActor` | `new-func --actor --language=ts` |
| KV namespace | `storage kv create` |

## 1. Webhook Edge Function

```bash
telnyx-edge new-func --language=ts --name=receptionist-webhook
cd receptionist-webhook
# implement caller lookup, dynamic variables response, KV cache reads,
# and the call into DaySlotActor
telnyx-edge secrets add WEBHOOK_SECRET "$(openssl rand -hex 32)"   # if we sign inbound calls
telnyx-edge ship
telnyx-edge inspect receptionist-webhook
```

`inspect` gives the invoke URL and lists every declared binding (KV, actor, secrets) —
that's what goes in the assistant's Dynamic Webhook Variables config and in the README's
"live URLs" section.

## 2. MCP server

```bash
EDGE_COMPUTE_SRC="$(mktemp -d)/edge-compute"
git clone --depth 1 https://github.com/team-telnyx/edge-compute.git "$EDGE_COMPUTE_SRC"
telnyx-edge new-func \
  --from-dir="$EDGE_COMPUTE_SRC/examples/ts/mcp-server" \
  --name=receptionist-mcp
cd receptionist-mcp
npm install
# replace/extend the example's tools with:
#   check_availability, book_appointment, cancel_or_reschedule_appointment
npm run build
telnyx-edge secrets add TELNYX_API_KEY "$TELNYX_API_KEY"     # upstream Telnyx API calls, if any
telnyx-edge secrets add SHARED_SECRET "$(openssl rand -hex 32)"  # inbound bearer auth — do NOT reuse the Telnyx key
telnyx-edge ship
telnyx-edge inspect receptionist-mcp
```

Note from upstream docs: the MCP example needs a `package-lock.json`/`npm-shrinkwrap.json`
present before `ship` — `npm install` creates it.

Configure the assistant/any MCP client with the inspected URL + shared secret (not the
Telnyx API key) as the bearer token.

## 3. `DaySlotActor` (Stateful Actor)

```bash
telnyx-edge new-func --actor --language=ts --name=day-slot-actor
cd day-slot-actor
# implement holdSlot / confirmSlot / releaseSlot / onAlarm per docs/ARCHITECTURE.md
telnyx-edge ship
telnyx-edge actors list
telnyx-edge actors inspect day-slot-actor
```

The webhook function and the (future) reminder function both bind this actor type —
that's the "shared actors" stretch goal. Declare the `[[actors]]` binding block in each
consuming function's `func.toml`; `ship` warns if code references an undeclared actor
binding.

## 4. KV namespace

```bash
telnyx-edge storage kv create --name receptionist-cache
telnyx-edge storage kv list   # copy the namespace UUID
```

Declare in the webhook function's `telnyx.toml`:

```toml
[storage.kv.CACHE]
id = "<namespace-uuid>"
```

Then regenerate types:

```bash
npm install @telnyx/edge-runtime@latest
telnyx-edge types
```

This generates `telnyx-env.d.ts` typing `env.CACHE` as `KvNamespace`. Used for:
- `avail/{service}/{date}` — cached availability lookups (short TTL)
- `flag/waitlist_mode` — feature flag read by the variable-comparison
  edge

## Observability commands (challenge requirement 5)

```bash
telnyx-edge metrics receptionist-webhook --since 24h
telnyx-edge metrics receptionist-webhook --errors --json
telnyx-edge logs receptionist-webhook --type invocations --since 10m --last 200
telnyx-edge logs receptionist-webhook --type runtime --tail   # live tail during demo
telnyx-edge deployments receptionist-webhook --json
```

`logs --type invocations` = one record per HTTP request (traffic visibility even with no
app output). `logs --type runtime` = our structured JSON logs (request_id, caller, node,
outcome). `metrics` gives the "signal beyond logs" (latency/error-rate) requirement.
`--tail` streams live during the demo-day walkthrough.

## Debugging failed deploys

```bash
telnyx-edge ship status <function> --logs
telnyx-edge reset-func <function> --yes
telnyx-edge ship --from-dir=./<function>
```

## Rollback

Every successful ship is an immutable revision:

```bash
telnyx-edge revisions list <function>
telnyx-edge rollback <function> <revision-id>
```

## Open items to confirm once we start building

- [ ] Exact Windows dev setup for `telnyx-edge` (native binary vs. WSL) — check releases
      page
- [x] Whether the MCP server needs `TELNYX_API_KEY` at all: no. None of the four scheduling
      tools (check_availability, book_appointment, cancel_or_reschedule_appointment,
      join_waitlist) call the Telnyx API directly; the calendar is mocked.
- [ ] Actor alarm API specifics — confirm against the Stateful Actors docs once scaffolded
      (`telnyx-edge new-func --actor --help`, and the generated actor's boilerplate)
