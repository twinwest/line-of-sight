import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Codex keeps the model list its own picker shows in this cache, refreshed by
// the CLI itself. Undocumented (SPIKE_NOTES 2026-10-02): anything unexpected
// reads as "unknown", never an error.
const MODELS_CACHE = path.join(os.homedir(), '.codex', 'models_cache.json');

/** Slugs Codex lists in its own model picker, in its order; [] if unknown. */
export function codexModels(file = MODELS_CACHE): string[] {
  try {
    const { models } = JSON.parse(fs.readFileSync(file, 'utf8')) as { models?: unknown };
    if (!Array.isArray(models)) return [];
    return (models as ({ slug?: unknown; visibility?: unknown } | null)[]).flatMap((m) =>
      typeof m?.slug === 'string' && m.visibility === 'list' ? [m.slug] : []);
  } catch {
    return [];
  }
}
