// Minimal line diff for Edit tool renders: trim common prefix/suffix lines,
// show the changed middle as del/add with a little surviving context.
// ponytail: no LCS — Edit old/new strings are exact replacements where the
// interesting part is the middle; upgrade to a real diff lib if ever needed.

export interface DiffLine {
  kind: 'ctx' | 'del' | 'add' | 'skip';
  text: string;
}

const CONTEXT = 2;

export function diffLines(oldText: string, newText: string): DiffLine[] {
  const a = oldText.split('\n');
  const b = newText.split('\n');
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre
      && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;

  const out: DiffLine[] = [];
  if (pre > CONTEXT) out.push({ kind: 'skip', text: `… ${pre - CONTEXT} unchanged lines` });
  for (const line of a.slice(Math.max(0, pre - CONTEXT), pre)) out.push({ kind: 'ctx', text: line });
  for (const line of a.slice(pre, a.length - suf)) out.push({ kind: 'del', text: line });
  for (const line of b.slice(pre, b.length - suf)) out.push({ kind: 'add', text: line });
  for (const line of a.slice(a.length - suf, a.length - suf + CONTEXT)) out.push({ kind: 'ctx', text: line });
  if (suf > CONTEXT) out.push({ kind: 'skip', text: `… ${suf - CONTEXT} unchanged lines` });
  return out;
}
