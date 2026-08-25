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

  return (
    <section className="flex flex-col gap-6">
      <h2 className="text-xl font-bold tracking-tight text-slate-900 dark:text-slate-50">Results</h2>
      <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-sm">
        <dt className="font-semibold text-slate-600 dark:text-slate-400">Job ID</dt>
        <dd className="m-0 text-slate-900 dark:text-slate-100">{result.jobId}</dd>
        <dt className="font-semibold text-slate-600 dark:text-slate-400">Execution time</dt>
        <dd className="m-0 text-slate-900 dark:text-slate-100">{(result.executionTimeMs / 1000).toFixed(2)}s</dd>
        <dt className="font-semibold text-slate-600 dark:text-slate-400">TaxSEA package version</dt>
        <dd className="m-0 text-slate-900 dark:text-slate-100">{result.taxsea.packageVersion}</dd>
        <dt className="font-semibold text-slate-600 dark:text-slate-400">Mode</dt>
        <dd className="m-0 text-slate-900 dark:text-slate-100">{result.taxsea.mode}</dd>
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
