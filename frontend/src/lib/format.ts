// Cell formatting + sort comparison for dynamic TaxSEA result tables (issue #16). Collection
// schemas aren't known at build time, so "is this a p-value column" is a name heuristic, not a
// hardcoded column list: anything whose name contains "pvalue" or "fdr" (case-insensitive).
const PVALUE_LIKE_RE = /pvalue|fdr/i;

export function isPValueLike(columnName: string): boolean {
  return PVALUE_LIKE_RE.test(columnName);
}

function formatSigFig(value: number, sigFigs: number): string {
  if (value === 0) return '0';
  return value.toPrecision(sigFigs);
}

/** null -> em dash. Numbers in p-value/FDR-like columns go exponential below 1e-3 magnitude;
 * everything else (including other numerics) renders to 3 significant figures. Non-numeric
 * values render as-is via String() -- an unexpected extra column still renders. */
export function formatCell(columnName: string, value: number | string | null | undefined): string {
  if (value === null || value === undefined) return '—';
  if (typeof value !== 'number') return String(value);
  if (isPValueLike(columnName) && value !== 0 && Math.abs(value) < 1e-3) {
    return value.toExponential(1);
  }
  return formatSigFig(value, 3);
}

type Cell = number | string | null | undefined;

/** Ascending comparator for two non-null cell values. Exported for reuse as a TanStack Table
 * `sortFn` (ResultTable.tsx) so both the hand-rolled and table-library sort paths agree. */
export function compareValues(a: number | string, b: number | string): number {
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  return String(a).localeCompare(String(b));
}

/** Sorts rows by `column`, ascending or descending. Nulls/undefined always sort last, in
 * either direction, so flipping direction never surfaces missing values first. */
export function sortRows<T extends Record<string, Cell>>(rows: T[], column: string, dir: 'asc' | 'desc'): T[] {
  const factor = dir === 'asc' ? 1 : -1;
  return [...rows].sort((a, b) => {
    const av = a[column];
    const bv = b[column];
    const aNil = av === null || av === undefined;
    const bNil = bv === null || bv === undefined;
    if (aNil || bNil) return aNil && bNil ? 0 : aNil ? 1 : -1;
    return factor * compareValues(av, bv);
  });
}
