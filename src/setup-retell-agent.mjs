/**
 * (LEGACY — kept for reference.) One-time setup: creates the Retell LLM +
 * Agent for the store configured via STORE_NAME. Retell path was superseded
 * by LiveKit + Sarvam for production; we keep this to make it easy to swap
 * back or fork for ElevenLabs-based deployments.
 *
 * Run: `node src/setup-retell-agent.mjs` (after `pnpm install`).
 *
 * Prints llm_id + agent_id — copy agent_id into .env as RETELL_AGENT_ID.
 *
 * Idempotency: if you re-run, it creates a NEW agent. Delete or manage old ones
 * via Retell dashboard. For updates, use update-retell-llm / update-agent.
 */

const RETELL_API_KEY   = process.env.RETELL_API_KEY;
const SERVER_URL       = process.env.SERVER_URL     || 'https://your-domain.com/ai-voice-agent';
const STORE_NAME       = process.env.STORE_NAME     || 'our store';
const STORE_CATEGORY   = process.env.STORE_CATEGORY || 'online store';

if (!RETELL_API_KEY) { console.error('Missing RETELL_API_KEY'); process.exit(1); }

async function r(path, body, method = 'POST') {
  const res = await fetch(`https://api.retellai.com${path}`, {
    method,
    headers: { 'Authorization': `Bearer ${RETELL_API_KEY}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json();
  if (!res.ok) { console.error(`${path} failed ${res.status}:`, json); process.exit(1); }
  return json;
}

const SYSTEM_PROMPT = `You are Priya, a ***REMOVED*** calling from ${STORE_NAME} — a ${STORE_CATEGORY}.

Your job is to CONFIRM a cash-on-delivery (COD) order the customer placed on the website. You speak naturally in Hinglish (the Hindi-English code-mix most Indian customers use). Keep it short, warm, and polite.

Context given at call start (use these values, do NOT invent):
- {{customer_name}}
- {{order_number}}
- {{total_amount}} (INR)
- {{product_name}}
- {{delivery_city}}, {{delivery_area}}

## Call flow

**Greeting (one sentence):**
"Namaste {{customer_name}} ji, main Priya bol rahi hoon ${STORE_NAME} se."

**Confirm order details:**
"Aapne {{order_number}} par {{product_name}} order kiya hai, total ₹{{total_amount}} — delivery {{delivery_area}}, {{delivery_city}} pe hogi, COD pe. Confirm kar doon?"

**Handle response:**

- **Positive** ("haan", "yes", "confirm", "theek hai", "kar do", "bhej do", "sahi hai", "ji") → call function \`confirm_order\`.
- **Negative** ("nahi", "cancel", "mujhe nahi chahiye", "mana", "galti se") → ask "Koi baat nahi, kya reason thi?" (one polite probe), then call \`cancel_order\` with the reason.
- **Questions you cannot answer** (size exchange, refund timing, anything specific) OR customer asks for "agent/representative/human" → call \`request_human_agent\`.
- **Customer busy / asks to call later** → "Bilkul, 1 ghante mein call karti hoon" → call \`request_callback\`.

**Common objections — answer then return to confirm:**
- "Kitne paise dene hain?" → repeat total amount and delivery address.
- "Kab aayega?" → "Aapko 5-7 din mein deliver ho jayega."
- "Return policy kya hai?" → "7 din ke andar return kar sakte hain, easy process."
- "Ye call asli hai?" → "Bilkul, ${STORE_NAME} ki taraf se. Aapke order number {{order_number}} ke baare mein call ki hai."

**Rules:**
- Speak naturally with warmth. Use natural pauses between clauses — do not clip sentences or sound scripted.
- Never pressure. If customer clearly says no, acknowledge and \`cancel_order\`.
- Switch to English if customer does.
- If after 2 follow-ups the response is still unclear, call \`request_human_agent\` with note "unclear response".
- End with "Dhanyawaad, aapka din shubh ho" or English equivalent.

Do NOT discuss: discounts outside what the order shows, stock availability for other items, promotional offers, other products. Focus only on THIS order.`;

async function main() {
  console.log('Creating Retell LLM...');
  const llm = await r('/create-retell-llm', {
    model: 'gpt-4.1-mini',
    model_temperature: 0.6,
    general_prompt: SYSTEM_PROMPT,
    begin_message: `Namaste, main Priya bol rahi hoon ${STORE_NAME} se. Aapke order ke confirmation ke liye call kiya hai.`,
    general_tools: [
      {
        type: 'end_call',
        name: 'end_call',
        description: 'Hang up the call politely after the customer has responded and we have logged the outcome.',
      },
      {
        type: 'custom',
        name: 'confirm_order',
        description: 'Customer explicitly confirmed they want the order delivered. Mark the order as confirmed in our system.',
        url: `${SERVER_URL}/webhook/retell/tool/confirm_order`,
        speak_during_execution: false,
        parameters: {
          type: 'object',
          properties: {
            note: { type: 'string', description: 'Optional note — any context from the conversation.' },
          },
          required: [],
        },
      },
      {
        type: 'custom',
        name: 'cancel_order',
        description: 'Customer explicitly declined / refused the order. Mark it as cancelled.',
        url: `${SERVER_URL}/webhook/retell/tool/cancel_order`,
        speak_during_execution: false,
        parameters: {
          type: 'object',
          properties: {
            reason: { type: 'string', description: 'Short reason the customer gave (e.g., "wrong size", "changed mind", "ordered by mistake").' },
          },
          required: ['reason'],
        },
      },
      {
        type: 'custom',
        name: 'request_human_agent',
        description: 'Customer needs a human — they have questions we cannot answer, or are unclear.',
        url: `${SERVER_URL}/webhook/retell/tool/request_human_agent`,
        speak_during_execution: false,
        parameters: {
          type: 'object',
          properties: {
            note: { type: 'string', description: 'What the customer needs help with.' },
          },
          required: ['note'],
        },
      },
      {
        type: 'custom',
        name: 'request_callback',
        description: 'Customer is busy and asked us to call back. Schedule a retry.',
        url: `${SERVER_URL}/webhook/retell/tool/request_callback`,
        speak_during_execution: false,
        parameters: {
          type: 'object',
          properties: {
            when: { type: 'string', description: 'When customer wants the call back (e.g., "in 1 hour", "evening", "tomorrow morning").' },
          },
          required: [],
        },
      },
    ],
  });
  console.log('✓ LLM created:', llm.llm_id);

  console.log('Creating Retell Agent...');
  const agent = await r('/create-agent', {
    agent_name: `COD Confirm — ${STORE_NAME} (Priya)`,
    voice_id: '11labs-Monika',
    voice_model: 'eleven_multilingual_v2',
    voice_temperature: 1.0,
    voice_speed: 0.95,
    language: 'multi',
    response_engine: { type: 'retell-llm', llm_id: llm.llm_id },
    webhook_url: `${SERVER_URL}/webhook/retell/call-event`,
    max_call_duration_ms: 3 * 60 * 1000,
    end_call_after_silence_ms: 15000,
    interruption_sensitivity: 0.5,
    enable_backchannel: true,
    backchannel_frequency: 0.6,
    backchannel_words: ['haan', 'hmm', 'achha', 'ji'],
    normalize_for_speech: true,
    boosted_keywords: [STORE_NAME, 'Priya', 'COD', 'Hinglish', 'Namaste', 'Dhanyawaad'],
    ambient_sound: 'call-center',
    ambient_sound_volume: 0.3,
    voicemail_option: { action: { type: 'hangup' } },
  });
  console.log('✓ Agent created:', agent.agent_id);

  console.log('\n=====');
  console.log('RETELL_LLM_ID=' + llm.llm_id);
  console.log('RETELL_AGENT_ID=' + agent.agent_id);
  console.log('=====');
  console.log('\nPaste RETELL_AGENT_ID into .env and restart the server.');
}

main().catch(err => { console.error(err); process.exit(1); });
