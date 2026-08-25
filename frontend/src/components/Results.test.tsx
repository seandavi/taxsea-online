import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import Results from './Results';
import type { JobConnectionState, JobState, TaxSEAOutput } from '../hooks/useTaxSEAJob';
// Real TaxSEA output shape, shared with worker/edge tests (issue #16 acceptance criteria).
import rawFixture from '../../../worker/tests/fixtures/expected_output_shape.json';

const FIXTURE = rawFixture as unknown as TaxSEAOutput;

function jobState(overrides: Partial<JobState> = {}): JobState {
  return {
    jobId: 'job-1',
    status: 'completed',
    createdAt: 0,
    startedAt: 0,
    finishedAt: 100,
    executionTimeMs: 100,
    error: null,
    ...overrides,
  };
}

const BASE: JobConnectionState = { state: null, result: null, error: null, connection: 'closed', message: null };

describe('Results', () => {
  it('renders nothing before a job state exists', () => {
    const { container } = render(<Results job={BASE} />);
    expect(container.innerHTML).toBe('');
  });

  it('shows the sanitized error distinctly for a failed job', () => {
    const job: JobConnectionState = { ...BASE, state: jobState({ status: 'failed', error: 'Invalid rank input' }) };
    render(<Results job={job} />);
    const alert = screen.getByRole('alert');
    expect(alert.textContent).toContain('Invalid rank input');
    expect(alert.textContent).toMatch(/failed/i);
  });

  it('shows a timeout-specific suggestion for a timed_out job', () => {
    const job: JobConnectionState = { ...BASE, state: jobState({ status: 'timed_out', error: null }) };
    render(<Results job={job} />);
    const alert = screen.getByRole('alert');
    expect(alert.textContent).toMatch(/timed out|timeout/i);
    expect(alert.textContent).toMatch(/reduc(e|ing).*input/i);
  });

  it('shows job metadata for a completed job: jobId, execution time, package version, mode, params', () => {
    const job: JobConnectionState = { ...BASE, state: jobState({ status: 'completed' }), result: FIXTURE };
    render(<Results job={job} />);
    expect(screen.getByText(FIXTURE.jobId)).toBeTruthy();
    expect(screen.getByText(FIXTURE.taxsea.packageVersion)).toBeTruthy();
    expect(screen.getByText(FIXTURE.taxsea.mode)).toBeTruthy();
    expect(screen.getByText(/minSetSize=5/)).toBeTruthy();
    expect(screen.getByText(/maxSetSize=100/)).toBeTruthy();
  });

  it('renders one section per collection using the collection key as heading, with no hardcoded names', () => {
    // Deliberately unlike spec.md's suggested Metabolite_producers/Health_associations/BugSigDB
    // names -- proves nothing about collection names is hardcoded.
    const output: TaxSEAOutput = {
      ...FIXTURE,
      results: {
        Zebra_signatures: FIXTURE.results.All_databases!,
        Aardvark_stats: { columns: ['taxonSetName'], rows: [{ taxonSetName: 'x' }] },
      },
    };
    const job: JobConnectionState = { ...BASE, state: jobState({ status: 'completed' }), result: output };
    render(<Results job={job} />);
    expect(screen.getByRole('heading', { name: 'Zebra_signatures' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Aardvark_stats' })).toBeTruthy();
  });

  it('renders a collection with rows: [] as "No enriched sets"', () => {
    const output: TaxSEAOutput = {
      ...FIXTURE,
      results: { Empty_collection: { columns: ['taxonSetName', 'FDR'], rows: [] } },
    };
    const job: JobConnectionState = { ...BASE, state: jobState({ status: 'completed' }), result: output };
    render(<Results job={job} />);
    expect(screen.getByRole('heading', { name: 'Empty_collection' })).toBeTruthy();
    expect(screen.getByText('No enriched sets')).toBeTruthy();
  });
});

describe('Results: matched/unmatched taxa (issue #64)', () => {
  function withInput(input: TaxSEAOutput['taxsea']['input']): JobConnectionState {
    const result = { ...FIXTURE, taxsea: { ...FIXTURE.taxsea, input } } as TaxSEAOutput;
    return { ...BASE, state: jobState(), result };
  }

  it('warns when some taxa were dropped, naming them', () => {
    render(
      <Results
        job={withInput({
          submitted: 4,
          matched: 2,
          unmatched: ['Blortococcus_fakeus', 's__Escherichia_coli'],
          unmatchedTruncated: false,
        })}
      />,
    );
    expect(screen.getByText(/2 of 4 taxa matched/)).toBeTruthy();
    // Appears twice: once as the example in the explanation, once in the dropped list.
    expect(screen.getAllByText('s__Escherichia_coli').length).toBeGreaterThanOrEqual(2);
  });

  it('shows no warning when everything matched', () => {
    render(<Results job={withInput({ submitted: 4, matched: 4, unmatched: [], unmatchedTruncated: false })} />);
    expect(screen.queryByText(/were not recognised/)).toBeNull();
    // ...but the count is still reported in the metadata list.
    expect(screen.getByText('4 of 4')).toBeTruthy();
  });

  it('says the list is partial when the worker truncated it', () => {
    render(
      <Results
        job={withInput({ submitted: 500, matched: 100, unmatched: ['a_name'], unmatchedTruncated: true })}
      />,
    );
    expect(screen.getByText(/first 1/)).toBeTruthy();
  });

  it('renders results from before the field existed', () => {
    // output.json written to R2 prior to #64 has no taxsea.input at all.
    render(<Results job={withInput(undefined)} />);
    expect(screen.queryByText(/matched the TaxSEA reference database/)).toBeNull();
    expect(screen.getByRole('heading', { name: 'Results' })).toBeTruthy();
  });
});
