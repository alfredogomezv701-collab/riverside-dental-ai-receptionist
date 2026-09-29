# Riverside Dental — AI Receptionist (Telnyx FDE Challenge)

An AI voice receptionist for a dental clinic, built on Telnyx Voice AI (Conversation
Workflows), a custom MCP server, and Telnyx Edge Compute (Edge Functions, KV, Stateful
Actors). Built end-to-end using Telnyx Inference via the OpenCode plugin.

See [`docs/REQUIREMENTS.md`](docs/REQUIREMENTS.md) for the scope checklist and
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the system design.

## Status

Planning stage — architecture and requirements documented, implementation not started.

## Repo layout (planned)

```
assistant/         # AI Assistant / conversation_flow config (Portal export or API payload)
edge-function/      # Telnyx Edge Function: dynamic webhook + KV + Actor bindings
mcp-server/         # Custom MCP server (tools for scheduling)
docs/                # Requirements, architecture, observability, decisions
opencode.jsonc       # OpenCode config with @telnyx/opencode plugin active
```

## Setup

TBD — filled in once the Edge Compute CLI and OpenCode/Telnyx plugin are wired up
(see `docs/OPENCODE_SETUP.md` once written).

## Observability / debugging story

TBD — filled in as instrumentation is added and once we've hit and diagnosed a real bug.
