/**
 * One-shot: upgrade an EXISTING Twilio + LiveKit outbound trunk pair to
 * secure mode (SIPS + SRTP + TLS transport).
 *
 * Background: src/create-twilio-trunk.mjs creates new trunks with
 * Secure=true now, but trunks created before that change are Secure=false
 * with the LiveKit side on plain TCP. This script flips both in place.
 *
 * Safe to re-run. Skips any already-secure side. Reads existing
 * TWILIO_SIP_USERNAME / TWILIO_SIP_PASSWORD from .env so we don't need to
 * regenerate the credential list (Twilio doesn't reveal passwords after
 * creation, but we have ours because the operator pasted them into .env).
 *
 * Run:
 *   set -a && . ./.env && set +a && node scripts/upgrade-twilio-trunk-secure.mjs
 */
import { SipClient } from 'livekit-server-sdk';
import crypto from 'node:crypto';

const {
  TWILIO_ACCOUNT_SID,
  TWILIO_API_KEY_SID,
  TWILIO_API_KEY_SECRET,
  TWILIO_FROM_NUMBER,
  TWILIO_SIP_USERNAME,
  TWILIO_SIP_PASSWORD,
  LIVEKIT_URL,
  LIVEKIT_API_KEY,
  LIVEKIT_API_SECRET,
  LIVEKIT_SIP_TRUNK_ID_TWILIO,
} = process.env;

const missing = Object.entries({
  TWILIO_ACCOUNT_SID, TWILIO_API_KEY_SID, TWILIO_API_KEY_SECRET, TWILIO_FROM_NUMBER,
  LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET,
}).filter(([, v]) => !v).map(([k]) => k);
if (missing.length) { console.error('Missing env:', missing.join(', ')); process.exit(1); }

// SIP creds in .env are OPTIONAL — if missing (deployments that ran the
// original v0 trunk script never persisted them), we rotate: add a fresh
// credential to the existing CL and use the new one. Old credential
// becomes vestigial — harmless, can be deleted in console at leisure.
const ROTATE_CREDENTIAL = !TWILIO_SIP_USERNAME || !TWILIO_SIP_PASSWORD;
if (ROTATE_CREDENTIAL) {
  console.log('TWILIO_SIP_USERNAME / TWILIO_SIP_PASSWORD missing — will rotate credential.');
}

function generateSipPassword() {
  for (let i = 0; i < 10; i++) {
    const pw = crypto.randomBytes(24).toString('base64').replace(/[^a-zA-Z0-9]/g, '').slice(0, 22);
    if (/[a-z]/.test(pw) && /[A-Z]/.test(pw) && /[0-9]/.test(pw) && pw.length >= 16) return pw;
  }
  return 'Gv' + crypto.randomBytes(20).toString('hex') + '1';
}

const TRUNK_FRIENDLY_NAME = 'glitch-voice';
const LIVEKIT_TRUNK_NAME  = 'twilio-outbound';

const AUTH = 'Basic ' + Buffer.from(`${TWILIO_API_KEY_SID}:${TWILIO_API_KEY_SECRET}`).toString('base64');

async function twilio(method, url, body) {
  const opts = { method, headers: { Authorization: AUTH } };
  if (body) {
    opts.headers['Content-Type'] = 'application/x-www-form-urlencoded';
    opts.body = new URLSearchParams(body).toString();
  }
  const res = await fetch(url, opts);
  const text = await res.text();
  let data; try { data = JSON.parse(text); } catch { data = { raw: text }; }
  if (!res.ok) throw new Error(`Twilio ${method} ${url} → HTTP ${res.status}: ${data.message || data.raw || ''}`);
  return data;
}

