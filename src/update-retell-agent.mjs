/**
 * Patches the EXISTING Retell LLM + Agent in place (keeps the same IDs, so
 * RETELL_LLM_ID / RETELL_AGENT_ID in .env do not need to rotate).
 *
 * Run: `RETELL_API_KEY=... RETELL_LLM_ID=... RETELL_AGENT_ID=... node src/update-retell-agent.mjs`
 * (or just `node -r dotenv/config src/update-retell-agent.mjs dotenv_config_path=.env`)
 *
 * Applies the voice-naturalness tuning:
 *   - voice_model: eleven_multilingual_v2 (smoother Hindi prosody)
 *   - voice_speed 0.95, voice_temperature 1.0
 *   - interruption_sensitivity 0.5 (was 1.0 — stops it cutting itself off)
 *   - Hindi-appropriate backchannels
 *   - normalize_for_speech + boosted_keywords for brand/currency pronunciation
 *   - ambient call-center background at low volume
 *   - LLM temperature 0.2 → 0.6 (less scripted)
 *   - Prompt: replace "Short sentences" with "Speak naturally with warmth"
 */

const RETELL_API_KEY = process.env.RETELL_API_KEY;
const RETELL_LLM_ID = process.env.RETELL_LLM_ID;
const RETELL_AGENT_ID = process.env.RETELL_AGENT_ID;

if (!RETELL_API_KEY || !RETELL_LLM_ID || !RETELL_AGENT_ID) {
  console.error('Missing RETELL_API_KEY / RETELL_LLM_ID / RETELL_AGENT_ID');
  process.exit(1);
}

async function r(path, body, method = 'PATCH') {
  const res = await fetch(`https://api.retellai.com${path}`, {
    method,
    headers: { 'Authorization': `Bearer ${RETELL_API_KEY}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = text; }
  if (!res.ok) { console.error(`${method} ${path} failed ${res.status}:`, json); process.exit(1); }
  return json;
}

// Fetch current LLM so we can preserve general_prompt structure and only replace
// the "Short sentences..." line (don't want to hardcode the whole prompt in two places).
async function patchLlm() {
  const current = await r(`/get-retell-llm/${RETELL_LLM_ID}`, null, 'GET');
  const oldPrompt = current.general_prompt || '';
  const newPrompt = oldPrompt.replace(
    /- Short sentences\. Indian phone lines have delay\./,
    '- Speak naturally with warmth. Use natural pauses between clauses — do not clip sentences or sound scripted.'
  );
  if (newPrompt === oldPrompt) {
    console.warn('⚠ Prompt replacement line not found — prompt left unchanged. Check setup-retell-agent.mjs matches what is live.');
  }
  const updated = await r(`/update-retell-llm/${RETELL_LLM_ID}`, {
    model_temperature: 0.6,
    general_prompt: newPrompt,
  });
  console.log('✓ LLM patched:', updated.llm_id, '| temp:', updated.model_temperature);
}

async function patchAgent() {
  const updated = await r(`/update-agent/${RETELL_AGENT_ID}`, {
    voice_model: 'eleven_multilingual_v2',
    voice_temperature: 1.0,
    voice_speed: 0.95,
    interruption_sensitivity: 0.5,
    enable_backchannel: true,
    backchannel_frequency: 0.6,
    backchannel_words: ['haan', 'hmm', 'achha', 'ji'],
    normalize_for_speech: true,
    boosted_keywords: [process.env.STORE_NAME || 'our store', 'Priya', 'COD', 'Hinglish', 'Namaste', 'Dhanyawaad'],
    ambient_sound: 'call-center',
    ambient_sound_volume: 0.3,
  });
  console.log('✓ Agent patched:', updated.agent_id, '| voice_model:', updated.voice_model);
}

async function main() {
  console.log('Patching LLM', RETELL_LLM_ID, '...');
  await patchLlm();
  console.log('Patching Agent', RETELL_AGENT_ID, '...');
  await patchAgent();
  console.log('\nDone. Make a fresh test call — no .env change needed.');
}

main().catch(err => { console.error(err); process.exit(1); });
