/**
 * Trigger an outbound voice call via LiveKit Cloud + Vobiz SIP trunk.
 *
 * Resolves a Shopify order to its real context, then asks LiveKit to:
 *   1. Create a fresh room (one per call)
 *   2. Originate a SIP call through our Vobiz trunk to the customer's number
 *   3. Dispatch our ai-voice-agent-priya agent into that room
 *
 * Per-call context (customer name, order number, total, product, address, shop,
 * shopify_order_id) is passed via participantAttributes — the agent reads them
 * via ctx.waitForParticipant().attributes inside src/livekit-agent.js.
 */

import { SipClient, AgentDispatchClient, EgressClient, EncodedFileType, EncodedFileOutput, EncodingOptions, AudioCodec, S3Upload, GCPUpload } from 'livekit-server-sdk';

import { pickTrunkForPhone } from './lib/trunks.js';

const LK_URL              = process.env.LIVEKIT_URL;
const LK_KEY              = process.env.LIVEKIT_API_KEY;
const LK_SECRET           = process.env.LIVEKIT_API_SECRET;
// Default trunk id retained for legacy code paths; pickTrunkForPhone is the
// real selector. Either Vobiz (+91) or Twilio (everywhere else) must be set
// for ensureCreds() to pass.
const LK_SIP_TRUNK_ID     = process.env.LIVEKIT_SIP_TRUNK_ID;
const LK_SIP_TRUNK_ID_TWILIO = process.env.LIVEKIT_SIP_TRUNK_ID_TWILIO;
const LK_AGENT_NAME       = process.env.LIVEKIT_AGENT_NAME || 'ai-voice-agent-priya';

// ── Egress (training-data audio capture) ─────────────────────────────────
// RECORDING_BACKEND    = 'gcp' | 's3' | 'r2' | '' (off)
// RECORDING_BUCKET     = bucket name (no protocol, no path)
// RECORDING_PREFIX     = optional key prefix, e.g. "ai-voice-agent/"
// GCP creds: GOOGLE_APPLICATION_CREDENTIALS_JSON (raw JSON string) OR default
//            service-account on the host.
// S3 creds:  AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_REGION.
// R2 creds:  R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_ACCOUNT_ID.
//            R2 is S3-compatible — we reuse LiveKit's S3Upload and set
//            endpoint=https://<account>.r2.cloudflarestorage.com,
//            region=auto, forcePathStyle=true. Recommended default: zero
//            egress fees at training time make R2 the cheapest backend
//            for write-now-train-later workloads.
// If RECORDING_BACKEND is unset, egress is skipped with a warning log —
// calls still work, just no audio persisted.
const RECORDING_BACKEND = (process.env.RECORDING_BACKEND || '').toLowerCase();
const RECORDING_BUCKET  = process.env.RECORDING_BUCKET || '';
const RECORDING_PREFIX  = process.env.RECORDING_PREFIX || '';

function ensureCreds() {
  const missing = [];
  if (!LK_URL) missing.push('LIVEKIT_URL');
  if (!LK_KEY) missing.push('LIVEKIT_API_KEY');
  if (!LK_SECRET) missing.push('LIVEKIT_API_SECRET');
  // At least one trunk must be configured — pickTrunkForPhone will reject
  // calls whose country code doesn't match any configured trunk.
  if (!LK_SIP_TRUNK_ID && !LK_SIP_TRUNK_ID_TWILIO) {
    missing.push('LIVEKIT_SIP_TRUNK_ID and/or LIVEKIT_SIP_TRUNK_ID_TWILIO');
  }
  if (missing.length) throw new Error(`Missing env vars: ${missing.join(', ')}`);
}

