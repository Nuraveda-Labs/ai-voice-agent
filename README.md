# AI Voice Agent

[![License: MIT](https://img.shields.io/badge/license-MIT-black.svg)](LICENSE)
[![Part of Mesh Pilot](https://img.shields.io/badge/Mesh%20Pilot-stack-black.svg)](https://meshpilot.app)
[![Mirrored on Codeberg](https://img.shields.io/badge/codeberg-mirror-black.svg)](https://codeberg.org/Glitch_Exec_Lab/ai-voice-agent)

> **Part of the [Mesh Pilot](https://meshpilot.app) open-source 6-agent marketing stack.**
> LiveKit-based voice AI agent for outbound + inbound phone conversations — built originally for COD (cash-on-delivery) order-confirmation calls in India, but the architecture is generic.

Receives platform webhooks (Shopify orders, custom triggers), places outbound calls via SIP, runs a low-latency voice loop with pluggable LLM backends, and persists every call + turn for analytics, replay, and operator review.

## Quick start

```bash
git clone https://gitlab.com/mesh-pilot/ai-voice-agent.git
# or: git clone https://codeberg.org/Glitch_Exec_Lab/ai-voice-agent.git
cd ai-voice-agent

pnpm install
cp .env.example .env         # LiveKit + Shopify + SIP/Twilio + LLM provider keys
pnpm prisma migrate deploy

node src/server.js                       # HTTP webhook receiver
node src/livekit-agent.js start          # LiveKit agent worker
```

## What it does

- **Receive Shopify order webhooks** — when a new COD order lands, enqueue an outbound call task.
- **Place outbound calls via SIP/Twilio trunk** — LiveKit dispatches per-call jobs.
- **Run a voice loop with Sarvam / OpenAI Realtime / Bolna / Retell** — multiple LLM-voice backends supported, pluggable.
- **Tracks state in Postgres via Prisma** — every call attempt + turn is persisted for analytics + replay.
- **Outbound + inbound** — same agent code can answer inbound numbers.
- **Indian-language native** — Sarvam STT covers Hindi, Punjabi, Tamil, Telugu, Bengali, Marathi, Gujarati and code-switching, where generic STT degrades.

## The HITL pattern (shared across the stack)

Call scripts, follow-up actions, and any outbound campaigns route through the operator's approval queue before a single number is dialled. The agent surfaces calls for review (transcripts, outcomes, do-not-call additions) rather than running fully autonomously. In the [Mesh Pilot](https://meshpilot.app) cockpit, the voice surface lives alongside ads / sales / social in one inbox.

## Layout

```
src/
  livekit-agent.js                # LiveKit agent main loop (one job per call)
  trigger-livekit-call.js         # webhook handler that enqueues outbound calls
  create-sip-trunk.mjs / create-twilio-trunk.mjs   # SIP setup helpers
  register-shopify-webhooks.mjs   # one-shot Shopify webhook registration
  setup-bolna-agent.mjs / setup-retell-agent.mjs   # vendor-specific config
  server.js                       # Express HTTP server (webhook receiver)
prisma/                           # Prisma schema + migrations
systemd/                          # systemd unit templates
```

## Companions in the stack

| Agent | Domain | Repo |
|---|---|---|
| AI Ads Agent | Meta / Google / TikTok / Amazon Ads | [mesh-pilot/ai-ads-agent](https://gitlab.com/mesh-pilot/ai-ads-agent) |
| AI Sales Agent | Outbound B2B sales | [mesh-pilot/ai-sales-agent](https://gitlab.com/mesh-pilot/ai-sales-agent) |
| AI Social Agent | Multi-platform posting + ORM | [mesh-pilot/ai-social-agent](https://gitlab.com/mesh-pilot/ai-social-agent) |
| AI UGC Agent | Vertical video ad pipeline | [mesh-pilot/ai-ugc-agent](https://gitlab.com/mesh-pilot/ai-ugc-agent) |
| **AI Voice Agent** | This repo | — |
| AI SEO Agent | Shopify SEO autopilot | [mesh-pilot/ai-seo-agent](https://gitlab.com/mesh-pilot/ai-seo-agent) |

In production they're orchestrated by **[Mesh Pilot](https://meshpilot.app)** — the closed-source cockpit that runs all six in concert with shared brand context, a single web approval inbox, and cross-agent handoffs.

## Mirrors

- GitLab: [`mesh-pilot/ai-voice-agent`](https://gitlab.com/mesh-pilot/ai-voice-agent)
- Codeberg: [`Glitch_Exec_Lab/ai-voice-agent`](https://codeberg.org/Glitch_Exec_Lab/ai-voice-agent)

## Contributing

Bug reports + PRs welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for the contribution shape (issue-first for non-trivial changes, preserve the HITL gate, conventional commits).

## Security

Security reports go to `support@meshpilot.app` — see [SECURITY.md](SECURITY.md). Please do not open public issues for vulnerabilities.

## Code of conduct

Be kind, stay on scope — see [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).

## License

[MIT](LICENSE) — fork it, ship products with it, no attribution required.

---

Built by [Mesh Pilot](https://meshpilot.app).
