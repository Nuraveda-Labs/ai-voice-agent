/**
 * Indian-phone normalization.
 *
 * Shopify checkout returns phones in many shapes:
 *   +91 98765 43210      (formatted E.164)
 *   919876543210         (no plus, with country code)
 *   09876543210          (leading zero, no country code)
 *   9876543210           (just 10 digits)
 *   +91-98765-43210      (dashes)
 *   91 9876543210        (space)
 *
 * Vobiz SIP trunks require strict E.164 (+[1-9]\d{6,14}). Anything else silently
 * 4xx-drops at the carrier with no useful signal to the app.
 *
 * Returns:
 *   string — valid E.164 on success
 *   null   — couldn't parse into a valid number
 */
export function normalizePhone(raw) {
  if (!raw) return null;
  let s = String(raw).trim();
  if (!s) return null;

  // Strip common formatting
  s = s.replace(/[\s\-()\.]/g, '');

  // Already starts with + — assume E.164 attempt
  if (s.startsWith('+')) {
    const digits = s.slice(1);
    if (!/^[1-9]\d{6,14}$/.test(digits)) return null;
    return '+' + digits;
  }

  // Leading 0 is an Indian trunk prefix — drop it
  if (s.startsWith('0')) s = s.slice(1);

  // If it starts with 91 and the remaining 10 digits look like an Indian mobile
  // (starts with 6-9), treat 91 as country code.
  if (s.startsWith('91') && s.length === 12 && /^[6-9]/.test(s.slice(2))) {
    return '+91' + s.slice(2);
  }

  // Bare 10-digit Indian mobile (starts with 6/7/8/9) — prepend +91
  if (s.length === 10 && /^[6-9]/.test(s)) {
    return '+91' + s;
  }

  // Bare 10-digit that's NOT an Indian mobile — ambiguous, reject.
  // (A valid international number without + should have a country code
  // making it longer than 10 digits.)
  if (s.length === 10) return null;

  // Longer digit strings: treat as "international without +", require
  // it matches E.164 shape.
  if (/^[1-9]\d{6,14}$/.test(s) && s.length > 10) {
    return '+' + s;
  }

  return null;
}

/**
 * Quick validation — true if the input looks like a valid Indian mobile
 * (+91 followed by 10 digits starting with 6-9).
 */
export function isIndianMobile(e164) {
  return typeof e164 === 'string' && /^\+91[6-9]\d{9}$/.test(e164);
}
