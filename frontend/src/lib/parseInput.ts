// Client-side parser + validator for pasted enrichment/ORA input.
//
// Mirrors the limits frozen in /docs/api.md §5 exactly (name pattern, taxa count,
// finite ranks, minSetSize/maxSetSize range) so the "submit disabled" reason the
// user sees matches what the server would reject — but the server still validates
// independently; this is a UX affordance, not a security boundary.

export type Mode = 'enrichment' | 'ora';

/** Same as docs/api.md §5. */
export const NAME_PATTERN = /^[A-Za-z0-9_. -]{1,200}$/;
export const MIN_TAXA = 1;
export const MAX_TAXA = 5000;
export const SET_SIZE_MIN = 2;
export const SET_SIZE_MAX = 1000;

export interface ParseError {
  /** 1-based line number in the original pasted text. */
  line: number;
  /** The offending raw text, for display. */
  text: string;
  message: string;
}

interface EnrichmentResult {
  mode: 'enrichment';
  ranks: Record<string, number>;
  count: number;
  errors: ParseError[];
  /** Whole-input error not tied to one line (e.g. taxa count out of range). */
  rangeError: string | null;
  /** Non-null when the input has more than 2 delimited columns: labels for the
   * rank-column picker. Nothing is parsed until the caller passes a `rankColumn`. */
  columns: string[] | null;
}

interface OraResult {
  mode: 'ora';
  taxa: string[];
  count: number;
  errors: ParseError[];
  rangeError: string | null;
}

export type ParseResult = EnrichmentResult | OraResult;

const ORA_HEADER_WORDS = new Set(['taxon', 'taxa', 'name', 'taxon_name', 'species', 'id', 'otu', 'otu_id']);

// Splits a line on `delim`, honoring double-quoted fields (with "" as an escaped
// quote), so a name like `"Some, name"` survives comma-delimited input intact.
// Passing a delimiter that can't appear in the line (used for ORA's single
// column) reuses this purely for quote-stripping.
function splitDelimited(line: string, delim: string): string[] {
  const fields: string[] = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQuotes) {
      if (c === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cur += c;
      }
    } else if (c === '"' && cur === '') {
      inQuotes = true;
    } else if (c === delim) {
      fields.push(cur);
      cur = '';
    } else {
      cur += c;
    }
  }
  fields.push(cur);
  return fields.map((f) => f.trim());
}

/** Space(s) -> underscore, so "Bifidobacterium longum" and "..._longum" collide. */
function normalizeName(raw: string): string {
  return raw.trim().replace(/\s+/g, '_');
}

function toFiniteNumber(raw: string): number | null {
  const trimmed = raw.trim();
  if (trimmed === '') return null;
  const n = Number(trimmed);
  return Number.isFinite(n) ? n : null;
}

function delimiterOf(line: string): string | null {
  if (line.includes('\t')) return '\t';
  if (line.includes(',')) return ',';
  return null;
}

/** How many tokens at the end of the line parse as finite numbers. */
function trailingNumericCount(tokens: string[]): number {
  let n = 0;
  for (let i = tokens.length - 1; i >= 0; i--) {
    if (toFiniteNumber(tokens[i] ?? '') === null) break;
    n++;
  }
  return n;
}

/** True for whitespace-separated input carrying more than one numeric column, e.g. a
 * DESeq2 table copied out of the R console. A name may itself contain spaces
 * ("Bifidobacterium longum 2.45"), so token count alone can't tell the two apart —
 * but two or more *numeric* trailing tokens can only be multiple numeric columns. */
function isAmbiguousWhitespaceRow(line: string): boolean {
  return delimiterOf(line) === null && trailingNumericCount(line.trim().split(/\s+/)) > 1;
}

/** Labels for the rank-column picker. Always numbered, with the header name appended
 * when the first row looks like a header — a wrong-but-plausible name is worse than a
 * bare number, and R writes tables whose header is one field short of its data rows. */
function columnLabels(headerFields: string[]): string[] {
  const looksLikeHeader = toFiniteNumber(headerFields[headerFields.length - 1] ?? '') === null;
  return headerFields.map((f, i) =>
    looksLikeHeader && f.trim() !== '' ? `Column ${i + 1} — ${f.trim()}` : `Column ${i + 1}`,
  );
}

/** Splits one enrichment-mode line into [nameField, rankField], or null if the line
 * doesn't yield an unambiguous pair. `rankColumn` (0-based) picks the rank field on
 * input with more than 2 delimited columns; without it such a line is refused rather
 * than guessed at (issue #63 — silently taking the last column ranked real DESeq2
 * output by `padj` instead of `log2FoldChange`, with no error and no warning). */
function splitEnrichmentLine(line: string, rankColumn?: number): string[] | null {
  const delim = delimiterOf(line);
  if (delim === null) {
    // Whitespace-delimited: the name itself may contain a space, so treat the last
    // token as the rank and everything before it as the name. ponytail: no quote
    // support on this branch — add if a real paste needs it.
    const tokens = line.trim().split(/\s+/);
    if (tokens.length < 2) return null;
    if (trailingNumericCount(tokens) > 1) return null; // ambiguous — see caller's message
    const rank = tokens[tokens.length - 1] ?? '';
    const name = tokens.slice(0, -1).join(' ');
    return [name, rank];
  }
  const fields = splitDelimited(line, delim);
  if (fields.length < 2) return null;
  if (fields.length > 2) {
    if (rankColumn === undefined) return null;
    return [fields[0] ?? '', fields[rankColumn] ?? ''];
  }
  return fields;
}

