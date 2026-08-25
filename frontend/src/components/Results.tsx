// Renders the `output.json` envelope and job-lifecycle states (issue #16). Collection names
// come from `Object.entries(output.results)` -- nothing about them is hardcoded.
import type { JobConnectionState } from '../hooks/useTaxSEAJob';
import ResultTable from './ResultTable';
import { downloadOutputJSON } from '../lib/download';

export interface ResultsProps {
  job: JobConnectionState;
}

export default function Results({ job }: ResultsProps) {
  const { state, result, error, message } = job;

  if (!state) return null;

  if (state.status === 'failed') {
    return (
      <section className="rounded-lg border border-red-300 bg-red-50 p-4 dark:border-red-900 dark:bg-red-950/40" role="alert">
        <h2 className="text-lg font-semibold text-red-800 dark:text-red-300">Job failed</h2>
        <p className="mt-1 text-sm text-red-700 dark:text-red-400">
          {state.error ?? 'The job failed for an unknown reason.'}
        </p>
      </section>
    );
  }

  if (state.status === 'timed_out') {
    return (
      <section className="rounded-lg border border-red-300 bg-red-50 p-4 dark:border-red-900 dark:bg-red-950/40" role="alert">
        <h2 className="text-lg font-semibold text-red-800 dark:text-red-300">Job timed out</h2>
        <p className="mt-1 text-sm text-red-700 dark:text-red-400">
          This job didn&apos;t finish before the server-side timeout. Try reducing the size of your input
          and submitting again.
        </p>
      </section>
    );
  }

  if (state.status !== 'completed' || !result) {
    return (
      <section className="flex flex-col gap-1" aria-live="polite">
        <p role="status" className="text-sm font-medium text-slate-900 dark:text-slate-100">
          Status: {state.status}
        </p>
        {message && <p className="text-sm text-slate-600 dark:text-slate-400">{message}</p>}
        {error && (
          <p role="alert" className="text-sm font-semibold text-red-700 dark:text-red-400">
            {error}
          </p>
        )}
      </section>
    );
  }

  const collections = Object.entries(result.results);
  const input = result.taxsea.input;
  // Anything dropped changes what the numbers below mean, so this sits above the tables
  // rather than in the metadata list (issue #64). Genus-only and MetaPhlAn s__ names are
  // both silently unresolvable, and a run with a few matches looks identical to a clean one.
  const dropped = input ? input.submitted - input.matched : 0;

  return (
    <section className="flex flex-col gap-6">
      <h2 className="text-xl font-bold tracking-tight text-slate-900 dark:text-slate-50">Results</h2>

      {input && dropped > 0 && (
        <div
          className="flex flex-col gap-2 rounded-lg border border-amber-300 bg-amber-50 p-4 dark:border-amber-900 dark:bg-amber-950/40"
          role="status"
        >
          <p className="text-sm font-semibold text-amber-900 dark:text-amber-200">
            {input.matched} of {input.submitted} taxa matched the TaxSEA reference database
            {' — '}
            {dropped} {dropped === 1 ? 'name was' : 'names were'} not recognised and took no part
            in this analysis.
          </p>
          <p className="text-sm text-amber-800 dark:text-amber-300">
            TaxSEA matches on exact species names. Genus-only names and MetaPhlAn-style prefixes
            (<code className="font-mono text-xs">s__Escherichia_coli</code>) do not resolve.
          </p>
          <details className="text-sm text-amber-800 dark:text-amber-300">
            <summary className="cursor-pointer font-medium">
              Show unrecognised names{input.unmatchedTruncated ? ` (first ${input.unmatched.length})` : ''}
            </summary>
            <ul className="mt-2 max-h-48 list-disc overflow-y-auto pl-5 font-mono text-xs">
              {input.unmatched.map((name) => (
                <li key={name}>{name}</li>
              ))}
            </ul>
          </details>
        </div>
      )}
      <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-sm">
        <dt className="font-semibold text-slate-600 dark:text-slate-400">Job ID</dt>
        <dd className="m-0 text-slate-900 dark:text-slate-100">{result.jobId}</dd>
        <dt className="font-semibold text-slate-600 dark:text-slate-400">Execution time</dt>
        <dd className="m-0 text-slate-900 dark:text-slate-100">{(result.executionTimeMs / 1000).toFixed(2)}s</dd>
        <dt className="font-semibold text-slate-600 dark:text-slate-400">TaxSEA package version</dt>
        <dd className="m-0 text-slate-900 dark:text-slate-100">{result.taxsea.packageVersion}</dd>
        <dt className="font-semibold text-slate-600 dark:text-slate-400">Mode</dt>
        <dd className="m-0 text-slate-900 dark:text-slate-100">{result.taxsea.mode}</dd>
        {input && (
          <>
            <dt className="font-semibold text-slate-600 dark:text-slate-400">Taxa matched</dt>
            <dd className="m-0 text-slate-900 dark:text-slate-100">
              {input.matched} of {input.submitted}
            </dd>
          </>
        )}
        <dt className="font-semibold text-slate-600 dark:text-slate-400">Parameters</dt>
        <dd className="m-0 text-slate-900 dark:text-slate-100">
          minSetSize={result.taxsea.params.minSetSize}, maxSetSize={result.taxsea.params.maxSetSize}
        </dd>
      </dl>

      <button
        type="button"
        onClick={() => downloadOutputJSON(result)}
        className="self-start rounded-md border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
      >
        Download full output.json
      </button>

      {collections.length === 0 ? (
        <p className="text-sm text-slate-600 dark:text-slate-400">No result collections returned.</p>
      ) : (
        collections.map(([name, collection]) => (
          <ResultTable key={name} jobId={result.jobId} collectionName={name} collection={collection} />
        ))
      )}
    </section>
  );
}
