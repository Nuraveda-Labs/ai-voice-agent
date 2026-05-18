/**
 * Glitch Voice — generic LiveKit voice agent worker (engine).
 *
 * Long-running worker process. Registers with LiveKit Cloud, subscribes to
 * dispatch requests, and handles each inbound call with a profile-driven
 * agent. The engine itself is profile-agnostic: STT/TTS/LLM construction,
 * SIP audio handling, VAD, AEC, turn-detection, voicemail detection,
 * auto-hangup, and transcript persistence live here. The agent's
 * personality, prompt, tools, and welcome message are imported from the
 * per-call profile's `agent.js` module (e.g. profiles/ai-voice-agent/agent.js).
 *
 * The profile id arrives as a LiveKit participant attribute (`profile`)
 * set by trigger-livekit-call.js. Falls back to `ai-voice-agent` for legacy
 * dispatches that pre-date the multi-profile rollout.
 *
 * Architecture + idioms follow @livekit/agents v1.2.x Node.js patterns.
 * Upstream: https://github.com/livekit/agents-js — @livekit/agents@1.2.6.
 */

import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  cli,
  defineAgent,
  ServerOptions,
  voice,
} from '@livekit/agents';
import * as silero from '@livekit/agents-plugin-silero';
import * as livekit from '@livekit/agents-plugin-livekit';
import * as sarvam from '@livekit/agents-plugin-sarvam';
import * as elevenlabs from '@livekit/agents-plugin-elevenlabs';
import * as openai from '@livekit/agents-plugin-openai';
import { RoomServiceClient } from 'livekit-server-sdk';
import { getProfile } from './lib/profiles.js';

const WEBHOOK_BASE = process.env.COD_CONFIRM_WEBHOOK_BASE
  || 'https://your-domain.com/ai-voice-agent';
const TOOL_SECRET = process.env.LIVEKIT_TOOL_SECRET || '';
const DEFAULT_PROFILE_ID = process.env.DEFAULT_AGENT_PROFILE || 'ai-voice-agent';

// STT provider factory. Sarvam Saaras v3 is best-in-class for Hindi /
// Hinglish but is hi-IN-only — it transliterates pure-English audio into
// Devanagari nonsense (real test call to a +1 number: customer said
// "hello", STT produced "हेलो"-like garbage and the LLM had nothing
// transcribable to respond to).
//
// For en-IN we use OpenAI's Whisper-based STT (gpt-4o-transcribe — the
// successor to whisper-1 — handles Indian-accented English and code-mix
// well enough for our domain). OpenAI plugin is already a dependency for
// the LLM, so no new install.
function buildSTT(lang) {
  if (lang === 'en-IN') {
    console.log(`[stt] provider=openai model=gpt-4o-transcribe lang=${lang}`);
    return new openai.STT({
      model: 'gpt-4o-transcribe',
      language: 'en',
      detectLanguage: false,
    });
  }
  console.log(`[stt] provider=sarvam model=saaras:v3 lang=${lang}`);
  return new sarvam.STT({
    model: 'saaras:v3',
    languageCode: 'hi-IN',
  });
}

// TTS provider factory. Provider choice is engine-level (cost/quality/outage
// is a deployment concern, not a profile concern). Per-profile voice tuning
// (voiceId, model) will move into profile.json in a later phase; for now,
// env vars stay the lever.
function buildTTS(lang) {
  const provider = (process.env.TTS_PROVIDER || 'elevenlabs').toLowerCase();
  if (provider === 'elevenlabs') {
    const voiceId = process.env.ELEVENLABS_VOICE_ID;
    if (!voiceId) {
      throw new Error('TTS_PROVIDER=elevenlabs but ELEVENLABS_VOICE_ID is not set');
    }
    console.log(`[tts] provider=elevenlabs voice=${voiceId} lang=${lang}`);
    return new elevenlabs.TTS({
      voiceId,
      model: process.env.ELEVENLABS_MODEL || 'eleven_turbo_v2_5',
      language: lang,
      encoding: 'pcm_8000',
    });
  }
  console.log(`[tts] provider=sarvam speaker=neha lang=${lang}`);
  return new sarvam.TTS({
    model: 'bulbul:v3',
    speaker: 'neha',
    targetLanguageCode: lang,
    pace: 1.0,
    sampleRate: 8000,
  });
}

