# day-slot-actor

A Telnyx Edge **Stateful Actor** project (`telnyx.toml`, worker-style). Owns `DaySlotActor`, one
instance per clinic-day, which is the single-threaded read-modify-write authority for appointment
slot conflicts across the whole system. See `docs/ARCHITECTURE.md` at the repo root ("Stateful
Actors" and "Cross-function actor access") for why this exists as its own function.

## Layout

| File | Purpose |
| --- | --- |
| `telnyx.toml` | Declares the `DAY_SLOT` actor binding (mapped to the `DaySlotActor` class) and the function identity. |
| `src/index.ts` | Entry point. Re-exports `DaySlotActor` so it ships with the function, and exposes a `GET /actor/stats?date=...` HTTP route for metrics — everything else goes through the actor's own methods, not HTTP. |
| `src/day_slot_actor.ts` | The actor class: `holdSlot`, `confirmSlot`, `releaseSlot`, `getStats`, and the alarm that auto-releases a stale hold. |
| `test/` | Unit tests against the actor class and the HTTP entry point directly (no deploy needed). |

## Why this function has no direct public HTTP surface for booking

`receptionist-mcp` (the MCP server) and `receptionist-webhook` both need to call this actor's
methods, but only `receptionist-webhook` can hold the `DAY_SLOT` binding directly — `receptionist-mcp`
has to stay a classic (`func.toml`) Express project for the MCP SDK's transport, and actor bindings
only work in worker-style (`telnyx.toml`) projects like this one. So `receptionist-mcp` reaches
`DaySlotActor` over HTTP, through `receptionist-webhook`'s `/actor/hold` / `/actor/confirm` /
`/actor/release` proxy routes, not directly. Full write-up in `docs/ARCHITECTURE.md`.

## Deploy

```sh
npm install
telnyx-edge ship
```

(No separate bundle step needed here — unlike `receptionist-mcp`'s classic project, this worker-style
project is bundled client-side by the CLI itself.)

## Using the actor

```ts
const stub = env.DAY_SLOT.idFromName(date); // one instance per clinic-day
const result = await stub.holdSlot(start, callerId, durationMinutes);
```

`DAY_SLOT` is the binding declared under `[[actors]]` in `telnyx.toml`, mapping to the
`DaySlotActor` class in `src/day_slot_actor.ts`. Regenerate the `env.DAY_SLOT` types with
`telnyx-edge types` after changing the actor's method signatures.
