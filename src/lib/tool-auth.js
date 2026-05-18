/**
 * Shared `requireToolAuth` middleware.
 *
 * All tool-callback endpoints (engine-side: /calls/dispatch,
 * /webhook/livekit/turn; profile-side: /webhook/livekit/tool/<name>) must
 * authenticate the LiveKit agent worker via the LIVEKIT_TOOL_SECRET shared
 * secret. Failing closed (503) when the secret isn't configured is
 * deliberate — these endpoints mutate state, so an unconfigured deploy
 * must reject everything rather than silently accept.
 *
 * Constant-time comparison via crypto.timingSafeEqual; identical-length
 * Buffers required before the compare to avoid leaking length via early
 * return.
 *
 * Counters (rejectCount) are optional — the engine wires its own counters
 * so /health can surface auth-failure rates without each profile having
 * to instrument its own.
 */
import crypto from 'node:crypto';

export function createToolAuth(env, rejectCount = {}) {
  const SECRET = (env.LIVEKIT_TOOL_SECRET || '').trim();

  return function requireToolAuth(req, res, next) {
    if (!SECRET) {
      console.warn('[tool-auth] LIVEKIT_TOOL_SECRET not configured — rejecting', req.path);
      return res.status(503).json({ ok: false, error: 'tool auth not configured' });
    }
    const got = (req.get('X-COD-Tool-Secret') || '').trim();
    if (!got) {
      rejectCount.tool_auth_missing = (rejectCount.tool_auth_missing || 0) + 1;
      return res.status(401).json({ ok: false, error: 'missing X-COD-Tool-Secret' });
    }
    const a = Buffer.from(got);
    const b = Buffer.from(SECRET);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      rejectCount.tool_auth_mismatch = (rejectCount.tool_auth_mismatch || 0) + 1;
      return res.status(401).json({ ok: false, error: 'invalid X-COD-Tool-Secret' });
    }
    next();
  };
}
