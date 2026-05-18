/**
 * Glitch Voice — engine server.
 *
 * Engine-level endpoints (profile-agnostic):
 *   GET  /health
 *   POST /webhook/livekit/room-event          — LiveKit lifecycle events
 *   POST /webhook/livekit/egress-ready        — recording egress → CallAttempt.audioUri
 *   POST /webhook/livekit/turn                — per-utterance transcript capture
 *   POST /webhook/vobiz/call-event            — SIP-level disposition visibility
 *
 * Profile-mounted endpoints (delegated to profiles/ai-voice-agent/index.js):
 *   POST /webhook/shopify/orders-create       — enqueues a ScheduledCall
 *   POST /webhook/livekit/tool/{confirm_order,cancel_order,
 *                               request_human_agent,request_callback}
 *   GET  /flow-test-livekit                   — dev: trigger a real call by order name
 *
 * Queue: Postgres (ScheduledCall model). In-process scheduler in
 * src/lib/scheduler.js polls every 30s and dispatches via triggerLivekitCall.
 *
 * Profile loading is hard-coded to ai-voice-agent for now; phase 2 introduces
 * the registry that auto-discovers profiles/<id>/profile.json at boot.
 */

import express from 'express';
import crypto from 'node:crypto';
import pkg from '@prisma/client';
import { WebhookReceiver } from 'livekit-server-sdk';
import { triggerLivekitCall } from './trigger-livekit-call.js';
import { normalizePhone } from './lib/phone.js';
import { computeScheduledAt, isDnd } from './lib/dnd.js';
import { isShopAllowed, ALLOWED_SHOPS, ALLOWLIST_ACTIVE, getShopBranding } from './lib/shops.js';
import { startScheduler, markScheduledCallOutcome, DISPATCH_MODE } from './lib/scheduler.js';
import { getProfile, listProfiles, getRegistry } from './lib/profiles.js';
import { createToolAuth } from './lib/tool-auth.js';
import { pathToFileURL } from 'node:url';
import { existsSync } from 'node:fs';
import { join as joinPath } from 'node:path';
// Engine no longer imports any profile by name. Per-profile post-failure
// housekeeping (e.g. ai-voice-agent tagging the Shopify order 'cod-no-answer')
// happens via the optional `onNoAnswer` hook each profile may export from
// its index.js — see resolveProfileModule + onFinalFail below.

const { PrismaClient } = pkg;

const app = express();
const prisma = new PrismaClient();

const PORT = Number(process.env.PORT || 3104);
const LIVEKIT_TOOL_SECRET = process.env.LIVEKIT_TOOL_SECRET || '';
const CALL_DELAY_MS = Number(process.env.CALL_DELAY_MS ?? 10 * 60_000); // 10 min default

// LiveKit Cloud signs webhook bodies with the project API secret. We verify
// with WebhookReceiver using the SAME API key/secret the agent worker uses.
const LIVEKIT_API_KEY    = process.env.LIVEKIT_API_KEY    || '';
const LIVEKIT_API_SECRET = process.env.LIVEKIT_API_SECRET || '';
const livekitWebhookReceiver = (LIVEKIT_API_KEY && LIVEKIT_API_SECRET)
  ? new WebhookReceiver(LIVEKIT_API_KEY, LIVEKIT_API_SECRET)
  : null;

// Reject counters surfaced on /health. Mutated by profile-owned middleware too.
const rejectCount = { hmac_missing: 0, hmac_mismatch: 0, shop_blocked: 0, tool_auth_missing: 0, tool_auth_mismatch: 0 };

// ─── Profile mount ────────────────────────────────────────────────────
// Must run BEFORE the global express.json — the Shopify webhook (ai-voice-agent)
// needs raw body for HMAC verification, and a prior json parser would consume
// the stream. Each profile attaches its own body parsers at the path scope
// it owns; the engine just iterates the registry and calls mount() on every
// profile that exports one.
const requireToolAuth = createToolAuth(process.env, rejectCount);

const sharedDeps = {
  prisma,
  env: process.env,
  rejectCount,
  CALL_DELAY_MS,
  computeScheduledAt,
  isDnd,
  isShopAllowed,
  normalizePhone,
  getShopBranding,
  triggerLivekitCall,
  markScheduledCallOutcome,
  requireToolAuth,
};

