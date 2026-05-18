/**
 * Shop allowlist gate. In beta we restrict incoming webhooks to a configured
 * allowlist so that an accidental webhook from another store (or a malicious
 * one that can forge our HMAC, unlikely but cheap mitigation) doesn't trigger
 * real calls.
 *
 * Set ALLOWED_SHOPS in .env as comma-separated shop domains:
 *   ALLOWED_SHOPS=your-shop.myshopify.com,another-store.myshopify.com
 *
 * If unset, defaults to open (all shops allowed) — matches legacy behavior.
 */

const parsed = (() => {
  const raw = process.env.ALLOWED_SHOPS || '';
  const list = raw.split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  return list;
})();

export const ALLOWED_SHOPS = parsed;
export const ALLOWLIST_ACTIVE = parsed.length > 0;

export function isShopAllowed(shop) {
  if (!ALLOWLIST_ACTIVE) return true; // no list = open
  if (!shop) return false;
  return parsed.includes(String(shop).trim().toLowerCase());
}

/**
 * Per-shop branding (the name Priya speaks + the category that flows into
 * the system prompt). Single env var with a JSON map so the whole catalog
 * of tenants is in one place:
 *
 *   STORE_BRANDING={"f51039.myshopify.com":{"name":"Urban Classics Store","category":"online store"},"ys4n0u-ys.myshopify.com":{"name":"Storico","category":"online store"}}
 *
 * Falls back to single-tenant STORE_NAME / STORE_CATEGORY env for shops
 * not in the map (keeps legacy single-tenant deploys working). Returns
 * empty strings as last resort — the prompt builder handles "our store"
 * defaults beyond that.
 *
 * For 10+ stores we'll outgrow env-var JSON and want a Shopify
 * metafield-based lookup at dispatch time. At 2–5 stores this is fine.
 */
const brandingMap = (() => {
  const raw = process.env.STORE_BRANDING || '';
  if (!raw) return {};
  try {
    const m = JSON.parse(raw);
    // Normalise keys to lowercase so lookups are case-insensitive.
    const out = {};
    for (const [k, v] of Object.entries(m)) {
      if (v && typeof v === 'object') {
        out[String(k).trim().toLowerCase()] = {
          name:     String(v.name     || '').trim(),
          category: String(v.category || '').trim(),
        };
      }
    }
    return out;
  } catch (err) {
    console.warn('[shops] STORE_BRANDING is not valid JSON — falling back to STORE_NAME / STORE_CATEGORY:', err.message);
    return {};
  }
})();

export function getShopBranding(shop) {
  const key = String(shop || '').trim().toLowerCase();
  const hit = brandingMap[key];
  return {
    name:     hit?.name     || process.env.STORE_NAME     || '',
    category: hit?.category || process.env.STORE_CATEGORY || '',
  };
}