// Profile-module cache: import once per (profileId, worker process).
const profileModuleCache = new Map();
async function loadProfileModule(profileId) {
  if (profileModuleCache.has(profileId)) return profileModuleCache.get(profileId);
  const profile = getProfile(profileId);
  if (!profile) {
    throw new Error(`[profile] unknown profile "${profileId}" — check profiles/<id>/profile.json`);
  }
  const agentPath = `${profile._dir}/agent.js`;
  const mod = await import(pathToFileURL(agentPath).href);
  for (const fn of ['renderContext', 'buildSystemPrompt', 'buildWelcome', 'buildTools', 'turnPersistKey']) {
    if (typeof mod[fn] !== 'function') {
      throw new Error(`[profile] ${agentPath} is missing required export "${fn}"`);
    }
  }
  if (!(mod.TERMINAL_TOOLS instanceof Set)) {
    throw new Error(`[profile] ${agentPath} must export TERMINAL_TOOLS as a Set<string>`);
  }
  console.log(`[profile] loaded "${profileId}" from ${agentPath} (tools: ${[...mod.TERMINAL_TOOLS].join(', ')})`);
  const cached = { profile, ...mod };
  profileModuleCache.set(profileId, cached);
  return cached;
}

// Voicemail detection — engine-level, applies to every profile. Real call
// #2953 (Storico) burned 2 minutes pitching to a voicemail recording before
// we added this. Patterns are broad: partial match anywhere in any of the
// first 4 user transcripts triggers an immediate hangup.
const VOICEMAIL_PATTERNS = [
  /व[ोॉ]इस[\s\-]*मे/,
  /फ[ॉो]रवर्डेड\s+टू/,
  /न[ॉो]ट\s+अव[ेै]लेबल/,
  /रिक[ॉो]र्ड\s+य[ोौ]र\s+म[ैे]सेज/,
  /लीव\s+अ\s+म[ैे]सेज/,
  /एट\s+द\s+ट[ोौ]न/,
  /आफ्टर\s+द\s+बीप/,
  /व्हेन\s+य[ोौ]\s+ह[ैै]व\s+फिनिश्ड/,
  /इस\s+समय\s+उपलब्ध\s+नहीं/,
  /कृपया\s+संदेश\s+छोड़/,
  /voicemail|voice\s*mail/i,
  /answering\s*machine/i,
  /please\s+(record|leave)\s+(your\s+)?(message|name)/i,
  /(after|at)\s+the\s+(tone|beep)/i,
];