// Auto-mount every profile in the registry that ships an index.js with a
// `mount` export. Order is registry-iteration order (insertion order of
// readdirSync) — deterministic enough for HTTP route precedence; if two
// profiles ever try to register the same path, the first one wins (Express
// behavior) and the second is dead. That's a profile-authoring bug, not an
// engine concern.
const profileMounts = [];
for (const [id, profile] of getRegistry()) {
  const indexPath = joinPath(profile._dir, 'index.js');
  if (!existsSync(indexPath)) {
    console.log(`[profile-mount] ${id}: no index.js (agent-only profile) — skipping HTTP mount`);
    continue;
  }
  try {
    const mod = await import(pathToFileURL(indexPath).href);
    if (typeof mod.mount !== 'function') {
      console.warn(`[profile-mount] ${id}: index.js exports no mount() — skipping`);
      continue;
    }
    mod.mount(app, sharedDeps);
    profileMounts.push(id);
    console.log(`[profile-mount] mounted ${id}`);
  } catch (err) {
    console.error(`[profile-mount] ${id}: mount failed —`, err.message);
  }
}

// Parse JSON for everything else, AND stash the raw Buffer so LiveKit
// webhook signature verification works without needing a second parser.
// LiveKit Cloud sends webhooks with Content-Type `application/webhook+json`
// (not plain application/json), so we explicitly match both.
app.use(express.json({
  type: ['application/json', 'application/webhook+json'],
  verify: (req, _res, buf) => { req.rawBody = buf; },
}));

// ─── Health ───────────────────────────────────────────────────────────
app.get('/health', async (_req, res) => {
  const [sessions, queued, dispatching, doneToday, failedToday] = await Promise.all([
    prisma.session.count(),
    prisma.scheduledCall.count({ where: { status: 'queued' } }),
    prisma.scheduledCall.count({ where: { status: 'dispatching' } }),
    prisma.scheduledCall.count({ where: { status: 'done', updatedAt: { gte: new Date(Date.now() - 24*60*60*1000) } } }),
    prisma.scheduledCall.count({ where: { status: 'failed', updatedAt: { gte: new Date(Date.now() - 24*60*60*1000) } } }),
  ]);
  // Re-derive Shopify HMAC config status for visibility. Source of truth
  // lives inside the profile; this is best-effort for the health probe.
  let shopifyHmacPerShopCount = 0;
  try { shopifyHmacPerShopCount = Object.keys(JSON.parse(process.env.SHOPIFY_WEBHOOK_SECRETS || '{}')).length; } catch {}
  const shopifyHmacFallback = Boolean(process.env.SHOPIFY_WEBHOOK_SECRET);
  res.json({
    ok: true,
    service: 'glitch-voice',
    port: PORT,
    dispatch_mode: DISPATCH_MODE,
    live: DISPATCH_MODE === 'live',
    livekit_agent_configured: Boolean(
      process.env.LIVEKIT_URL &&
      process.env.LIVEKIT_API_KEY &&
      process.env.LIVEKIT_API_SECRET &&
      process.env.LIVEKIT_SIP_TRUNK_ID,
    ),
    shopify_hmac_configured: shopifyHmacFallback || shopifyHmacPerShopCount > 0,
    shopify_hmac_per_shop_count: shopifyHmacPerShopCount,
    shopify_hmac_fallback_configured: shopifyHmacFallback,
    livekit_tool_auth_configured: Boolean(LIVEKIT_TOOL_SECRET),
    allowed_shops: ALLOWLIST_ACTIVE ? ALLOWED_SHOPS : 'open',
    shopify_sessions: sessions,
    queue: { queued, dispatching, doneToday, failedToday },
    rejects: rejectCount,
    in_dnd_now: isDnd(new Date()),
  });
});

// ─── Profile registry visibility ─────────────────────────────────────
app.get('/profiles', (_req, res) => {
  res.json({ ok: true, profiles: listProfiles() });
});

