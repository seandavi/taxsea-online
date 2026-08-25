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
      <section className="job-status job-status-failed" role="alert">
        <h2>Job failed</h2>
        <p>{state.error ?? 'The job failed for an unknown reason.'}</p>
      </section>
    );
  }

  if (state.status === 'timed_out') {
    return (
      <section className="job-status job-status-timed-out" role="alert">
        <h2>Job timed out</h2>
        <p>
          This job didn&apos;t finish before the server-side timeout. Try reducing the size of your input
          and submitting again.
        </p>
      </section>
    );
  }

  if (state.status !== 'completed' || !result) {
    return (
      <section className="job-status" aria-live="polite">
        <p role="status">Status: {state.status}</p>
        {message && <p>{message}</p>}
        {error && <p role="alert">{error}</p>}
      </section>
    );
  }

  const collections = Object.entries(result.results);

  return (
    <section className="results">
      <h2>Results</h2>
      <dl className="job-meta">
        <dt>Job ID</dt>
        <dd>{result.jobId}</dd>
        <dt>Execution time</dt>
        <dd>{(result.executionTimeMs / 1000).toFixed(2)}s</dd>
        <dt>TaxSEA package version</dt>
        <dd>{result.taxsea.packageVersion}</dd>
        <dt>Mode</dt>
        <dd>{result.taxsea.mode}</dd>
        <dt>Parameters</dt>
        <dd>
          minSetSize={result.taxsea.params.minSetSize}, maxSetSize={result.taxsea.params.maxSetSize}
        </dd>
      </dl>

      <button type="button" onClick={() => downloadOutputJSON(result)}>
        Download full output.json
      </button>

      {collections.length === 0 ? (
        <p>No result collections returned.</p>
      ) : (
        collections.map(([name, collection]) => (
          <ResultTable key={name} jobId={result.jobId} collectionName={name} collection={collection} />
        ))
      )}
    </section>
  );
}
