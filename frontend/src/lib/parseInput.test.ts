import { describe, expect, it } from 'vitest';
import { parseInput } from './parseInput';

describe('parseInput enrichment mode', () => {
  it('parses tab-separated pairs', () => {
    const r = parseInput('Bifidobacterium_longum\t2.45\nRuminococcus_bromii\t-3.05', 'enrichment');
    expect(r.mode).toBe('enrichment');
    if (r.mode !== 'enrichment') throw new Error('unreachable');
    expect(r.errors).toEqual([]);
    expect(r.ranks).toEqual({ Bifidobacterium_longum: 2.45, Ruminococcus_bromii: -3.05 });
    expect(r.count).toBe(2);
  });

  it('parses comma-separated pairs', () => {
    const r = parseInput('Bifidobacterium_longum,2.45\nRuminococcus_bromii,-3.05', 'enrichment');
    if (r.mode !== 'enrichment') throw new Error('unreachable');
    expect(r.errors).toEqual([]);
    expect(r.ranks).toEqual({ Bifidobacterium_longum: 2.45, Ruminococcus_bromii: -3.05 });
  });

  it('parses whitespace-separated pairs, including multi-word names', () => {
    const r = parseInput('Bifidobacterium longum 2.45', 'enrichment');
    if (r.mode !== 'enrichment') throw new Error('unreachable');
    expect(r.errors).toEqual([]);
    expect(r.ranks).toEqual({ Bifidobacterium_longum: 2.45 });
  });

  it('strips wrapping quotes from fields', () => {
    const r = parseInput('"Bifidobacterium longum",2.45', 'enrichment');
    if (r.mode !== 'enrichment') throw new Error('unreachable');
    expect(r.errors).toEqual([]);
    expect(r.ranks).toEqual({ Bifidobacterium_longum: 2.45 });
  });

  it('keeps a quoted delimiter inside one field instead of mis-splitting the row', () => {
    // The embedded comma stays inside the quoted field (a 2-column split, not 3) —
    // still rejected because a comma isn't a valid taxon-name character (docs §5),
    // but the *split* itself must be correct.
    const r = parseInput('"Bifid,longum",2.45', 'enrichment');
    if (r.mode !== 'enrichment') throw new Error('unreachable');
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]?.message).toMatch(/invalid taxon name "Bifid,longum"/);
  });

  it('handles CRLF line endings', () => {
    const r = parseInput('Bifidobacterium_longum\t2.45\r\nRuminococcus_bromii\t-3.05\r\n', 'enrichment');
    if (r.mode !== 'enrichment') throw new Error('unreachable');
    expect(r.errors).toEqual([]);
    expect(r.ranks).toEqual({ Bifidobacterium_longum: 2.45, Ruminococcus_bromii: -3.05 });
  });

  it('auto-detects and skips a header row', () => {
    const r = parseInput('taxon\trank\nBifidobacterium_longum\t2.45', 'enrichment');
    if (r.mode !== 'enrichment') throw new Error('unreachable');
    expect(r.errors).toEqual([]);
    expect(r.ranks).toEqual({ Bifidobacterium_longum: 2.45 });
  });

  it('normalizes spaces in names to underscores', () => {
    const r = parseInput('Bifidobacterium longum\t2.45', 'enrichment');
    if (r.mode !== 'enrichment') throw new Error('unreachable');
    expect(r.ranks).toEqual({ Bifidobacterium_longum: 2.45 });
  });

  it('treats Bifidobacterium longum and Bifidobacterium_longum as the same taxon', () => {
    const r = parseInput('Bifidobacterium longum\t2.45\nBifidobacterium_longum\t9', 'enrichment');
    if (r.mode !== 'enrichment') throw new Error('unreachable');
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]?.message).toMatch(/duplicate taxon name "Bifidobacterium_longum"/);
  });

  it('skips blank lines and trims leading/trailing whitespace', () => {
    const r = parseInput('  Bifidobacterium_longum \t 2.45 \n\n\nRuminococcus_bromii\t-3.05\n', 'enrichment');
    if (r.mode !== 'enrichment') throw new Error('unreachable');
    expect(r.errors).toEqual([]);
    expect(r.count).toBe(2);
  });

  it('reports a line-numbered error for a non-numeric rank', () => {
    // Prefixed with a valid row so the malformed row isn't mistaken for a header
    // (header auto-detection only ever looks at the first data row).
    const r = parseInput('Good\t1\nBifidobacterium_longum\tnot-a-number', 'enrichment');
    if (r.mode !== 'enrichment') throw new Error('unreachable');
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]).toMatchObject({ line: 2, text: 'Bifidobacterium_longum\tnot-a-number' });
    expect(r.errors[0]?.message).toMatch(/invalid rank value/);
  });

  it('rejects non-finite ranks (NaN, Infinity)', () => {
    const r = parseInput('Good\t1\nA\tNaN\nB\tInfinity\nC\t-Infinity', 'enrichment');
    if (r.mode !== 'enrichment') throw new Error('unreachable');
    expect(r.errors).toHaveLength(3);
  });

  it('reports a line-numbered error for an invalid taxon name', () => {
    const r = parseInput('Bad;Name\t2.45', 'enrichment');
    if (r.mode !== 'enrichment') throw new Error('unreachable');
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]?.message).toMatch(/invalid taxon name/);
  });

  it('reports a line-numbered error when a row has only one column', () => {
    const r = parseInput('Good\t1\nJustAName', 'enrichment');
    if (r.mode !== 'enrichment') throw new Error('unreachable');
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]).toMatchObject({ line: 2 });
    expect(r.errors[0]?.message).toMatch(/expected two columns/);
  });

  it('collects multiple errors across lines rather than stopping at the first', () => {
    const r = parseInput('Good\t1\nBad;Name\t2\nGood2\tNaN', 'enrichment');
    if (r.mode !== 'enrichment') throw new Error('unreachable');
    expect(r.errors).toHaveLength(2);
    expect(r.errors.map((e) => e.line)).toEqual([2, 3]);
  });

  it('flags a taxa count below the minimum', () => {
    const r = parseInput('', 'enrichment');
    if (r.mode !== 'enrichment') throw new Error('unreachable');
    expect(r.count).toBe(0);
    expect(r.rangeError).toMatch(/between 1 and 5000/);
  });
});

