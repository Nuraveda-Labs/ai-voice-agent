/**
 * (LEGACY — kept for reference.) Creates a Bolna voice AI agent for the
 * store configured via STORE_NAME. Bolna path was superseded by LiveKit
 * + Sarvam for production; we keep this as a reference for teams that want
 * to fork Bolna-based deployments.
 *
 * Why the Sarvam path: Bulbul v3 gave the best 8 kHz Hindi telephony
 * prosody of the options we benchmarked for our use case.
 *
 * Run:
 *   node -r dotenv/config src/setup-bolna-agent.mjs dotenv_config_path=.env
 *
 * Prints the new agent_id. Paste into .env as BOLNA_AGENT_ID and restart
 * ai-voice-agent.service.
 *
 * ── Architecture notes vs Retell ────────────────────────────────────────
 *
 *  1. Voice stack:
 *       TTS: Sarvam bulbul:v3 (voice "priya" — female Hindi, native prosody)
 *       STT: Sarvam saaras:v3 (Hindi with Hinglish code-switch)
 *       LLM: Azure gpt-4.1-mini via Bolna, temperature 0.6
 *
 *  2. Mid-call tool calls (confirm_order, cancel_order, etc.) are NOT
 *     configured here. Bolna's `api_tools` field on /v2/agent CREATE / PUT
 *     currently 500s with a `NoneType` error for any non-null value (bug
 *     in their validator as of 2026-04-15 — verified by exhaustive shape
 *     probing). Either:
 *       (a) Configure tools via the Bolna dashboard UI ("Tools Tab"),
 *           which serialises them differently and bypasses the API bug, OR
 *       (b) Use the POST-CALL path (preferred here): Bolna LLM-classifies
 *           the transcript into a **Disposition** ("COD outcome"), and
 *           posts the full execution to our webhook_url. server.js reads
 *           the disposition and writes the Shopify tag server-side.
 *     Option (b) is simpler and costs 2-3 seconds of tag-write delay
 *     after the call ends — trivial for COD confirm.
 *
 *  3. Dynamic per-call context passes through `user_data` on POST /call.
 *     In prompts and the welcome message, use `{variable}` (single brace).
 */

const BOLNA_API_KEY    = process.env.BOLNA_API_KEY;
const BOLNA_API_BASE   = process.env.BOLNA_API_BASE   || 'https://api.bolna.dev';
const SERVER_URL       = process.env.SERVER_URL       || 'https://your-domain.com/ai-voice-agent';
const STORE_NAME       = process.env.STORE_NAME       || 'our store';
const STORE_CATEGORY   = process.env.STORE_CATEGORY   || 'online store';

if (!BOLNA_API_KEY) { console.error('Missing BOLNA_API_KEY'); process.exit(1); }

const AGENT_NAME = `AI Voice Agent — ${STORE_NAME} (Priya, Sarvam)`;

const WELCOME = `Namaste {customer_name} ji, main Priya bol rahi hoon ${STORE_NAME} se. Aapke order ke confirmation ke liye call kiya hai.`;

