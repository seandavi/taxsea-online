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

  // null until the user picks one. Never pre-selected: a default column is the #63 bug.
  const [rankColumn, setRankColumn] = useState<number | null>(null);

  const parsed = useMemo(() => parseInput(text, mode, rankColumn ?? undefined), [text, mode, rankColumn]);
  const columns = parsed.mode === 'enrichment' ? parsed.columns : null;

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
    setRankColumn(null);
    setSubmitError(null);
    setSubmitted(null);
  }

  function loadExample() {
    setText(exampleTextFor(mode));
    setRankColumn(null);
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
    <form onSubmit={handleSubmit} noValidate className="flex max-w-2xl flex-col gap-6">
      <fieldset className="rounded-lg border border-slate-300 p-4 dark:border-slate-700">
        <legend className="px-1 text-sm font-semibold text-slate-900 dark:text-slate-100">Analysis mode</legend>
        <label className="flex items-center gap-2 text-sm font-medium text-slate-900 dark:text-slate-100">
          <input
            type="radio"
            name="mode"
            value="enrichment"
            checked={mode === 'enrichment'}
            onChange={() => switchMode('enrichment')}
            className="h-4 w-4 accent-blue-600 dark:accent-blue-400"
          />
          Enrichment
        </label>
        <p className="mb-3 ml-6 mt-1 text-sm text-slate-600 dark:text-slate-400">
          Rank every taxon by a continuous statistic (e.g. log-fold-change) to test whether TaxSEA&apos;s
          taxon sets skew toward one end of the ranking.
        </p>
        <label className="flex items-center gap-2 text-sm font-medium text-slate-900 dark:text-slate-100">
          <input
            type="radio"
            name="mode"
            value="ora"
            checked={mode === 'ora'}
            onChange={() => switchMode('ora')}
            className="h-4 w-4 accent-blue-600 dark:accent-blue-400"
          />
          ORA (over-representation)
        </label>
        <p className="ml-6 mt-1 text-sm text-slate-600 dark:text-slate-400">
          Give a flat list of taxa of interest (e.g. significantly changed) to test which TaxSEA taxon
          sets are over-represented among them.
        </p>
      </fieldset>

      <div className="flex flex-col gap-2">
        <label htmlFor="taxa-input" className="text-sm font-semibold text-slate-900 dark:text-slate-100">
          {mode === 'enrichment' ? 'Taxon name and rank, one pair per line' : 'Taxon names, one per line'}
        </label>
        <textarea
          id="taxa-input"
          rows={12}
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            // New paste, new shape -- a column chosen for the old text would silently
            // apply to different data.
            setRankColumn(null);
          }}
          placeholder={
            mode === 'enrichment'
              ? 'Bifidobacterium_longum\t2.45\nRuminococcus_bromii\t-3.05'
              : 'Bifidobacterium_longum\nBacteroides_thetaiotaomicron'
          }
          spellCheck={false}
          className="w-full resize-y rounded-lg border border-slate-300 bg-white px-3 py-2 font-mono text-sm text-slate-900 placeholder:text-slate-400 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100 dark:placeholder:text-slate-500"
        />
        <p aria-live="polite" className="text-sm text-slate-600 dark:text-slate-400">
          {parsed.count} taxa parsed
        </p>
        <button
          type="button"
          onClick={loadExample}
          className="self-start rounded-md border border-blue-600 px-3 py-1.5 text-sm font-medium text-blue-600 hover:bg-blue-50 dark:border-blue-400 dark:text-blue-400 dark:hover:bg-blue-950/40"
        >
          Load example data
        </button>
      </div>

      {columns && (
        <div className="flex flex-col gap-2 rounded-lg border border-amber-300 bg-amber-50 p-4 dark:border-amber-900 dark:bg-amber-950/40">
          <label htmlFor="rank-column" className="text-sm font-semibold text-amber-900 dark:text-amber-200">
            This input has {columns.length} columns — which one holds the rank value?
          </label>
          <p className="text-sm text-amber-800 dark:text-amber-300">
            Column 1 is used as the taxon name. Nothing is analysed until you choose, so that a
            table like DESeq2 output is never ranked by the wrong statistic.
          </p>
          <select
            id="rank-column"
            value={rankColumn === null ? '' : String(rankColumn)}
            onChange={(e) => setRankColumn(e.target.value === '' ? null : Number(e.target.value))}
            className="self-start rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm text-slate-900 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
          >
            <option value="">Select a column…</option>
            {columns.map((label, i) =>
              i === 0 ? null : (
                <option key={label} value={i}>
                  {label}
                </option>
              ),
            )}
          </select>
        </div>
      )}

      {parsed.errors.length > 0 && (
        <ul
          className="list-disc space-y-1 rounded-lg border border-red-300 bg-red-50 py-3 pl-9 pr-4 text-sm text-red-800 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300"
          aria-live="polite"
        >
          {parsed.errors.map((err) => (
            <li key={`${err.line}-${err.message}`}>
              Line {err.line}: {err.message} (
              <code className="rounded bg-red-100 px-1 py-0.5 font-mono text-xs dark:bg-red-900/50">
                {err.text}
              </code>
              )
            </li>
          ))}
        </ul>
      )}

      <details className="rounded-lg border border-slate-300 p-4 dark:border-slate-700">
        <summary className="cursor-pointer text-sm font-semibold text-slate-900 dark:text-slate-100">
          Advanced options
        </summary>
        <p className="mt-2 text-sm text-slate-600 dark:text-slate-400">
          TaxSEA ignores taxon sets smaller than{' '}
          <code className="rounded bg-slate-100 px-1 py-0.5 font-mono text-xs dark:bg-slate-800">minSetSize</code>{' '}
          or larger than{' '}
          <code className="rounded bg-slate-100 px-1 py-0.5 font-mono text-xs dark:bg-slate-800">maxSetSize</code>.
          Both are clamped to the range {2}–{1000} server-side; leave blank to use the server default.
        </p>
        <label
          htmlFor="min-set-size"
          className="mt-3 block text-sm font-medium text-slate-900 dark:text-slate-100"
        >
          Minimum set size
        </label>
        <input
          id="min-set-size"
          type="number"
          min={2}
          max={1000}
          value={minSetSizeInput}
          onChange={(e) => setMinSetSizeInput(e.target.value)}
          onBlur={() => setMinSetSizeInput((v) => (v.trim() === '' ? v : String(clampSetSize(Number(v)))))}
          className="mt-1 w-32 rounded-md border border-slate-300 bg-white px-2 py-1 text-sm text-slate-900 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
        />
        <label
          htmlFor="max-set-size"
          className="mt-3 block text-sm font-medium text-slate-900 dark:text-slate-100"
        >
          Maximum set size
        </label>
        <input
          id="max-set-size"
          type="number"
          min={2}
          max={1000}
          value={maxSetSizeInput}
          onChange={(e) => setMaxSetSizeInput(e.target.value)}
          onBlur={() => setMaxSetSizeInput((v) => (v.trim() === '' ? v : String(clampSetSize(Number(v)))))}
          className="mt-1 w-32 rounded-md border border-slate-300 bg-white px-2 py-1 text-sm text-slate-900 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
        />
      </details>

      <div className="flex items-center gap-3">
        <button
          type="submit"
          disabled={disabledReason !== null}
          className="rounded-md bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-blue-500 dark:hover:bg-blue-400"
        >
          Submit
        </button>
        {disabledReason && (
          <p role="status" className="text-sm text-slate-600 dark:text-slate-400">
            {disabledReason}
          </p>
        )}
      </div>

      {submitError && (
        <p
          role="alert"
          className="rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-sm font-semibold text-red-800 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300"
        >
          {submitError.field ? `${submitError.field}: ` : ''}
          {submitError.message}
        </p>
      )}

      {submitted && (
        <p
          role="status"
          className="rounded-lg border border-green-300 bg-green-50 px-3 py-2 text-sm text-green-800 dark:border-green-900 dark:bg-green-950/40 dark:text-green-300"
        >
          Job submitted:{' '}
          <code className="rounded bg-green-100 px-1 py-0.5 font-mono text-xs dark:bg-green-900/50">
            {submitted.jobId}
          </code>{' '}
          (status: {submitted.status})
        </p>
      )}
    </form>
  );
}
