import { describe, expect, it } from 'vitest';
import { formatCell, isPValueLike, sortRows } from './format';

describe('isPValueLike', () => {
  it('matches columns containing "pvalue" or "fdr", case-insensitively', () => {
    expect(isPValueLike('PValue')).toBe(true);
    expect(isPValueLike('FDR')).toBe(true);
    expect(isPValueLike('adj.pvalue')).toBe(true);
    expect(isPValueLike('fdr_bh')).toBe(true);
  });

  it('does not match unrelated column names', () => {
    expect(isPValueLike('taxonSetName')).toBe(false);
    expect(isPValueLike('Test_statistic')).toBe(false);
    expect(isPValueLike('median_rank_of_set_members')).toBe(false);
  });
});

describe('formatCell', () => {
  it('renders null and undefined as an em dash', () => {
    expect(formatCell('FDR', null)).toBe('—');
    expect(formatCell('anything', undefined)).toBe('—');
  });

  it('renders non-numeric values as-is', () => {
    expect(formatCell('taxonSetName', 'MiMeDB_producers_of_GABA')).toBe('MiMeDB_producers_of_GABA');
  });

  it('formats p-value-like numbers below 1e-3 in exponential notation', () => {
    expect(formatCell('PValue', 3.4e-9)).toBe('3.4e-9');
    expect(formatCell('FDR', 1.2e-7)).toBe('1.2e-7');
  });

  it('formats p-value-like numbers at or above 1e-3 to 3 significant figures, not exponential', () => {
    expect(formatCell('FDR', 0.038)).toBe((0.038).toPrecision(3));
    expect(formatCell('PValue', 0.0021)).toBe((0.0021).toPrecision(3));
    expect(formatCell('FDR', 0.038)).not.toContain('e');
  });

  it('formats other (non-p-value-like) numerics to 3 significant figures regardless of magnitude', () => {
    expect(formatCell('median_rank_of_set_members', 1.85)).toBe((1.85).toPrecision(3));
    expect(formatCell('Test_statistic', 0.62)).toBe((0.62).toPrecision(3));
    // Deliberately tiny -- unlike a p-value column, this must NOT switch to exponential.
    expect(formatCell('Test_statistic', 3.4e-9)).toBe((3.4e-9).toPrecision(3));
  });

  it('formats zero as "0", not "0.0e+0"', () => {
    expect(formatCell('FDR', 0)).toBe('0');
    expect(formatCell('Test_statistic', 0)).toBe('0');
  });
});

describe('sortRows', () => {
  const rows = [
    { name: 'b', FDR: 0.5 },
    { name: 'a', FDR: 0.1 },
    { name: 'c', FDR: null },
  ];

  it('sorts ascending by a numeric column, with nulls last', () => {
    expect(sortRows(rows, 'FDR', 'asc').map((r) => r.name)).toEqual(['a', 'b', 'c']);
  });

  it('sorts descending by a numeric column, with nulls still last', () => {
    expect(sortRows(rows, 'FDR', 'desc').map((r) => r.name)).toEqual(['b', 'a', 'c']);
  });

  it('sorts ascending by a string column', () => {
    expect(sortRows(rows, 'name', 'asc').map((r) => r.name)).toEqual(['a', 'b', 'c']);
  });

  it('does not mutate the input array', () => {
    const copy = [...rows];
    sortRows(rows, 'FDR', 'asc');
    expect(rows).toEqual(copy);
  });
});