// Prompt designed for post-call disposition classification. No @tool mentions.
// The agent just has a natural conversation; Bolna's post-call LLM reads the
// transcript and decides confirmed / cancelled / agent-needed / callback.
const SYSTEM_PROMPT = `You are Priya, a ***REMOVED*** calling from ${STORE_NAME} — a ${STORE_CATEGORY}.

Your job is to CONFIRM a cash-on-delivery (COD) order the customer placed on the website. You speak naturally in Hinglish (the Hindi-English code-mix most Indian customers use). Be warm and relaxed — pause naturally between clauses. Do NOT sound scripted.

## Call context (dynamic values, already known — do NOT ask the customer for these)

- Customer name: {customer_name}
- Order number: {order_number}
- Total amount: Rs. {total_amount}
- Product: {product_name}
- Delivery address: {delivery_area}, {delivery_city}

## Call flow

**Greeting:**
"Namaste {customer_name} ji, main Priya bol rahi hoon ${STORE_NAME} se."

**Confirm order details:**
"Aapne {order_number} par {product_name} order kiya hai, total Rs. {total_amount} — delivery {delivery_area}, {delivery_city} pe hogi, COD pe. Confirm kar doon?"

**Handle response:**

- **Positive** ("haan", "yes", "confirm", "theek hai", "kar do", "bhej do", "sahi hai", "ji") → clearly acknowledge: "Perfect, main aapka order confirm kar deti hoon. Aapko 5-7 din mein deliver ho jayega."
- **Negative** ("nahi", "cancel", "mujhe nahi chahiye", "mana", "galti se") → ask "Koi baat nahi, kya reason thi?" (one polite probe), then clearly acknowledge: "Theek hai, main aapka order cancel kar deti hoon."
- **Questions you cannot answer** (size exchange, refund timing, anything specific) OR customer asks for "agent/representative/human" → say: "Ek second, main aapko hamare customer care agent se connect karvati hoon — woh aapko jaldi call karenge."
- **Customer busy / asks to call later** → "Bilkul, kab call karun?" capture the time, then: "Theek hai, main {{time}} pe call karti hoon. Dhanyawaad."

**Common objections — answer then return to confirm:**
- "Kitne paise dene hain?" → repeat total amount and delivery address.
- "Kab aayega?" → "Aapko 5-7 din mein deliver ho jayega."
- "Return policy kya hai?" → "7 din ke andar return kar sakte hain, easy process."
- "Ye call asli hai?" → "Bilkul, ${STORE_NAME} ki taraf se. Aapke order number {order_number} ke baare mein call ki hai."

**Rules:**
- Speak naturally with warmth. Use natural pauses between clauses — do not clip sentences or sound scripted.
- Never pressure. If customer clearly says no, acknowledge and end the call politely.
- Switch to English if customer does.
- If after 2 follow-ups the response is still unclear, offer to transfer to a human agent.
- End with "Dhanyawaad, aapka din shubh ho" or English equivalent.

Do NOT discuss: discounts outside what the order shows, stock availability for other items, promotional offers, other products. Focus only on THIS order.`;

const AGENT_BODY = {
  agent_config: {
    agent_name: AGENT_NAME,
    agent_welcome_message: WELCOME,
    webhook_url: `${SERVER_URL}/webhook/bolna/call-event`,
    tasks: [
      {
        task_type: 'conversation',
        toolchain: { execution: 'parallel', pipelines: [['transcriber', 'llm', 'synthesizer']] },
        task_config: {
          hangup_after_silence: 15,
          call_terminate: 300,
          optimize_latency: true,
          incremental_delay: 600,
          interruption_backoff_period: 0,
          number_of_words_for_interruption: 1,
          use_fillers: false,
          backchanneling: false,
          ambient_noise: false,
          voicemail: false,
          check_if_user_online: true,
          check_user_online_message: 'Hello, are you still there?',
          trigger_user_online_message_after: 8,
          hangup_after_LLMCall: true,
          generate_precise_transcript: true,
        },
        tools_config: {
          // Default Bolna telephony (Plivo). Switch to `exotel` after KYC
          // by PATCHing agent `telephony_provider: 'sip-trunk'` and binding
          // your Exotel account under platform.bolna.ai/settings.
          input: { format: 'wav', provider: 'plivo' },
          output: { format: 'wav', provider: 'plivo' },
          llm_agent: {
            agent_type: 'simple_llm_agent',
            agent_flow_type: 'streaming',
            llm_config: {
              provider: 'azure',
              family: 'openai',
              model: 'azure/gpt-4.1-mini',
              temperature: 0.6,
              top_p: 0.9,
              min_p: 0.1,
              max_tokens: 358,
              presence_penalty: 0.0,
              frequency_penalty: 0.0,
              agent_flow_type: 'streaming',
              request_json: false,
            },
          },
          // THE MAIN EVENT — Sarvam Bulbul v3 for native Hindi/Hinglish prosody
          synthesizer: {
            stream: true,
            caching: true,
            provider: 'sarvam',
            buffer_size: 219,
            audio_format: 'wav',
            provider_config: {
              model: 'bulbul:v3',
              voice: 'priya',
              voice_id: 'priya',
              language: 'hi-IN',
              speed: 1.0,
              pitch: 0.0,
              loudness: 1.0,
            },
          },
          // Sarvam Saaras v3 — far better Hinglish code-switch than Deepgram nova-2
          transcriber: {
            task: 'transcribe',
            provider: 'sarvam',
            model: 'saaras:v3',
            language: 'hi',
            stream: true,
            encoding: 'linear16',
            sampling_rate: 16000,
            endpointing: 250,
            keywords: `${STORE_NAME}, Priya, COD, Namaste, Dhanyawaad`,
          },
          // See file-level comment #2 for why api_tools is left null.
        },
      },
    ],
  },
  agent_prompts: {
    task_1: { system_prompt: SYSTEM_PROMPT },
  },
};