function splitLines(raw: string): string[] {
  return raw.split(/\r\n|\r|\n/);
}

function isBlank(line: string): boolean {
  return line.trim() === '';
}

export function parseInput(raw: string, mode: Mode, rankColumn?: number): ParseResult {
  const lines = splitLines(raw);
  const errors: ParseError[] = [];
  const seen = new Map<string, number>();

  // Header auto-detection looks only at the first non-blank line.
  const firstDataIdx = lines.findIndex((l) => !isBlank(l));

  if (mode === 'enrichment') {
    // Column detection is a property of the whole input, so it reads the first non-blank
    // line only -- a ragged later row shouldn't silently change which column is the rank.
    const firstLine = firstDataIdx >= 0 ? (lines[firstDataIdx] ?? '') : '';
    const firstDelim = delimiterOf(firstLine);
    const firstFields = firstDelim === null ? [] : splitDelimited(firstLine, firstDelim);
    const columns = firstFields.length > 2 ? columnLabels(firstFields) : null;

    // More than 2 columns and no explicit choice: parse nothing and ask. Deliberately not
    // defaulting to a column -- a default is exactly the silent-wrong-answer bug (#63).
    if (columns !== null && rankColumn === undefined) {
      return {
        mode,
        ranks: {},
        count: 0,
        errors: [],
        columns,
        rangeError: `Input has ${columns.length} columns — choose which one holds the rank value.`,
      };
    }

    const ranks: Record<string, number> = {};
    lines.forEach((line, idx) => {
      if (isBlank(line)) return;
      if (idx === firstDataIdx) {
        const fields = splitEnrichmentLine(line, rankColumn);
        const rankField = fields?.[1];
        if (!fields || rankField === undefined || toFiniteNumber(rankField) === null) {
          return; // treated as a header row, silently skipped
        }
      }
      const lineNo = idx + 1;
      const fields = splitEnrichmentLine(line, rankColumn);
      if (!fields) {
        errors.push({
          line: lineNo,
          text: line.trim(),
          message: isAmbiguousWhitespaceRow(line)
            ? 'more than one numeric column, separated by spaces — re-paste as tab- or comma-separated so the rank column can be chosen'
            : 'expected two columns (taxon name and rank)',
        });
        return;
      }
      const nameField = fields[0] ?? '';
      const rankField = fields[1] ?? '';
      const name = normalizeName(nameField);
      const rank = toFiniteNumber(rankField);
      if (name === '') {
        errors.push({ line: lineNo, text: line.trim(), message: 'missing taxon name' });
        return;
      }
      if (!NAME_PATTERN.test(name)) {
        errors.push({ line: lineNo, text: line.trim(), message: `invalid taxon name "${name}" (allowed: letters, digits, "_", ".", "-", space, 1-200 chars)` });
        return;
      }
      if (rank === null) {
        errors.push({ line: lineNo, text: line.trim(), message: `invalid rank value "${rankField.trim()}" (must be a finite number)` });
        return;
      }
      const prevLine = seen.get(name);
      if (prevLine !== undefined) {
        errors.push({ line: lineNo, text: line.trim(), message: `duplicate taxon name "${name}" (already seen on line ${prevLine})` });
        return;
      }
      seen.set(name, lineNo);
      ranks[name] = rank;
    });
    const count = Object.keys(ranks).length;
    return { mode, ranks, count, errors, columns, rangeError: errors.length === 0 ? rangeError(count) : null };
  }

  // ORA mode: one taxon name per line.
  const taxa: string[] = [];
  lines.forEach((line, idx) => {
    if (isBlank(line)) return;
    const [stripped = ''] = splitDelimited(line, String.fromCharCode(0));
    if (idx === firstDataIdx && ORA_HEADER_WORDS.has(stripped.trim().toLowerCase())) {
      return; // header row, skipped
    }
    const lineNo = idx + 1;
    const name = normalizeName(stripped);
    if (name === '') {
      errors.push({ line: lineNo, text: line.trim(), message: 'missing taxon name' });
      return;
    }
    if (!NAME_PATTERN.test(name)) {
      errors.push({ line: lineNo, text: line.trim(), message: `invalid taxon name "${name}" (allowed: letters, digits, "_", ".", "-", space, 1-200 chars)` });
      return;
    }
    const prevLine = seen.get(name);
    if (prevLine !== undefined) {
      errors.push({ line: lineNo, text: line.trim(), message: `duplicate taxon name "${name}" (already seen on line ${prevLine})` });
      return;
    }
    seen.set(name, lineNo);
    taxa.push(name);
  });
  const count = taxa.length;
  return { mode, taxa, count, errors, rangeError: errors.length === 0 ? rangeError(count) : null };
}

function rangeError(count: number): string | null {
  if (count < MIN_TAXA || count > MAX_TAXA) {
    return `taxa must contain between ${MIN_TAXA} and ${MAX_TAXA} entries (found ${count})`;
  }
  return null;
}

/** Clamp an advanced-option value into the server's documented range. */
export function clampSetSize(n: number): number {
  return Math.min(SET_SIZE_MAX, Math.max(SET_SIZE_MIN, n));
}
