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

/** Splits one enrichment-mode line into [nameField, rankField], or null if no
 * delimiter (tab/comma/whitespace) separates two columns at all. */
function splitEnrichmentLine(line: string): string[] | null {
  let fields: string[];
  if (line.includes('\t')) {
    fields = splitDelimited(line, '\t');
  } else if (line.includes(',')) {
    fields = splitDelimited(line, ',');
  } else {
    // Whitespace-delimited: the name itself may contain a space (e.g.
    // "Bifidobacterium longum 2.45"), so treat the last token as the rank and
    // everything before it as the name. ponytail: no quote support on this
    // branch — add if a real paste needs it.
    const tokens = line.trim().split(/\s+/);
    if (tokens.length < 2) return null;
    const rank = tokens[tokens.length - 1] ?? '';
    const name = tokens.slice(0, -1).join(' ');
    return [name, rank];
  }
  if (fields.length < 2) return null;
  if (fields.length > 2) {
    const rank = fields[fields.length - 1] ?? '';
    const name = fields.slice(0, -1).join(' ');
    return [name, rank];
  }
  return fields;
}

function splitLines(raw: string): string[] {
  return raw.split(/\r\n|\r|\n/);
}

function isBlank(line: string): boolean {
  return line.trim() === '';
}

export function parseInput(raw: string, mode: Mode): ParseResult {
  const lines = splitLines(raw);
  const errors: ParseError[] = [];
  const seen = new Map<string, number>();

  // Header auto-detection looks only at the first non-blank line.
  const firstDataIdx = lines.findIndex((l) => !isBlank(l));

  if (mode === 'enrichment') {
    const ranks: Record<string, number> = {};
    lines.forEach((line, idx) => {
      if (isBlank(line)) return;
      if (idx === firstDataIdx) {
        const fields = splitEnrichmentLine(line);
        const rankField = fields?.[1];
        if (!fields || rankField === undefined || toFiniteNumber(rankField) === null) {
          return; // treated as a header row, silently skipped
        }
      }
      const lineNo = idx + 1;
      const fields = splitEnrichmentLine(line);
      if (!fields) {
        errors.push({ line: lineNo, text: line.trim(), message: 'expected two columns (taxon name and rank)' });
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
    return { mode, ranks, count, errors, rangeError: errors.length === 0 ? rangeError(count) : null };
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
