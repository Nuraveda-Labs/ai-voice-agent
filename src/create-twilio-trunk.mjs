/**
 * One-time helper: provisions Twilio + LiveKit for global outbound calling.
 *
 * What it does (idempotent on every step — safe to re-run):
 *   1. Twilio: create an Elastic SIP Trunk named "glitch-voice" (or reuse if
 *      already present).
 *   2. Twilio: create a credential list named "glitch-voice-cl" with a fresh
 *      auto-generated SIP username + password, and attach it to the trunk.
 *      If the trunk already has a credential list attached, the existing one
 *      is reused and we DO NOT print the password (we don't have it; Twilio
 *      won't reveal it after creation).
 *   3. LiveKit: create an Outbound SIP Trunk pointing at the Twilio
 *      termination URI (<trunk-sid>.pstn.twilio.com) authenticated with
 *      the credential list username/password.
 *   4. Print the env-var lines to paste into .env, then how to restart.
 *
 * Requires env:
 *   TWILIO_ACCOUNT_SID         — ACxxxxxxxxxxxx
 *   TWILIO_API_KEY_SID         — SKxxxxxxxxxxxx (preferred over auth token)
 *   TWILIO_API_KEY_SECRET      — the secret matching API_KEY_SID
 *   TWILIO_FROM_NUMBER         — your Twilio E.164 number (+1...)
 *   LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET
 *
 * Run (with .env loaded):
 *   set -a && . ./.env && set +a && node src/create-twilio-trunk.mjs
 */
import { SipClient } from 'livekit-server-sdk';
import crypto from 'node:crypto';

const TWILIO_ACCOUNT_SID    = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_API_KEY_SID    = process.env.TWILIO_API_KEY_SID || process.env.TWILIO_ACCOUNT_SID;
const TWILIO_API_KEY_SECRET = process.env.TWILIO_API_KEY_SECRET || process.env.TWILIO_AUTH_TOKEN;
const TWILIO_FROM_NUMBER    = process.env.TWILIO_FROM_NUMBER;
const LIVEKIT_URL           = process.env.LIVEKIT_URL;
const LIVEKIT_API_KEY       = process.env.LIVEKIT_API_KEY;
const LIVEKIT_API_SECRET    = process.env.LIVEKIT_API_SECRET;

const missing = Object.entries({
  TWILIO_ACCOUNT_SID, TWILIO_API_KEY_SID, TWILIO_API_KEY_SECRET, TWILIO_FROM_NUMBER,
  LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET,
}).filter(([, v]) => !v).map(([k]) => k);
if (missing.length) { console.error('Missing env:', missing.join(', ')); process.exit(1); }

const TRUNK_FRIENDLY_NAME    = 'glitch-voice';
const TRUNK_DOMAIN_PREFIX    = `glitch-voice-${TWILIO_ACCOUNT_SID.slice(-6).toLowerCase()}`;
const CRED_LIST_FRIENDLY     = 'glitch-voice-cl';
const LIVEKIT_TRUNK_NAME     = 'twilio-outbound';

// Twilio best practice: use API Key SID + Secret (SK...) for auth, not the
// Account SID + Auth Token. API Keys can be scoped / revoked / rotated
// independently of the account credentials. We fall back to the auth token
// only if no API key is configured, for ease of first-time setup.
//   https://www.twilio.com/docs/iam/api-keys#api-key-best-practices
const AUTH = 'Basic ' + Buffer.from(`${TWILIO_API_KEY_SID}:${TWILIO_API_KEY_SECRET}`).toString('base64');

// Thin fetch wrapper with automatic retry on 429 / 5xx — Twilio's official
// SDKs do this and the docs recommend it for production scripts that
// provision against the REST API.
//   https://www.twilio.com/docs/usage/requests-to-twilio#rate-limit-retries
async function twilio(method, url, body, { retries = 3 } = {}) {
  const opts = { method, headers: { Authorization: AUTH } };
  if (body) {
    opts.headers['Content-Type'] = 'application/x-www-form-urlencoded';
    opts.body = new URLSearchParams(body).toString();
  }
  for (let attempt = 0; attempt <= retries; attempt++) {
    const res = await fetch(url, opts);
    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch { data = { raw: text }; }
    if (res.ok) return data;
    const retryable = res.status === 429 || res.status >= 500;
    if (retryable && attempt < retries) {
      const backoffMs = 500 * Math.pow(2, attempt);
      console.warn(`[twilio] HTTP ${res.status} on ${method} ${url} — retrying in ${backoffMs}ms (attempt ${attempt + 1}/${retries})`);
      await new Promise(r => setTimeout(r, backoffMs));
      continue;
    }
    throw new Error(`Twilio ${method} ${url} → HTTP ${res.status}: ${data.message || data.raw || ''}`);
  }
}