// ── 1. Find + secure the Twilio trunk ───────────────────────────────
const list = await twilio('GET', 'https://trunking.twilio.com/v1/Trunks?PageSize=100');
const trunk = (list.trunks || []).find(t => t.friendly_name === TRUNK_FRIENDLY_NAME);
if (!trunk) {
  console.error(`✗ No Twilio trunk found with friendly_name="${TRUNK_FRIENDLY_NAME}". Run src/create-twilio-trunk.mjs first.`);
  process.exit(1);
}
console.log(`✓ Found Twilio trunk: ${trunk.sid} (${trunk.domain_name}, secure=${trunk.secure})`);

// ── 2. Rotate credential if .env didn't preserve the SIP password ────
// Must happen BEFORE we flip the trunk to Secure=true so the new
// credential is live + attached when LiveKit reconnects on TLS.
let sipUser = TWILIO_SIP_USERNAME;
let sipPass = TWILIO_SIP_PASSWORD;
let rotatedCredentialSid = null;
if (ROTATE_CREDENTIAL) {
  const attached = await twilio('GET', `https://trunking.twilio.com/v1/Trunks/${trunk.sid}/CredentialLists`);
  const cl = attached.credential_lists?.[0];
  if (!cl) {
    console.error('✗ Trunk has no credential list attached. Run src/create-twilio-trunk.mjs from scratch.');
    process.exit(1);
  }
  sipUser = `gv${crypto.randomBytes(6).toString('hex')}`;
  sipPass = generateSipPassword();
  const cred = await twilio(
    'POST',
    `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/SIP/CredentialLists/${cl.sid}/Credentials.json`,
    { Username: sipUser, Password: sipPass },
  );
  rotatedCredentialSid = cred.sid;
  console.log(`✓ Rotated SIP credential: created ${cred.sid} (user ${sipUser}) in CL ${cl.sid}`);
}

// ── 3. Flip Twilio trunk to Secure=true ──────────────────────────────
if (!trunk.secure) {
  const updated = await twilio('POST', `https://trunking.twilio.com/v1/Trunks/${trunk.sid}`, { Secure: 'true' });
  console.log(`✓ Upgraded trunk to secure=true (was false)`);
  trunk.secure = updated.secure;
} else {
  console.log('  Twilio trunk already Secure=true — skipping.');
}

// ── 4. Rebuild the LiveKit outbound trunk with transport=3 (TLS) ─────
const lk = new SipClient(LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET);

const existing = await lk.listSipOutboundTrunk();
const lkTrunk = existing.find(t => t.name === LIVEKIT_TRUNK_NAME)
  || (LIVEKIT_SIP_TRUNK_ID_TWILIO && existing.find(t => t.sipTrunkId === LIVEKIT_SIP_TRUNK_ID_TWILIO));

if (lkTrunk) {
  console.log(`Deleting LiveKit trunk ${lkTrunk.sipTrunkId} (transport=${lkTrunk.transport}) to recreate with TLS.`);
  await lk.deleteSipTrunk(lkTrunk.sipTrunkId);
}

const newLkTrunk = await lk.createSipOutboundTrunk(
  LIVEKIT_TRUNK_NAME,
  trunk.domain_name,
  [TWILIO_FROM_NUMBER],
  {
    authUsername: sipUser,
    authPassword: sipPass,
    transport:    3, // SIP_TRANSPORT_TLS
  },
);
console.log(`✓ Created LiveKit trunk ${newLkTrunk.sipTrunkId} on TLS.`);

console.log('\n─────────── Update .env (KEEP SECRET) ───────────');
console.log(`LIVEKIT_SIP_TRUNK_ID_TWILIO=${newLkTrunk.sipTrunkId}`);
if (ROTATE_CREDENTIAL) {
  console.log(`TWILIO_SIP_USERNAME=${sipUser}`);
  console.log(`TWILIO_SIP_PASSWORD=${sipPass}`);
  console.log(`# (Twilio credential SID: ${rotatedCredentialSid})`);
}
console.log('─────────────────────────────────────────────────');
console.log('\nThen restart:');
console.log('  sudo systemctl restart ai-voice-agent ai-voice-agent-agent');
