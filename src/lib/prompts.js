/**
 * Prompt-template loading — engine utility used by profile agent modules.
 *
 * Two-file pattern (open engine, closed prompts): for each language a profile
 * ships `<basename>.example.txt` (committed, generic demo) and optionally
 * `<basename>.txt` (gitignored, production-tuned). Loader prefers the real
 * file and falls back to the demo with a console warning so the engine stays
 * runnable end-to-end for anyone who clones it.
 *
 * Cached per (profileDir, basename) so repeated calls inside a session don't
 * hit the filesystem. Cache is process-lifetime — restart to pick up edits.
 */
import { readFileSync, existsSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';

const cache = new Map();

export function loadPromptTemplate(profileDir, basename) {
  const key = `${profileDir}::${basename}`;
  if (cache.has(key)) return cache.get(key);
  const real = resolvePath(profileDir, 'prompts', `${basename}.txt`);
  const demo = resolvePath(profileDir, 'prompts', `${basename}.example.txt`);
  let path;
  if (existsSync(real)) {
    path = real;
  } else if (existsSync(demo)) {
    path = demo;
    console.warn(`[prompts] Using demo fallback ${demo} — copy to ${basename}.txt and tune for production.`);
  } else {
    throw new Error(`[prompts] Missing both ${real} and ${demo}`);
  }
  const text = readFileSync(path, 'utf8');
  cache.set(key, text);
  return text;
}

export function renderTemplate(tmpl, vars) {
  return tmpl.replace(/\{\{(\w+)\}\}/g, (_, key) => (key in vars ? vars[key] : `{{${key}}}`));
}
