/** Tiny defensive helpers shared by the adapters. */

export function str(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}

export function parseTs(v: unknown): number {
  const t = typeof v === 'string' ? Date.parse(v) : NaN;
  return Number.isNaN(t) ? 0 : t;
}

export function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}