function buildEgressUpload() {
  if (RECORDING_BACKEND === 'gcp') {
    if (!RECORDING_BUCKET) return null;
    const credentials = process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON || '';
    return new GCPUpload({ bucket: RECORDING_BUCKET, credentials });
  }
  if (RECORDING_BACKEND === 's3') {
    if (!RECORDING_BUCKET) return null;
    return new S3Upload({
      bucket:    RECORDING_BUCKET,
      accessKey: process.env.AWS_ACCESS_KEY_ID || '',
      secret:    process.env.AWS_SECRET_ACCESS_KEY || '',
      region:    process.env.AWS_REGION || '',
    });
  }
  if (RECORDING_BACKEND === 'r2') {
    if (!RECORDING_BUCKET) return null;
    const accountId = process.env.R2_ACCOUNT_ID || '';
    if (!accountId) {
      console.warn('[egress] R2_ACCOUNT_ID not set — cannot build R2 endpoint');
      return null;
    }
    return new S3Upload({
      bucket:          RECORDING_BUCKET,
      accessKey:       process.env.R2_ACCESS_KEY_ID || '',
      secret:          process.env.R2_SECRET_ACCESS_KEY || '',
      // R2 ignores region semantics; "auto" is the convention.
      region:          'auto',
      // Virtual-hosted style doesn't work against R2; path-style does.
      endpoint:        `https://${accountId}.r2.cloudflarestorage.com`,
      forcePathStyle:  true,
    });
  }
  return null;
}

// Start a room-composite audio egress into the configured cloud bucket.
// Non-fatal: if anything fails, we log and continue with the call (better to
// lose a training recording than lose the customer).
async function startAudioEgress(room) {
  if (!RECORDING_BACKEND) {
    console.warn(`[egress] RECORDING_BACKEND not set — skipping audio capture for room ${room}`);
    return null;
  }
  const upload = buildEgressUpload();
  if (!upload) {
    console.warn(`[egress] RECORDING_BUCKET not set for backend=${RECORDING_BACKEND} — skipping`);
    return null;
  }
  try {
    const egressClient = new EgressClient(LK_URL, LK_KEY, LK_SECRET);
    // MP4 + Opus is the only reliable audioOnly combo for room composite egress.
    // OGG caused "no supported codec compatible with all outputs" — the compositor
    // pipeline needs explicit codec selection. MP4/Opus at 32kbps is fine for ASR.
    const filepath = `${RECORDING_PREFIX}${room}.mp4`;
    const output = new EncodedFileOutput({
      fileType: EncodedFileType.MP4,
      filepath,
      output: { case: RECORDING_BACKEND === 'gcp' ? 'gcp' : 's3', value: upload },
    });
    const info = await egressClient.startRoomCompositeEgress(room, {
      file: output,
      audioOnly: true,
      advanced: new EncodingOptions({ audioCodec: AudioCodec.OPUS }),
    });
    console.log(`[egress] started room=${room} egress_id=${info.egressId} → ${RECORDING_BACKEND}://${RECORDING_BUCKET}/${filepath}`);
    return info;
  } catch (err) {
    console.error(`[egress] failed to start for room ${room}:`, err?.message || err);
    return null;
  }
}

/**
 * Trigger a profile-agnostic outbound call.
 *
 * @param {object} params
 * @param {string} params.phone           - Recipient phone in E.164 (e.g. +919XXXXXXXXX)
 * @param {string} params.profile         - Agent profile id (e.g. 'ai-voice-agent', 'appointment-remind')
 * @param {object} [params.payload]       - Profile-specific context. Spread verbatim into
 *                                          participantAttributes — each key becomes one
 *                                          attribute the profile's renderContext reads.
 * @param {object} [params.identity]      - { shop, entityRef, entityName } — joins this
 *                                          call to a ScheduledCall row server-side.
 *                                          For ai-voice-agent: { shop, entityRef=orderId,
 *                                          entityName=orderName }.
 * @param {object} [params.branding]      - { name, category } — overrides STORE_NAME /
 *                                          STORE_CATEGORY env for this specific call.
 * @param {string} [params.lang]          - 'hi-IN' (default) or 'en-IN'.
 * @param {string} [params.roomName]      - Override room name (default: <profile>-<slug>-<ts>).
 *
 * Backwards-compatible: callers passing the legacy `order` arg (camelCase
 * COD-shaped object) get auto-translated into the new shape. Phase-6 will
 * deprecate that path once every caller migrates.
 *
 * @returns {Promise<{ ok: true, room_name: string, sip: object }>}
 */