// Verify creds work AND that this is the right account BEFORE we start
// creating resources. Surfaces "wrong API key", "wrong account SID", and
// "API key revoked" as a single clear error at the top rather than at the
// fourth request when partial state already exists.
{
  const acct = await twilio('GET', `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}.json`);
  console.log(`✓ Auth ok — account "${acct.friendly_name}" (${acct.status})`);
  if (acct.status !== 'active') {
    throw new Error(`Twilio account is ${acct.status} — provisioning aborted`);
  }
}

/**
 * Generate a SIP password that satisfies Twilio's credential policy.
 *
 * Twilio requires 12–128 chars with at least one upper, one lower, and one
 * digit. crypto.randomBytes(...) alphanumeric can in theory miss a class;
 * we sample additional candidates until all three classes are present so
 * the script doesn't fail Twilio's validator on an unlucky random draw.
 *   https://www.twilio.com/docs/sip-trunking/api/credential-list-resource
 */
function generateSipPassword() {
  for (let i = 0; i < 10; i++) {
    const pw = crypto.randomBytes(24).toString('base64').replace(/[^a-zA-Z0-9]/g, '').slice(0, 22);
    if (/[a-z]/.test(pw) && /[A-Z]/.test(pw) && /[0-9]/.test(pw) && pw.length >= 16) return pw;
  }
  // Vanishingly improbable — fall back to a manually-mixed string.
  return 'Gv' + crypto.randomBytes(20).toString('hex') + '1';
}

// ── 1. Trunk ─────────────────────────────────────────────────────────
let trunk;
{
  const list = await twilio('GET', 'https://trunking.twilio.com/v1/Trunks?PageSize=100');
  trunk = (list.trunks || []).find(t => t.friendly_name === TRUNK_FRIENDLY_NAME);
  if (trunk) {
    console.log(`✓ Reusing existing Twilio trunk: ${trunk.sid} (${trunk.domain_name})`);
    if (!trunk.secure) {
      console.warn('  ⚠ existing trunk has Secure=false. Production best practice is Secure=true (SIPS + SRTP).');
      console.warn('    Enable in Twilio console → SIP Trunking → <trunk> → General → Secure Trunking, or:');
      console.warn(`    curl -u "$TWILIO_API_KEY_SID:$TWILIO_API_KEY_SECRET" -XPOST https://trunking.twilio.com/v1/Trunks/${trunk.sid} -d Secure=true`);
    }
  } else {
    // Best practice: Secure=true enforces SIPS (TLS) + SRTP on the trunk —
    // signalling and media are both encrypted in transit. We pair this on
    // the LiveKit side with transport=3 (SIP_TRANSPORT_TLS) below.
    //   https://www.twilio.com/docs/sip-trunking#secure-trunking
    trunk = await twilio('POST', 'https://trunking.twilio.com/v1/Trunks', {
      FriendlyName: TRUNK_FRIENDLY_NAME,
      DomainName:   `${TRUNK_DOMAIN_PREFIX}.pstn.twilio.com`,
      Secure:       'true',
    });
    console.log(`✓ Created Twilio trunk: ${trunk.sid} (${trunk.domain_name}, secure=true)`);
  }
}

