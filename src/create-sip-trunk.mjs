/**
 * One-time helper: creates a LiveKit Outbound SIP Trunk that routes calls out
 * through our Vobiz account, then prints the LIVEKIT_SIP_TRUNK_ID to paste
 * into .env.
 *
 * Requires env:
 *   LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET
 *   VOBIZ_SIP_HOST       — e.g. sip.vobiz.ai (or trk_xxx.sip.vobiz.ai)
 *   VOBIZ_SIP_USERNAME   — auth-id on Vobiz SIP trunk
 *   VOBIZ_SIP_PASSWORD   — auth-token / SIP secret
 *   VOBIZ_FROM_NUMBER    — the Vobiz number in E.164 (+91XXXXXXXXXX)
 *
 * Run:
 *   node -r dotenv/config src/create-sip-trunk.mjs dotenv_config_path=.env
 * or (with set-env approach):
 *   set -a && . ./.env && set +a && node src/create-sip-trunk.mjs
 *
 * Idempotent-ish: if a trunk with the same name already exists, prints its id
 * rather than creating a duplicate.
 */
import { SipClient } from 'livekit-server-sdk';

const {
  LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET,
  VOBIZ_SIP_HOST, VOBIZ_SIP_USERNAME, VOBIZ_SIP_PASSWORD,
  VOBIZ_FROM_NUMBER,
} = process.env;

const miss = Object.entries({
  LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET,
  VOBIZ_SIP_HOST, VOBIZ_SIP_USERNAME, VOBIZ_SIP_PASSWORD, VOBIZ_FROM_NUMBER,
}).filter(([, v]) => !v).map(([k]) => k);
if (miss.length) { console.error('Missing:', miss.join(', ')); process.exit(1); }

const TRUNK_NAME = 'vobiz-outbound';

const client = new SipClient(LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET);

// Check for existing trunk
const existing = await client.listSipOutboundTrunk();
const dup = existing.find(t => t.name === TRUNK_NAME);
if (dup) {
  console.log('✓ Trunk already exists:', dup.sipTrunkId, '(' + dup.name + ')');
  console.log('\nLIVEKIT_SIP_TRUNK_ID=' + dup.sipTrunkId);
  process.exit(0);
}

const trunk = await client.createSipOutboundTrunk(
  TRUNK_NAME,
  VOBIZ_SIP_HOST,
  [VOBIZ_FROM_NUMBER],
  {
    authUsername: VOBIZ_SIP_USERNAME,
    authPassword: VOBIZ_SIP_PASSWORD,
    transport: 1, // SIP_TRANSPORT_UDP. Vobiz docs use UDP for G.711.
  },
);

console.log('✓ Created outbound trunk:', trunk.sipTrunkId);
console.log(JSON.stringify(trunk, null, 2));
console.log('\nLIVEKIT_SIP_TRUNK_ID=' + trunk.sipTrunkId);
console.log('\nPaste that into .env and restart ai-voice-agent-agent.service.');