export async function triggerLivekitCall(params) {
  ensureCreds();
  let { phone, profile, payload, identity, branding, lang, roomName, order } = params;
  if (!phone) throw new Error('phone required (E.164)');

  // ── Legacy `order` arg → new shape (backwards compatibility) ──────
  if (!payload && order) {
    payload = {
      customer_name: order.customerName || 'Customer',
      total_amount:  String(order.total ?? ''),
      product_name:  order.product || 'your order',
      delivery_city: order.city || '',
      delivery_area: order.area || '',
    };
    identity = identity || {
      shop:       order.shop || '',
      entityRef:  String(order.id || ''),
      entityName: order.name || `#${order.id}`,
    };
    branding = branding || { name: order.storeName, category: order.storeCategory };
  }
  payload   = payload   || {};
  identity  = identity  || { shop: '', entityRef: '', entityName: '' };
  branding  = branding  || {};

  const profileId = profile || 'ai-voice-agent';
  const slug = (identity.entityName || identity.entityRef || `call-${Date.now()}`).replace(/[^a-zA-Z0-9-]/g, '');
  const room = roomName || `${profileId}-${slug}-${Date.now()}`;

  // Dispatch the agent into the room BEFORE the SIP call connects.
  const dispatchClient = new AgentDispatchClient(LK_URL, LK_KEY, LK_SECRET);
  await dispatchClient.createDispatch(room, LK_AGENT_NAME, {
    metadata: JSON.stringify({
      profile:     profileId,
      lang:        lang === 'en-IN' ? 'en-IN' : 'hi-IN',
      shop:        identity.shop,
      entity_ref:  identity.entityRef,
      entity_name: identity.entityName,
    }),
  });

  // Start audio egress 10 s after dispatch — gives the agent time to join the
  // room and publish its audio track, which resolves the "no supported codec"
  // error that occurs when egress is started on an empty room.
  // Best-effort: transcripts are captured per-turn regardless of egress.
  setTimeout(() => {
    startAudioEgress(room).then(info => {
      if (info) console.log(`[egress] delayed start confirmed for room ${room}: egress_id=${info.egressId}`);
    });
  }, 10_000);

  // Route to Vobiz (India) or Twilio (everywhere else) based on the
  // destination country code. Loud failure if a non-India number arrives
  // without a Twilio trunk configured — see lib/trunks.js for rationale.
  const route = pickTrunkForPhone(phone);
  console.log(`[trigger-call] carrier=${route.carrier} trunk=${route.trunkId} from=${route.fromNumber} → ${phone}`);

  // Now originate the outbound SIP call. participantAttributes flow through
  // to agent's ctx.waitForParticipant().attributes.
  const sipClient = new SipClient(LK_URL, LK_KEY, LK_SECRET);
  const sip = await sipClient.createSipParticipant(
    route.trunkId,
    phone,
    room,
    {
      participantIdentity: `customer-${phone}`,
      participantName: payload.customer_name || 'Customer',
      participantAttributes: {
        // Engine-level keys — the agent worker uses these to load the right
        // profile module, set language, and persist transcripts.
        profile:          profileId,
        language:         lang === 'en-IN' ? 'en-IN' : 'hi-IN',
        shop:             identity.shop || '',
        // shopify_order_id is the legacy column name on CallTurn; phase-6
        // generalizes it to `entity_ref`. Profile modules read entity_ref
        // (preferred) with shopify_order_id as compatibility fallback.
        entity_ref:       identity.entityRef || '',
        shopify_order_id: identity.entityRef || '',
        // Branding overrides STORE_NAME / STORE_CATEGORY env defaults.
        store_name:       branding.name     || process.env.STORE_NAME     || '',
        store_category:   branding.category || process.env.STORE_CATEGORY || '',
        // Spread the profile's payload verbatim. Each key becomes one
        // participant attribute. SIP participantAttributes values must be
        // strings — coerce any non-string here.
        ...Object.fromEntries(
          Object.entries(payload).map(([k, v]) => [k, v == null ? '' : String(v)]),
        ),
        // order_number is COD-shaped legacy. Kept here for backwards-compat
        // with the ai-voice-agent prompt; new profiles use payload.* directly.
        order_number:     payload.order_number || identity.entityName || '',
      },
      playRingtone: true,
      ringingTimeout: 30,
      maxCallDuration: 300,
      waitUntilAnswered: false,
    },
  );

  return { ok: true, room_name: room, sip, egress_id: null };
}