// ─── Generic dispatch endpoint ───────────────────────────────────────
// Profile-agnostic way to enqueue a ScheduledCall. Replaces the pattern of
// "every new use case adds its own /webhook/<thing> trigger" with one entry
// point. Profile-specific triggers (Shopify webhook, calendar webhook, ...)
// still exist for incoming sources we don't control; this endpoint is for
// sources we DO control (internal services, CSV uploaders, dashboards).
//
// Body: { profile, phone, lang?, payload?, scheduledAt?, idempotencyKey? }
//   profile         — id from profiles/<id>/profile.json
//   phone           — any shape normalizePhone accepts
//   lang            — defaults to profile.defaultLanguage
//   payload         — profile-specific context (ai-voice-agent: customer_name,
//                     total_amount, product_name, delivery_city, delivery_area;
//                     other profiles define their own shape)
//   scheduledAt     — ISO 8601; defaults to now + CALL_DELAY_MS, DND-rolled
//   idempotencyKey  — optional string; uniqueness is enforced via
//                     (shop='_dispatch_api', orderId=idempotencyKey) so
//                     callers can safely retry. Without one, every POST
//                     creates a new row.
//
// Auth: shared LIVEKIT_TOOL_SECRET via X-COD-Tool-Secret. The endpoint
// initiates real PSTN calls, so it fails closed.
app.post('/calls/dispatch', requireToolAuth, async (req, res) => {
  const b = req.body || {};
  const profileId = b.profile;
  if (!profileId) return res.status(400).json({ ok: false, error: 'missing profile' });
  const profile = getProfile(profileId);
  if (!profile) return res.status(404).json({ ok: false, error: `unknown profile: ${profileId}` });

  const phone = normalizePhone(b.phone);
  if (!phone) return res.status(400).json({ ok: false, error: `invalid phone: ${b.phone}` });

  const lang = b.lang || profile.defaultLanguage || 'hi-IN';
  if (profile.languages && !profile.languages.includes(lang)) {
    return res.status(400).json({ ok: false, error: `profile ${profileId} does not support lang=${lang}` });
  }

  const scheduledAt = b.scheduledAt
    ? new Date(b.scheduledAt)
    : computeScheduledAt(new Date(), CALL_DELAY_MS);
  if (Number.isNaN(scheduledAt.getTime())) {
    return res.status(400).json({ ok: false, error: 'invalid scheduledAt' });
  }

  // The schema still has shop+orderId as the natural key for backwards
  // compatibility with ai-voice-agent. For generic dispatches we synthesize a
  // sentinel shop and use the idempotencyKey (or a cuid) as orderId. Phase 3
  // will replace this with a profile-aware entityRef column.
  const shop = b.shop || '_dispatch_api';
  const orderId = b.idempotencyKey || `dispatch_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
  const orderName = b.orderName || `${profileId}:${orderId}`;

  try {
    const row = await prisma.scheduledCall.upsert({
      where:  { shop_orderId: { shop, orderId } },
      update: {},
      create: {
        profile: profileId,
        shop, orderId, orderName, phone,
        lang,
        payload: b.payload || {},
        scheduledAt,
        status: 'queued',
      },
    });
    const delaySec = Math.round((scheduledAt.getTime() - Date.now()) / 1000);
    console.log(`[dispatch] queued profile=${profileId} ${orderName} → ${scheduledAt.toISOString()} (+${delaySec}s)`);
    res.json({
      ok: true,
      id: row.id,
      profile: profileId,
      scheduledAt: scheduledAt.toISOString(),
      orderId,
      orderName,
      reused: row.createdAt.getTime() < Date.now() - 1000, // upsert with empty update means existing row returned
    });
  } catch (err) {
    console.error('[dispatch] error:', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─── Training-data moat: per-turn transcript capture ────────────────
// The LiveKit agent worker posts one row per utterance as the call unfolds.
// Persisting mid-call (rather than one bulk dump at session Close) means a
// worker crash or an unclean hangup doesn't lose the first half of the
// conversation. Auth: reuses the profile's tool-secret middleware.
//
// Currently hard-coded to the ai-voice-agent row shape (shop + shopify_order_id).
// Phase 2 will generalize this to use a profile-agnostic { profileId,
// entityRef } key so other profiles can capture transcripts too.
app.post('/webhook/livekit/turn', requireToolAuth, async (req, res) => {
  const b = req.body || {};
  if (!b.shop || !b.shopify_order_id || !b.room_name || b.turn_index == null || !b.role || typeof b.text !== 'string') {
    return res.status(400).json({ ok: false, error: 'missing shop/shopify_order_id/room_name/turn_index/role/text' });
  }
  if (!['user', 'assistant', 'tool'].includes(b.role)) {
    return res.status(400).json({ ok: false, error: `invalid role: ${b.role}` });
  }
  try {
    await prisma.callTurn.upsert({
      where: { roomName_turnIndex: { roomName: b.room_name, turnIndex: b.turn_index } },
      update: {}, // first write wins; a retry is a no-op
      create: {
        shop:          b.shop,
        orderId:       String(b.shopify_order_id),
        roomName:      b.room_name,
        sipCallId:     b.sip_call_id || null,
        turnIndex:     b.turn_index,
        role:          b.role,
        text:          b.text,
        toolName:      b.tool_name || null,
        toolArgs:      b.tool_args || undefined,
        toolResult:    b.tool_result || null,
        lang:          b.lang || null,
        sttConfidence: typeof b.stt_confidence === 'number' ? b.stt_confidence : null,
        startedAt:     b.started_at ? new Date(b.started_at) : new Date(),
      },
    });
    await prisma.callAttempt.updateMany({
      where: { roomName: b.room_name },
      data:  { turnCount: { increment: 1 } },
    });
    res.json({ ok: true });
  } catch (err) {
    console.error('[livekit-turn] error:', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// LiveKit Cloud webhook — egress + room/participant events. LiveKit signs
// the body with the project API secret; manual-replay path falls back to
// the shared tool secret.
app.post('/webhook/livekit/egress-ready', async (req, res) => {
  try {
    let event = null;

    const authHeader = req.get('Authorization') || '';
    if (authHeader && livekitWebhookReceiver) {
      if (!req.rawBody) {
        return res.status(400).json({ ok: false, error: 'raw body required for LiveKit signature verification' });
      }
      try {
        event = await livekitWebhookReceiver.receive(req.rawBody.toString('utf8'), authHeader);
      } catch (err) {
        console.warn('[livekit-webhook] signature verification failed:', err.message);
        return res.status(401).json({ ok: false, error: 'invalid LiveKit webhook signature' });
      }
    } else if (req.get('X-COD-Tool-Secret')) {
      const got = req.get('X-COD-Tool-Secret');
      if (!LIVEKIT_TOOL_SECRET) {
        return res.status(503).json({ ok: false, error: 'tool auth not configured' });
      }
      const a = Buffer.from(got);
      const b = Buffer.from(LIVEKIT_TOOL_SECRET);
      if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
        return res.status(401).json({ ok: false, error: 'invalid X-COD-Tool-Secret' });
      }
      event = req.body; // trust the payload shape from a manual replay
    } else {
      return res.status(401).json({ ok: false, error: 'missing Authorization or X-COD-Tool-Secret' });
    }

    const eventType = event?.event || '(unknown)';
    console.log(`[livekit-webhook] event=${eventType} id=${event?.id || '-'}`);

    if (eventType !== 'egress_ended') {
      return res.json({ ok: true, event: eventType, ignored: true });
    }

    const eg = event.egressInfo || event.egress_info || {};
    const roomName = eg.roomName || eg.room_name;
    const file = (eg.fileResults && eg.fileResults[0]) || (eg.file_results && eg.file_results[0]) || null;
    if (!roomName) {
      return res.status(400).json({ ok: false, error: 'egressInfo.roomName missing' });
    }

    let durationMs = null;
    if (file?.duration) {
      const ns = typeof file.duration === 'bigint' ? Number(file.duration) : Number(file.duration);
      if (Number.isFinite(ns)) durationMs = Math.round(ns / 1_000_000);
    }

    let audioFormat = null;
    const filename = file?.filename || '';
    const m = /\.([a-zA-Z0-9]+)$/.exec(filename);
    if (m) audioFormat = m[1].toLowerCase();

    const audioUri = file?.location || filename || null;

    const updated = await prisma.callAttempt.updateMany({
      where: { roomName },
      data: {
        audioUri,
        audioFormat,
        audioDurationMs: durationMs,
        consentGiven:    (process.env.RECORDING_CONSENT_DISCLOSURE || 'on').toLowerCase() !== 'off',
      },
    });
    console.log(`[livekit-egress] room=${roomName} uri=${audioUri} dur=${durationMs}ms rows=${updated.count}`);
    res.json({ ok: true, event: eventType, rows_updated: updated.count });
  } catch (err) {
    console.error('[livekit-webhook] error:', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// LiveKit room-event webhook (optional — safety net for visibility)
app.post('/webhook/livekit/room-event', (req, res) => {
  const ev = req.body || {};
  console.log('[livekit-event]', ev.event, 'room:', ev.room?.name);
  res.json({ ok: true });
});

// Vobiz SIP-level events — post-mortem visibility. Call outcomes come from
// LiveKit tool calls, not from here.
app.post('/webhook/vobiz/call-event', async (req, res) => {
  const ev = req.body || {};
  console.log('[vobiz-event]', ev.event || ev.type || '?', 'sipCallId:', ev.sip_call_id || ev.sipCallId || '-', JSON.stringify(ev).slice(0, 400));
  res.json({ ok: true });
});

// ─── Startup ─────────────────────────────────────────────────────────
// Cache of imported profile index modules — looked up by id when we need to
// invoke the optional onNoAnswer hook on a permanently-failed ScheduledCall.
const profileModuleByIdForHooks = new Map();
async function resolveProfileModuleForHooks(id) {
  if (profileModuleByIdForHooks.has(id)) return profileModuleByIdForHooks.get(id);
  const profile = getProfile(id);
  if (!profile) return null;
  const indexPath = joinPath(profile._dir, 'index.js');
  if (!existsSync(indexPath)) {
    profileModuleByIdForHooks.set(id, null);
    return null;
  }
  try {
    const mod = await import(pathToFileURL(indexPath).href);
    profileModuleByIdForHooks.set(id, mod);
    return mod;
  } catch (err) {
    console.error(`[final-fail] could not import ${indexPath}:`, err.message);
    profileModuleByIdForHooks.set(id, null);
    return null;
  }
}

async function onFinalFail(row, reason) {
  const profileId = row.profile || 'ai-voice-agent';
  try {
    const mod = await resolveProfileModuleForHooks(profileId);
    if (mod && typeof mod.onNoAnswer === 'function') {
      await mod.onNoAnswer({ prisma, row, reason });
    } else {
      console.log(`[final-fail] profile=${profileId} row=${row.orderName} — no onNoAnswer hook (reason: ${reason})`);
    }
  } catch (err) {
    console.error(`[final-fail] hook failed for profile=${profileId} row=${row.orderName}:`, err.message);
  }
}

app.listen(PORT, '127.0.0.1', async () => {
  console.log(`[glitch-voice] listening on 127.0.0.1:${PORT}`);
  console.log(`[glitch-voice] DISPATCH MODE: ${DISPATCH_MODE === 'live' ? '🟢 LIVE — real customer calls will be placed' : '🔒 DRY-RUN — no real calls (set DISPATCH_MODE=live to enable)'}`);
  {
    let perShopCount = 0;
    try { perShopCount = Object.keys(JSON.parse(process.env.SHOPIFY_WEBHOOK_SECRETS || '{}')).length; } catch {}
    const fallback = Boolean(process.env.SHOPIFY_WEBHOOK_SECRET);
    let hmacStatus;
    if (perShopCount > 0 && fallback)   hmacStatus = `YES (per-shop=${perShopCount} + fallback)`;
    else if (perShopCount > 0)          hmacStatus = `YES (per-shop=${perShopCount})`;
    else if (fallback)                  hmacStatus = `YES (single fallback — legacy)`;
    else                                hmacStatus = `NO (OPEN — development only!)`;
    console.log(`[glitch-voice] HMAC configured: ${hmacStatus}`);
  }
  console.log(`[glitch-voice] LiveKit tool auth: ${Boolean(LIVEKIT_TOOL_SECRET) ? 'YES' : 'NO (tool webhooks will reject all requests)'}`);
  console.log(`[glitch-voice] shop allowlist: ${ALLOWLIST_ACTIVE ? ALLOWED_SHOPS.join(', ') : 'OPEN (all shops)'}`);
  console.log(`[glitch-voice] call delay: ${CALL_DELAY_MS}ms  |  DND now: ${isDnd(new Date())}`);

  const [queued, dispatching] = await Promise.all([
    prisma.scheduledCall.count({ where: { status: 'queued' } }),
    prisma.scheduledCall.count({ where: { status: 'dispatching' } }),
  ]);
  console.log(`[glitch-voice] queue depth on startup: queued=${queued}, dispatching=${dispatching}`);

  startScheduler(prisma, { onFinalFail });
});

// Graceful shutdown — disconnect Prisma so in-flight queries finish
process.on('SIGTERM', async () => {
  console.log('[glitch-voice] SIGTERM — shutting down');
  await prisma.$disconnect();
  process.exit(0);
});
