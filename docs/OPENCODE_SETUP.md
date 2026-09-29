# Setting up Telnyx Inference via OpenCode

Source: [`team-telnyx/ai`](https://github.com/team-telnyx/ai) `plugins/opencode/README.md`
(required for challenge item 6).

## Install

```bash
# Local to this repo (preferred — keeps the plugin pinned per-project)
opencode plugin @telnyx/opencode
```

This edits both `opencode.json` (server) and `tui.json` (TUI) automatically — commit
both once generated.

## Authenticate

```bash
opencode auth login --provider telnyx --method "API Key"
```

Paste the Telnyx API key (portal → API Keys; account funded with promo code
`TELNYXFDE2026`). Alternative non-interactive path:

```bash
export TELNYX_API_KEY="KEY_..."
```

Verify:

```bash
opencode auth list
```

## What the plugin actually does

- Registers `telnyx` as an OpenCode model provider (`@ai-sdk/openai-compatible` under
  the hood)
- Pulls the live model list from `https://api.telnyx.com/v2/ai/models` at startup
- Enables 5 recommended models by default (moonshotai/Kimi-K2.6, zai-org/GLM-5.2,
  zai-org/GLM-5.1-FP8, MiniMaxAI/MiniMax-M3-MXFP8, MiniMaxAI/MiniMax-M2.7) — full list is
  fluid, check `/telnyx` in the TUI for what's current
- Strips `maxOutputTokens` before requests, because Telnyx's API rejects requests that
  combine tool-calling with `max_completion_tokens`/`max_tokens` — without this the
  agentic (tool-using) coding flow would break
- Adds a `/telnyx` TUI command to toggle which hosted models are enabled
  (`~/.config/opencode/telnyx-models.json`)

## Run a model

```bash
opencode run --model 'telnyx/moonshotai/Kimi-K2.6' 'Say hello in one sentence.'
```

Reasoning-capable models get `thinking` (default) and `no-thinking` variants:

```bash
opencode run --model 'telnyx/zai-org/GLM-5.2' --variant no-thinking 'What is 2+2?'
```

## What we'll use it for

Per the challenge, this project's actual implementation work (Edge Function code, MCP
server code, workflow config) should be built using a Telnyx-hosted model through
OpenCode as the driving coding assistant — not just configured and left idle. Model
choice and rationale will be logged in `docs/DECISIONS.md` (or this file) as the build
progresses, along with anything notably good/bad about the dogfooding experience, since
demo day asks for that explicitly.

## Troubleshooting (from upstream README)

- `Unknown provider "telnyx"` → plugin not loaded; check `opencode.json`, restart
- No models listed → API key missing/invalid; `opencode auth list` or set
  `TELNYX_API_KEY`
- `/telnyx` command missing → needs a `tui.json` entry; reinstall via
  `opencode plugin @telnyx/opencode` or add manually:
  ```json
  { "$schema": "https://opencode.ai/tui.json", "plugin": ["@telnyx/opencode"] }
  ```
