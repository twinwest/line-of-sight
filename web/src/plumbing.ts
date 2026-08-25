// CLI-plumbing user messages: transcript lines with role "user" that no human
// typed (<task-notification>, <command-name>, <local-command-stdout>, …).
// They must never render as user speech — provenance is the product.

export interface Plumbing {
  tag: string;
  /** Fold-row label, e.g. `Agent "Map demand signals" finished`. */
  label: string;
  /** Markdown body to render (task-notification results); null → show raw text. */
  result: string | null;
}

export function parsePlumbing(text: string): Plumbing | null {
  const t = text.trimStart();
  if (!t.startsWith('<')) return null;
  const tag = /^<([a-z][\w-]*)/i.exec(t)?.[1] ?? 'system';
  if (tag === 'task-notification') {
    const summary = /<summary>([\s\S]*?)<\/summary>/.exec(t)?.[1]?.trim();
    const result = /<result>([\s\S]*?)(?:<\/result>|$)/.exec(t)?.[1]?.trim() ?? null;
    return { tag, label: summary ?? tag, result };
  }
  return { tag, label: tag, result: null };
}