export default defineAgent({
  prewarm: async (proc) => {
    proc.userData.vad = await silero.VAD.load({
      sampleRate: 8000,
      minSilenceDuration: 400,
    });
    const warmupHosts = [
      'https://api.sarvam.ai/',
      'https://api.elevenlabs.io/v1/models',
      'https://api.openai.com/v1/models',
    ];
    await Promise.all(warmupHosts.map(async (url) => {
      try {
        const controller = new AbortController();
        const t = setTimeout(() => controller.abort(), 4000);
        await fetch(url, { method: 'HEAD', signal: controller.signal }).catch(() => {});
        clearTimeout(t);
      } catch { /* best-effort */ }
    }));
    console.log('[prewarm] TLS/DNS warmed for Sarvam + ElevenLabs + OpenAI');
  },

  entry: async (ctx) => {
    await ctx.connect();

    // Dispatch metadata is set by trigger-livekit-call.js (createDispatch
    // metadata field) and includes the call's language hint. Reading it
    // BEFORE the AgentSession is constructed lets us pick the right STT
    // provider (Sarvam for Hindi, OpenAI for English) without a mid-call
    // STT swap. Falls back to hi-IN if metadata is missing or unparseable
    // (the production-default and 98% of ai-voice-agent traffic).
    let dispatchMeta = {};
    try {
      const raw = ctx.job?.metadata || ctx.room?.metadata || '';
      if (raw && typeof raw === 'string' && raw.trim().startsWith('{')) {
        dispatchMeta = JSON.parse(raw);
      }
    } catch (err) {
      console.warn('[dispatch-meta] could not parse:', err.message);
    }
    const initialLang = dispatchMeta.lang === 'en-IN' ? 'en-IN' : 'hi-IN';
    console.log(`[entry] dispatch lang=${initialLang} profile=${dispatchMeta.profile || '?'}`);

    const ctxMut = {
      v: {},
      lang: initialLang,
      turnIndex: 0,
      sipCallId: null,
      profileId: DEFAULT_PROFILE_ID,
      profileMod: null,
    };
    const roomName = ctx.room?.name || '';

    async function postTurn({ role, text, tool_name, tool_args, tool_result, stt_confidence }) {
      if (!ctxMut.profileMod || !roomName) return;
      const key = ctxMut.profileMod.turnPersistKey(ctxMut.v);
      if (!key) return; // sandbox / demo call without entity context — skip persistence
      const payload = {
        ...key,
        room_name:  roomName,
        sip_call_id: ctxMut.sipCallId,
        turn_index: ctxMut.turnIndex++,
        role,
        text:       text || '',
        lang:       ctxMut.lang,
        tool_name, tool_args, tool_result, stt_confidence,
        started_at: new Date().toISOString(),
      };
      try {
        const res = await fetch(`${WEBHOOK_BASE}/webhook/livekit/turn`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(TOOL_SECRET ? { 'X-COD-Tool-Secret': TOOL_SECRET } : {}),
          },
          body: JSON.stringify(payload),
        });
        if (!res.ok) {
          console.warn(`[turn-persist] HTTP ${res.status} for ${role} turn #${payload.turn_index}`);
        }
      } catch (err) {
        console.warn(`[turn-persist] fire-and-forget error on ${role} turn #${payload.turn_index}:`, err.message);
      }
    }

    const session = new voice.AgentSession({
      vad: ctx.proc.userData.vad,
      stt: buildSTT(initialLang),
      llm: new openai.LLM({
        model: 'gpt-4o-mini',
        temperature: 0.6,
        maxTokens: 60,
      }),
      tts: buildTTS(initialLang),
      turnDetection: new livekit.turnDetector.MultilingualModel(),
      preemptiveGeneration: true,
      aecWarmupDuration: 500,
      minInterruptionWords: 3,
      minInterruptionDuration: 600,
    });

    let terminalToolFired = false;
    let hangupTimer = null;
    let voicemailDetected = false;
    let userTurnCount = 0;
    const autoHangupMs = parseInt(process.env.AUTO_HANGUP_MS || '10000', 10);

    function hangupNow(reason) {
      const rn = ctx.room?.name;
      if (!rn) return;
      const lkUrl = process.env.LIVEKIT_URL;
      const lkKey = process.env.LIVEKIT_API_KEY;
      const lkSecret = process.env.LIVEKIT_API_SECRET;
      if (!lkUrl || !lkKey || !lkSecret) {
        console.warn(`[hangup] LIVEKIT_* env missing — cannot terminate room (${reason})`);
        return;
      }
      console.log(`[hangup] deleteRoom ${rn} — ${reason}`);
      const rs = new RoomServiceClient(lkUrl, lkKey, lkSecret);
      rs.deleteRoom(rn).catch(err =>
        console.log(`[hangup] deleteRoom (likely already closed): ${err.message}`)
      );
    }

    session.on(voice.AgentSessionEventTypes.UserInputTranscribed, (ev) => {
      if (!ev.isFinal) return;
      const transcript = ev.transcript || '';
      console.log(`[user] ${transcript}`);
      userTurnCount++;

      if (!voicemailDetected && userTurnCount <= 4) {
        const matched = VOICEMAIL_PATTERNS.find(p => p.test(transcript));
        if (matched) {
          voicemailDetected = true;
          console.log(`[voicemail] detected on user turn #${userTurnCount}: "${transcript}" (matched ${matched})`);
          postTurn({
            role: 'tool',
            text: 'voicemail_detected',
            tool_name: 'voicemail_detected',
            tool_args: { transcript },
            tool_result: 'hangup',
          });
          hangupNow('voicemail detected');
          return;
        }
      }

      postTurn({
        role: 'user',
        text: transcript,
        stt_confidence: typeof ev.confidence === 'number' ? ev.confidence : undefined,
      });
    });

    session.on(voice.AgentSessionEventTypes.ConversationItemAdded, (ev) => {
      if (ev.item?.role !== 'assistant') return;
      const text = ev.item.textContent ?? '';
      console.log(`[assistant] ${text.slice(0, 200)}`);
      postTurn({ role: 'assistant', text });

      if (terminalToolFired && !hangupTimer) {
        const rn = ctx.room?.name;
        hangupTimer = setTimeout(async () => {
          try {
            if (!rn) return;
            const lkUrl = process.env.LIVEKIT_URL;
            const lkKey = process.env.LIVEKIT_API_KEY;
            const lkSecret = process.env.LIVEKIT_API_SECRET;
            if (!lkUrl || !lkKey || !lkSecret) {
              console.warn('[auto-hangup] LIVEKIT_* env missing — cannot terminate room');
              return;
            }
            console.log(`[auto-hangup] deleting room ${rn} after farewell — VoIP-minutes guard (${autoHangupMs}ms)`);
            const rs = new RoomServiceClient(lkUrl, lkKey, lkSecret);
            await rs.deleteRoom(rn);
          } catch (err) {
            console.log(`[auto-hangup] deleteRoom (likely already closed): ${err.message}`);
          }
        }, autoHangupMs);
      }
    });

    session.on(voice.AgentSessionEventTypes.FunctionToolsExecuted, (ev) => {
      const calls = ev.functionCalls || [];
      console.log('[tool]', calls.map(c => c.name).join(',') || '?');
      for (const c of calls) {
        postTurn({
          role:        'tool',
          text:        c.name || '',
          tool_name:   c.name,
          tool_args:   c.arguments ?? c.args ?? undefined,
          tool_result: typeof c.result === 'string' ? c.result : (c.result ? JSON.stringify(c.result) : undefined),
        });
        if (ctxMut.profileMod && ctxMut.profileMod.TERMINAL_TOOLS.has(c.name)) {
          terminalToolFired = true;
          console.log(`[auto-hangup] armed after terminal tool: ${c.name}`);
        }
      }
    });

    session.on(voice.AgentSessionEventTypes.Close, () => {
      if (hangupTimer) {
        clearTimeout(hangupTimer);
        hangupTimer = null;
      }
      console.log(`[livekit-agent] session closed after ${ctxMut.turnIndex} turns`);
    });

    // Serial start (the previous parallel-start attempt killed AgentActivity
    // before updateAgent could land — see git history for the bug). With TLS
    // prewarmed, serial cold-start is ~3-5s and the welcome reliably plays.
    const participant = await ctx.waitForParticipant();
    const attrs = participant.attributes || {};

    ctxMut.profileId = attrs.profile || DEFAULT_PROFILE_ID;
    ctxMut.lang = attrs.language === 'en-IN' ? 'en-IN' : 'hi-IN';
    ctxMut.sipCallId = attrs.sip_call_id || null;

    let profileMod;
    try {
      profileMod = await loadProfileModule(ctxMut.profileId);
    } catch (err) {
      console.error(`[profile] failed to load "${ctxMut.profileId}":`, err.message);
      hangupNow(`profile load failed: ${err.message}`);
      return;
    }
    ctxMut.profileMod = profileMod;

    ctxMut.v = profileMod.renderContext(attrs, ctxMut.lang, process.env);
    const v = ctxMut.v;
    const lang = ctxMut.lang;
    console.log(`[livekit-agent] profile=${ctxMut.profileId} call for ${v.customer_name || '(no name)'} / ${v.order_number || attrs.entity_ref || '-'} lang=${lang}`);

    const realAgent = new voice.Agent({
      instructions: profileMod.buildSystemPrompt(v, lang),
      tools:        profileMod.buildTools(v, { WEBHOOK_BASE, TOOL_SECRET }),
    });

    const coldStartMs = Date.now();
    await session.start({ agent: realAgent, room: ctx.room });
    console.log(`[cold-start] serial-start: ${Date.now() - coldStartMs}ms (TLS prewarmed)`);

    session.say(profileMod.buildWelcome(v, lang, process.env), { allowInterruptions: false });
  },
});

cli.runApp(
  new ServerOptions({
    agent: fileURLToPath(import.meta.url),
    agentName: process.env.LIVEKIT_AGENT_NAME || 'ai-voice-agent-priya',
    host: process.env.LIVEKIT_AGENT_HTTP_HOST || '127.0.0.1',
  }),
);