describe('parseInput ORA mode', () => {
  it('parses one taxon per line', () => {
    const r = parseInput('Bifidobacterium_longum\nBacteroides_thetaiotaomicron', 'ora');
    if (r.mode !== 'ora') throw new Error('unreachable');
    expect(r.errors).toEqual([]);
    expect(r.taxa).toEqual(['Bifidobacterium_longum', 'Bacteroides_thetaiotaomicron']);
  });

  it('auto-detects and skips a header row', () => {
    const r = parseInput('taxon\nBifidobacterium_longum\nBacteroides_thetaiotaomicron', 'ora');
    if (r.mode !== 'ora') throw new Error('unreachable');
    expect(r.errors).toEqual([]);
    expect(r.taxa).toEqual(['Bifidobacterium_longum', 'Bacteroides_thetaiotaomicron']);
  });

  it('handles CRLF, blank lines, quoted values, and space normalization', () => {
    const r = parseInput('"Bifidobacterium longum"\r\n\r\nBacteroides_thetaiotaomicron\r\n', 'ora');
    if (r.mode !== 'ora') throw new Error('unreachable');
    expect(r.errors).toEqual([]);
    expect(r.taxa).toEqual(['Bifidobacterium_longum', 'Bacteroides_thetaiotaomicron']);
  });

  it('rejects a duplicate taxon name, naming the duplicate', () => {
    const r = parseInput('Bifidobacterium_longum\nBifidobacterium_longum', 'ora');
    if (r.mode !== 'ora') throw new Error('unreachable');
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]).toMatchObject({ line: 2 });
    expect(r.errors[0]?.message).toMatch(/duplicate taxon name "Bifidobacterium_longum"/);
  });

  it('reports a line-numbered error for an invalid taxon name', () => {
    const r = parseInput('Good_name\nBad;Name', 'ora');
    if (r.mode !== 'ora') throw new Error('unreachable');
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]).toMatchObject({ line: 2, text: 'Bad;Name' });
  });
});
