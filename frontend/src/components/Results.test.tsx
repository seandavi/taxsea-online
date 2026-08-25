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
