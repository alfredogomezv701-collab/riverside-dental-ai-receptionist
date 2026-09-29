# Riverside Dental — AI Receptionist (Telnyx FDE Challenge)

An AI voice receptionist for a dental clinic, built on Telnyx Voice AI (Conversation
Workflows), a custom MCP server, and Telnyx Edge Compute (Edge Functions, KV, Stateful
Actors). Built end-to-end using Telnyx Inference via the OpenCode plugin.

See [`docs/REQUIREMENTS.md`](docs/REQUIREMENTS.md) for the scope checklist,
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the system design, and
[`docs/OPENCODE_SETUP.md`](docs/OPENCODE_SETUP.md) /
[`docs/EDGE_COMPUTE_SETUP.md`](docs/EDGE_COMPUTE_SETUP.md) for how to stand up the
Telnyx-side tooling this project depends on.

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

1. Telnyx Inference coding model: [`docs/OPENCODE_SETUP.md`](docs/OPENCODE_SETUP.md)
2. Edge Compute CLI, Edge Function/KV/Actor deployment:
   [`docs/EDGE_COMPUTE_SETUP.md`](docs/EDGE_COMPUTE_SETUP.md)

Implementation (actual Edge Function/MCP server/actor code) has not started yet — these
docs are the setup reference for when it does.

## Observability / debugging story

TBD — filled in as instrumentation is added and once we've hit and diagnosed a real bug.
