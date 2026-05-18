/**
 * Profile registry — auto-discovers profiles/<id>/profile.json at boot and
 * indexes them by id.
 *
 * Profiles are the unit of multi-tenancy for use cases (not stores): one
 * profile per agent persona × use-case (ai-voice-agent, lead-qualify,
 * appointment-remind, ...). The engine reads from this registry to:
 *   - validate POST /calls/dispatch requests against known profile ids
 *   - look up the prompt template + tools + voice config when the scheduler
 *     dispatches a ScheduledCall row (phase 3)
 *
 * The registry is loaded once at process start. To add a profile at runtime,
 * restart the service — there is no hot-reload (and no need: profile.json
 * changes are infrequent and warrant a restart for safety anyway).
 */
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join, resolve as resolvePath, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const PROFILES_DIR = resolvePath(dirname(fileURLToPath(import.meta.url)), '..', '..', 'profiles');

let registry = null;

function loadRegistry() {
  const byId = new Map();
  if (!existsSync(PROFILES_DIR)) {
    console.warn(`[profiles] profiles directory not found at ${PROFILES_DIR}`);
    return byId;
  }
  for (const entry of readdirSync(PROFILES_DIR)) {
    const dir = join(PROFILES_DIR, entry);
    let st;
    try { st = statSync(dir); } catch { continue; }
    if (!st.isDirectory()) continue;
    const profileJsonPath = join(dir, 'profile.json');
    if (!existsSync(profileJsonPath)) continue;
    let profile;
    try {
      profile = JSON.parse(readFileSync(profileJsonPath, 'utf8'));
    } catch (err) {
      console.error(`[profiles] failed to parse ${profileJsonPath}:`, err.message);
      continue;
    }
    if (!profile.id) {
      console.error(`[profiles] ${profileJsonPath} missing "id" — skipping`);
      continue;
    }
    if (profile.id !== entry) {
      console.warn(`[profiles] ${profileJsonPath} id="${profile.id}" does not match directory name "${entry}" — using id`);
    }
    if (byId.has(profile.id)) {
      console.error(`[profiles] duplicate profile id "${profile.id}" — keeping first, skipping ${profileJsonPath}`);
      continue;
    }
    byId.set(profile.id, { ...profile, _dir: dir });
  }
  return byId;
}

export function getRegistry() {
  if (!registry) registry = loadRegistry();
  return registry;
}

export function getProfile(id) {
  return getRegistry().get(id) || null;
}

export function listProfiles() {
  return Array.from(getRegistry().values()).map(p => ({
    id: p.id,
    name: p.name,
    languages: p.languages,
    defaultLanguage: p.defaultLanguage,
    tools: (p.tools || []).map(t => t.name),
    triggers: (p.triggers || []).map(t => t.type),
  }));
}
