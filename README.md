# AI Voice Agent

Open-source LiveKit-based voice AI agent for outbound + inbound
phone conversations — built originally for COD (cash-on-delivery)
order-confirmation calls, but the architecture is generic.

## What it does

- **Receive Shopify order webhooks** — when a new COD order lands,
  enqueue an outbound call task.
- **Place outbound calls via SIP/Twilio trunk** — LiveKit dispatches
  per-call jobs.
- **Run a voice loop with Sarvam / OpenAI Realtime / Bolna / Retell** —
  multiple LLM-voice backends supported, pluggable.
- **Tracks state in Postgres via Prisma** — every call attempt + turn
  is persisted for analytics + replay.
- **Outbound + inbound** — same agent code can answer inbound numbers.

## Layout

```
src/
  livekit-agent.js     # LiveKit agent main loop (one job per call)
  trigger-livekit-call.js  # webhook handler that enqueues outbound calls
  create-sip-trunk.mjs / create-twilio-trunk.mjs  # SIP setup helpers
  register-shopify-webhooks.mjs  # one-shot Shopify webhook registration
  setup-bolna-agent.mjs / setup-retell-agent.mjs  # vendor-specific config
  server.js            # Express HTTP server (webhook receiver)
prisma/                # Prisma schema + migrations
systemd/               # systemd unit templates
```

## Install

```
pnpm install
cp .env.example .env   # LiveKit + Shopify + SIP/Twilio + LLM provider keys
pnpm prisma migrate deploy
node src/server.js     # start the HTTP webhook receiver
node src/livekit-agent.js start   # start the LiveKit agent worker
```

## License

MIT — see `LICENSE`.
