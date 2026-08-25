import { useEffect, useMemo, useState } from 'react';
import { clampSetSize, parseInput, type Mode } from '../lib/parseInput';
import { EXAMPLE_ENRICHMENT_OPTIONS, EXAMPLE_ENRICHMENT_RANKS, EXAMPLE_ORA_TAXA } from '../lib/exampleData';

export interface JobCreatedResponse {
  jobId: string;
  status: string;
  wsUrl: string;
  stateUrl: string;
  resultUrl: string;
}

interface ApiErrorBody {
  error: string;
  message: string;
  field?: string;
}

export interface SubmitFormProps {
  /** Called once the server has accepted the job (201). */
  onSubmitted?: (job: JobCreatedResponse) => void;
}

function exampleTextFor(mode: Mode): string {
  if (mode === 'enrichment') {
    return Object.entries(EXAMPLE_ENRICHMENT_RANKS)
      .map(([name, rank]) => `${name}\t${rank}`)
      .join('\n');
  }
  return EXAMPLE_ORA_TAXA.join('\n');
}

export default function SubmitForm({ onSubmitted }: SubmitFormProps) {
  const [mode, setMode] = useState<Mode>('enrichment');
  const [text, setText] = useState('');
  const [minSetSizeInput, setMinSetSizeInput] = useState('');
  const [maxSetSizeInput, setMaxSetSizeInput] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<ApiErrorBody | null>(null);
  const [retryAfter, setRetryAfter] = useState<number | null>(null);
  const [submitted, setSubmitted] = useState<JobCreatedResponse | null>(null);

  const parsed = useMemo(() => parseInput(text, mode), [text, mode]);

  // 429 countdown.
  useEffect(() => {
    if (retryAfter === null || retryAfter <= 0) return;
    const id = setInterval(() => {
      setRetryAfter((s) => (s === null ? null : Math.max(0, s - 1)));
    }, 1000);
    return () => clearInterval(id);
  }, [retryAfter]);

  function switchMode(next: Mode) {
    setMode(next);
    setText('');
    setSubmitError(null);
    setSubmitted(null);
  }

  function loadExample() {
    setText(exampleTextFor(mode));
    if (mode === 'enrichment') {
      setMinSetSizeInput(String(EXAMPLE_ENRICHMENT_OPTIONS.minSetSize));
      setMaxSetSizeInput(String(EXAMPLE_ENRICHMENT_OPTIONS.maxSetSize));
    }
    setSubmitError(null);
    setSubmitted(null);
  }

  const disabledReason = useMemo(() => {
    if (submitting) return 'Submitting…';
    if (retryAfter !== null && retryAfter > 0) return `Rate limited — try again in ${retryAfter}s`;
    if (text.trim() === '') return 'Paste data, or load the example, to begin';
    const [firstError] = parsed.errors;
    if (firstError) return `Line ${firstError.line}: ${firstError.message}`;
    if (parsed.rangeError) return parsed.rangeError;
    return null;
  }, [submitting, retryAfter, text, parsed]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (disabledReason) return;

    const options: { minSetSize?: number; maxSetSize?: number } = {};
    if (minSetSizeInput.trim() !== '') options.minSetSize = clampSetSize(Number(minSetSizeInput));
    if (maxSetSizeInput.trim() !== '') options.maxSetSize = clampSetSize(Number(maxSetSizeInput));

    const body =
      parsed.mode === 'enrichment'
        ? { mode: parsed.mode, ranks: parsed.ranks, ...(Object.keys(options).length ? { options } : {}) }
        : { mode: parsed.mode, taxa: parsed.taxa, ...(Object.keys(options).length ? { options } : {}) };

    setSubmitting(true);
    setSubmitError(null);
    setSubmitted(null);
    try {
      const res = await fetch('/api/jobs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      if (res.status === 201) {
        const data = (await res.json()) as JobCreatedResponse;
        setSubmitted(data);
        onSubmitted?.(data);
      } else if (res.status === 429) {
        const retrySeconds = Number(res.headers.get('Retry-After'));
        setRetryAfter(Number.isFinite(retrySeconds) && retrySeconds > 0 ? retrySeconds : 30);
        const data = await res.json().catch(() => null);
        setSubmitError({ error: 'rate_limited', message: data?.message ?? 'Too many job submissions. Try again shortly.' });
      } else if (res.status === 413) {
        setSubmitError({ error: 'payload_too_large', message: 'Input is too large for a single submission (max 1 MiB).' });
      } else if (res.status === 400) {
        const data = (await res.json().catch(() => null)) as ApiErrorBody | null;
        setSubmitError(data ?? { error: 'invalid_request', message: 'The server rejected this request.' });
      } else {
        setSubmitError({ error: 'unknown', message: `Unexpected server response (${res.status}).` });
      }
    } catch {
      setSubmitError({ error: 'network_error', message: 'Could not reach the server. Check your connection and try again.' });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} noValidate>
      <fieldset>
        <legend>Analysis mode</legend>
        <label>
          <input
            type="radio"
            name="mode"
            value="enrichment"
            checked={mode === 'enrichment'}
            onChange={() => switchMode('enrichment')}
          />
          Enrichment
        </label>
        <p className="mode-help">
          Rank every taxon by a continuous statistic (e.g. log-fold-change) to test whether TaxSEA&apos;s
          taxon sets skew toward one end of the ranking.
        </p>
        <label>
          <input type="radio" name="mode" value="ora" checked={mode === 'ora'} onChange={() => switchMode('ora')} />
          ORA (over-representation)
        </label>
        <p className="mode-help">
          Give a flat list of taxa of interest (e.g. significantly changed) to test which TaxSEA taxon
          sets are over-represented among them.
        </p>
      </fieldset>

      <div>
        <label htmlFor="taxa-input">
          {mode === 'enrichment' ? 'Taxon name and rank, one pair per line' : 'Taxon names, one per line'}
        </label>
        <textarea
          id="taxa-input"
          rows={12}
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={
            mode === 'enrichment'
              ? 'Bifidobacterium_longum\t2.45\nRuminococcus_bromii\t-3.05'
              : 'Bifidobacterium_longum\nBacteroides_thetaiotaomicron'
          }
          spellCheck={false}
        />
        <p aria-live="polite">{parsed.count} taxa parsed</p>
        <button type="button" onClick={loadExample}>
          Load example data
        </button>
      </div>

      {parsed.errors.length > 0 && (
        <ul className="parse-errors" aria-live="polite">
          {parsed.errors.map((err) => (
            <li key={`${err.line}-${err.message}`}>
              Line {err.line}: {err.message} (<code>{err.text}</code>)
            </li>
          ))}
        </ul>
      )}

      <details>
        <summary>Advanced options</summary>
        <p>
          TaxSEA ignores taxon sets smaller than <code>minSetSize</code> or larger than{' '}
          <code>maxSetSize</code>. Both are clamped to the range {2}–{1000} server-side; leave blank to
          use the server default.
        </p>
        <label htmlFor="min-set-size">Minimum set size</label>
        <input
          id="min-set-size"
          type="number"
          min={2}
          max={1000}
          value={minSetSizeInput}
          onChange={(e) => setMinSetSizeInput(e.target.value)}
          onBlur={() => setMinSetSizeInput((v) => (v.trim() === '' ? v : String(clampSetSize(Number(v)))))}
        />
        <label htmlFor="max-set-size">Maximum set size</label>
        <input
          id="max-set-size"
          type="number"
          min={2}
          max={1000}
          value={maxSetSizeInput}
          onChange={(e) => setMaxSetSizeInput(e.target.value)}
          onBlur={() => setMaxSetSizeInput((v) => (v.trim() === '' ? v : String(clampSetSize(Number(v)))))}
        />
      </details>

      <div>
        <button type="submit" disabled={disabledReason !== null}>
          Submit
        </button>
        {disabledReason && <p role="status">{disabledReason}</p>}
      </div>

      {submitError && (
        <p role="alert">
          {submitError.field ? `${submitError.field}: ` : ''}
          {submitError.message}
        </p>
      )}

      {submitted && (
        <p role="status">
          Job submitted: <code>{submitted.jobId}</code> (status: {submitted.status})
        </p>
      )}
    </form>
  );
}
