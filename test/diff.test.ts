import { describe, expect, it } from 'vitest';
import { diffLines } from '../web/src/diff.js';

const shape = (old: string, nw: string) =>
  diffLines(old, nw).map((l) => `${l.kind}:${l.text}`);

describe('diffLines', () => {
  it('shows del/add for the changed middle with context', () => {
    expect(shape('a\nb\nold\nc\nd', 'a\nb\nnew\nc\nd')).toEqual([
      'ctx:a', 'ctx:b', 'del:old', 'add:new', 'ctx:c', 'ctx:d',
    ]);
  });

  it('elides long unchanged runs', () => {
    const old = ['1', '2', '3', '4', '5', 'OLD', 'x'].join('\n');
    const nw = ['1', '2', '3', '4', '5', 'NEW', 'x'].join('\n');
    expect(shape(old, nw)).toEqual([
      'skip:… 3 unchanged lines', 'ctx:4', 'ctx:5', 'del:OLD', 'add:NEW', 'ctx:x',
    ]);
  });

  it('pure insertion and pure deletion', () => {
    expect(shape('a\nc', 'a\nb\nc')).toEqual(['ctx:a', 'add:b', 'ctx:c']);
    expect(shape('a\nb\nc', 'a\nc')).toEqual(['ctx:a', 'del:b', 'ctx:c']);
  });

  it('completely different content is all del/add', () => {
    expect(shape('x', 'y')).toEqual(['del:x', 'add:y']);
  });
});