// Dispositions = post-call LLM classification. Bolna reads the full transcript
// after hangup and decides which option matches, then includes the result in
// the final webhook payload. Cheap, reliable, language-agnostic.
const DISPOSITIONS = [
  {
    name: 'COD Outcome',
    category: 'Outcome',
    question: "Read the customer's final intent. Did they clearly confirm (accept the order for delivery), clearly cancel (refuse the order), explicitly ask to speak with a human agent, or ask us to call back later? Choose exactly one option.",
    is_objective: true,
    objective_options: [
      { value: 'confirmed',          condition: 'Customer clearly accepted the COD order for delivery (said haan / yes / theek hai / kar do / bhej do / sahi hai / ji / confirm).' },
      { value: 'cancelled',          condition: 'Customer clearly refused the order (said nahi / cancel / mujhe nahi chahiye / mana / galti se / any negation).' },
      { value: 'agent_needed',       condition: 'Customer asked for a human agent / representative, or asked a question we could not answer (size exchange, specific refund timing, etc.).' },
      { value: 'callback_requested', condition: 'Customer was busy and asked to be called back later.' },
      { value: 'unclear',            condition: 'The call ended without a clear outcome — no confirmation, no cancellation, no agent request, no callback.' },
    ],
  },
  {
    name: 'Cancellation Reason',
    category: 'Context',
    question: 'If the customer cancelled the order, summarize the reason they gave in 1-2 words. If they did not cancel, answer "N/A".',
    is_subjective: true,
  },
  {
    name: 'Callback Time',
    category: 'Context',
    question: 'If the customer asked for a callback, what time did they request? If they did not ask for a callback, answer "N/A".',
    is_subjective: true,
  },
];

async function main() {
  console.log('Creating Bolna agent...');
  let res = await fetch(`${BOLNA_API_BASE}/v2/agent`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${BOLNA_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(AGENT_BODY),
  });
  let text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = text; }
  if (!res.ok) {
    console.error(`POST /v2/agent failed ${res.status}:`);
    console.error(typeof json === 'string' ? json : JSON.stringify(json, null, 2));
    process.exit(1);
  }
  const agentId = json.agent_id || json.id;
  console.log('✓ Agent created:', agentId);

  console.log('\nAttaching dispositions for post-call classification...');
  res = await fetch(`${BOLNA_API_BASE}/dispositions/bulk`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${BOLNA_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ agent_id: agentId, dispositions: DISPOSITIONS }),
  });
  text = await res.text();
  try { json = JSON.parse(text); } catch { json = text; }
  if (!res.ok) {
    console.warn(`POST /dispositions/bulk failed ${res.status}:`, json);
    console.warn('(Non-fatal — the agent still works, just without auto-classification. Add manually in dashboard.)');
  } else {
    console.log('✓ Dispositions attached:', json.ids || json);
  }

  console.log('\n=====');
  console.log('BOLNA_AGENT_ID=' + agentId);
  console.log('=====');
  console.log('\nPaste into .env and restart ai-voice-agent.service.');
  console.log('Test call via: https://platform.bolna.ai/agents/' + agentId + ' (Playground button)');
}

main().catch(err => { console.error(err); process.exit(1); });
