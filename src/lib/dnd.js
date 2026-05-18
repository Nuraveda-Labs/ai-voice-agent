/**
 * Do-Not-Disturb window enforcement for Indian telecom compliance.
 *
 * TRAI (Telecom Regulatory Authority of India) restricts commercial voice
 * calls to 09:00–21:00 IST. Calling outside this window on a DLT-registered
 * DID risks carrier action against the trunk. Applies to *all* promotional/
 * transactional voice traffic including order confirmations.
 *
 * Additionally we enforce our own buffer (09:05) to avoid clock-drift and
 * simultaneous-dial-storm risk at exactly 09:00:00.
 *
 * Policy: if the requested scheduledAt falls inside [21:00, 09:05) IST,
 * roll forward to 09:05 IST the next valid day.
 */

const IST_OFFSET_MIN = 5 * 60 + 30; // IST = UTC+05:30

const DEFAULT_START_HOUR = Number(process.env.DND_START_HOUR ?? 21);   // 21:00 IST — DND begins
const DEFAULT_END_HOUR   = Number(process.env.DND_END_HOUR   ?? 9);    // 09:00 IST — DND ends
const RESUME_MIN         = Number(process.env.DND_RESUME_MINUTE ?? 5); // 09:05 IST

/**
 * Convert a UTC Date to the same wall-clock moment in IST, returned as
 * a Date where the getFullYear/getMonth/getHours/etc. reflect IST values.
 * (Node Date objects carry only UTC internally; this is a shifted view.)
 */
function toIstView(utc) {
  return new Date(utc.getTime() + IST_OFFSET_MIN * 60_000);
}
function fromIstView(ist) {
  return new Date(ist.getTime() - IST_OFFSET_MIN * 60_000);
}

/**
 * Return true if `when` (UTC) falls inside the DND window.
 */
export function isDnd(when, { startHour = DEFAULT_START_HOUR, endHour = DEFAULT_END_HOUR } = {}) {
  const ist = toIstView(when);
  const h = ist.getUTCHours();
  const m = ist.getUTCMinutes();
  // DND = [startHour:00, 24:00) ∪ [00:00, endHour:RESUME_MIN)
  if (h >= startHour) return true;
  if (h < endHour) return true;
  if (h === endHour && m < RESUME_MIN) return true;
  return false;
}

/**
 * If `when` is in the DND window, return the next safe call time (09:05 IST
 * on the appropriate day). Otherwise return `when` unchanged.
 */
export function adjustForDnd(when, opts = {}) {
  if (!isDnd(when, opts)) return when;
  const endHour = opts.endHour ?? DEFAULT_END_HOUR;
  const ist = toIstView(when);
  // If we're past midnight but still before end-hour, the resume is today at 09:05 IST.
  // If we're past end-hour (i.e. after 21:00), resume is tomorrow at 09:05 IST.
  const h = ist.getUTCHours();
  const resumeIst = new Date(Date.UTC(
    ist.getUTCFullYear(),
    ist.getUTCMonth(),
    ist.getUTCDate() + (h >= (opts.startHour ?? DEFAULT_START_HOUR) ? 1 : 0),
    endHour,
    RESUME_MIN,
    0,
  ));
  return fromIstView(resumeIst);
}

/**
 * Build the target schedule time from a base "now" and an intended offset in ms.
 * Wraps in DND adjustment automatically.
 */
export function computeScheduledAt(now, offsetMs, opts) {
  const raw = new Date(now.getTime() + offsetMs);
  return adjustForDnd(raw, opts);
}
