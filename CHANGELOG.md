# Changelog

## [0.1.0] — 2026-05-18

### Added

- Initial open-source release of the AI voice agent engine.
- LiveKit agent main loop (job-per-call architecture).
- Outbound webhook → call enqueue pipeline (Shopify integration).
- SIP/Twilio trunk setup helpers.
- Multi-backend voice loop (Sarvam, OpenAI Realtime, Bolna, Retell).
- Prisma-managed Postgres schema for call attempts + turns.

### Removed (extracted to a separate proprietary repo)

- Voice profiles (per-language tuning).
- Fine-tuned conversation prompts and guardrails.
- Brand-specific call-flow configuration.
- Internal planning + handover documents (BACKLOG, MILESTONES, PLAN, BETA).
