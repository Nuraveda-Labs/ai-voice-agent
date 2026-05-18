/**
 * fetch() wrapper with a hard AbortController timeout. Raw fetch in Node 20+
 * has no client-side timeout — if a TCP connection stalls (Shopify API hiccup,
 * LiveKit Cloud degraded, Vobiz routing issue), the request hangs forever,
 * starving the Express event loop of available sockets.
 *
 * All outbound HTTP calls in server.js should use fetchWithTimeout, not raw
 * fetch. Default timeout 15s is chosen to be longer than p99 Shopify GraphQL
 * response (~2s) and LiveKit SIP create (~3s) but short enough to surface
 * hangs before systemd's own watchdog.
 */

export async function fetchWithTimeout(url, opts = {}, timeoutMs = 15_000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(new Error(`fetch timeout after ${timeoutMs}ms`)), timeoutMs);
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}
