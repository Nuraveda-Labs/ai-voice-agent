# Manual migrations

This repo was bootstrapped with `prisma db push` (no `prisma migrate`
history). When a schema change needs to land on an already-running DB
without losing data, we commit the generated SQL here and apply it
manually.

## Apply order

Run these in order against the target database:

1. `20260416210000_data_moat/migration.sql` — adds training-data columns
   on `CallAttempt` (`audioUri`, `audioFormat`, `audioDurationMs`,
   `audioSampleRate`, `consentGiven`, `turnCount`, `lang`) and creates
   the new `CallTurn` table with its indexes and unique constraint.
2. `20260510120000_profile_column/migration.sql` — adds the `profile` column
   to `ScheduledCall` and `CallAttempt` (default `'ai-voice-agent'` so existing
   rows stay valid) plus matching indexes on `(profile, status, scheduledAt)`
   and `(profile, createdAt)`. Lays the ground for multi-profile dispatch
   without changing current behaviour.

## Apply command

```bash
psql "$DATABASE_URL" -f prisma/migrations-manual/<dir>/migration.sql
```

## Post-apply

Regenerate the Prisma client so the app knows about the new tables:

```bash
pnpm exec prisma generate
sudo systemctl restart ai-voice-agent.service ai-voice-agent-agent.service
```