// ── 2. Credential list ───────────────────────────────────────────────
// Twilio's Trunking API has its own credential-lists subresource that
// attaches an existing account-level CredentialList to the trunk. Account
// CredentialLists live at /2010-04-01/Accounts/<sid>/SIP/CredentialLists.
let credentials;
{
  const attached = await twilio('GET', `https://trunking.twilio.com/v1/Trunks/${trunk.sid}/CredentialLists`);
  if (attached.credential_lists && attached.credential_lists.length > 0) {
    console.log(`✓ Trunk already has a credential list attached: ${attached.credential_lists[0].sid}`);
    console.log('  Cannot recover the password (Twilio does not reveal it after creation).');
    console.log('  If you need fresh credentials, delete the credential list in Twilio console and re-run.');
    credentials = { reused: true, username: '(existing — set in .env already)', password: '(existing — set in .env already)' };
  } else {
    const cl = await twilio(
      'POST',
      `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/SIP/CredentialLists.json`,
      { FriendlyName: CRED_LIST_FRIENDLY },
    );
    const username = `gv${crypto.randomBytes(6).toString('hex')}`;
    const password = generateSipPassword();
    await twilio(
      'POST',
      `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/SIP/CredentialLists/${cl.sid}/Credentials.json`,
      { Username: username, Password: password },
    );
    await twilio(
      'POST',
      `https://trunking.twilio.com/v1/Trunks/${trunk.sid}/CredentialLists`,
      { CredentialListSid: cl.sid },
    );
    credentials = { reused: false, username, password, credentialListSid: cl.sid };
    console.log(`✓ Created credential list ${cl.sid} with new SIP username/password and attached to trunk.`);
  }
}

// ── 3. LiveKit outbound trunk ────────────────────────────────────────
const lk = new SipClient(LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET);
let lkTrunk;
{
  const existing = await lk.listSipOutboundTrunk();
  lkTrunk = existing.find(t => t.name === LIVEKIT_TRUNK_NAME);
  if (lkTrunk) {
    console.log(`✓ Reusing existing LiveKit outbound trunk: ${lkTrunk.sipTrunkId}`);
  } else if (credentials.reused) {
    console.error('✗ Twilio trunk already has a credential list, but no LiveKit trunk exists yet.');
    console.error('  Cannot create the LiveKit trunk without the SIP password.');
    console.error('  Either:');
    console.error('  (a) keep the existing TWILIO SIP creds you have in .env and create the LiveKit trunk');
    console.error('      manually with the live createSipOutboundTrunk API, OR');
    console.error('  (b) delete the credential list in Twilio console and re-run this script.');
    process.exit(1);
  } else {
    lkTrunk = await lk.createSipOutboundTrunk(
      LIVEKIT_TRUNK_NAME,
      trunk.domain_name,
      [TWILIO_FROM_NUMBER],
      {
        authUsername: credentials.username,
        authPassword: credentials.password,
        // SIP_TRANSPORT_TLS — pairs with Secure=true on the Twilio trunk
        // so SIP signalling is encrypted end-to-end. SRTP for the media
        // leg is automatic once the trunk is in secure mode. UDP and TCP
        // would still work but transmit credentials and call control in
        // the clear, which is a needless production weakness.
        transport:    3,
      },
    );
    console.log(`✓ Created LiveKit outbound trunk: ${lkTrunk.sipTrunkId}`);
  }
}

// ── 4. Report ────────────────────────────────────────────────────────
console.log('');
console.log('─────────── Paste into .env (KEEP SECRET) ───────────');
console.log(`LIVEKIT_SIP_TRUNK_ID_TWILIO=${lkTrunk.sipTrunkId}`);
if (!credentials.reused) {
  console.log(`TWILIO_SIP_DOMAIN=${trunk.domain_name}`);
  console.log(`TWILIO_SIP_USERNAME=${credentials.username}`);
  console.log(`TWILIO_SIP_PASSWORD=${credentials.password}`);
}
console.log('───────────────────────────────────────');
console.log('');
console.log('Then restart the agent worker:');
console.log('  sudo systemctl restart ai-voice-agent-agent');
console.log('');
console.log('Test a non-India call (dry-run first):');
console.log(`  DISPATCH_MODE=dry_run curl -X POST http://localhost:3104/calls/dispatch \\`);
console.log(`    -H "Content-Type: application/json" -H "X-COD-Tool-Secret: $LIVEKIT_TOOL_SECRET" \\`);
console.log(`    -d '{"profile":"appointment-remind","phone":"+1XXXXXXXXXX","payload":{}}'`);
