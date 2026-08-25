import { describe, expect, it } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import ResultTable from './ResultTable';
import type { TaxSEAOutput, TaxSEAResultCollection } from '../hooks/useTaxSEAJob';
// Real TaxSEA output shape, shared with worker/edge tests (issue #16 acceptance criteria).
import rawFixture from '../../../worker/tests/fixtures/expected_output_shape.json';

const FIXTURE = rawFixture as unknown as TaxSEAOutput;

describe('ResultTable', () => {
  it('renders columns in the order given by collection.columns, cells looked up by name', () => {
    const collection = FIXTURE.results.All_databases!;
    render(<ResultTable jobId="job-1" collectionName="All_databases" collection={collection} />);
    const headers = screen.getAllByRole('columnheader').map((th) => th.textContent);
    expect(headers).toEqual(collection.columns);
  });

  it('renders an unexpected extra column instead of dropping it', () => {
    const collection: TaxSEAResultCollection = {
      columns: ['taxonSetName', 'FDR', 'weird_new_column'],
      rows: [{ taxonSetName: 'Set A', FDR: 0.01, weird_new_column: 'surprise' }],
    };
    render(<ResultTable jobId="job-1" collectionName="Weird" collection={collection} />);
    expect(screen.getByRole('columnheader', { name: 'weird_new_column' })).toBeTruthy();
    expect(screen.getByText('surprise')).toBeTruthy();
  });

  it('shows "No enriched sets" for an empty collection, not an empty table', () => {
    const collection: TaxSEAResultCollection = { columns: ['taxonSetName', 'FDR'], rows: [] };
    render(<ResultTable jobId="job-1" collectionName="Empty" collection={collection} />);
    expect(screen.getByText('No enriched sets')).toBeTruthy();
    expect(screen.queryByRole('table')).toBeNull();
  });

  it('defaults to FDR-ascending sort when an FDR column is present', () => {
    const collection: TaxSEAResultCollection = {
      columns: ['taxonSetName', 'FDR'],
      rows: [
        { taxonSetName: 'High', FDR: 0.5 },
        { taxonSetName: 'Low', FDR: 0.01 },
      ],
    };
    render(<ResultTable jobId="job-1" collectionName="C" collection={collection} />);
    const dataRows = screen.getAllByRole('row').slice(1);
    expect(within(dataRows[0]!).getByText('Low')).toBeTruthy();
    expect(screen.getByRole('columnheader', { name: 'FDR' }).getAttribute('aria-sort')).toBe('ascending');
  });

  it('toggles sort direction on header click and updates aria-sort', () => {
    const collection: TaxSEAResultCollection = {
      columns: ['taxonSetName', 'FDR'],
      rows: [
        { taxonSetName: 'High', FDR: 0.5 },
        { taxonSetName: 'Low', FDR: 0.01 },
      ],
    };
    render(<ResultTable jobId="job-1" collectionName="C" collection={collection} />);
    fireEvent.click(screen.getByRole('button', { name: 'FDR' }));
    expect(screen.getByRole('columnheader', { name: 'FDR' }).getAttribute('aria-sort')).toBe('descending');
    const dataRows = screen.getAllByRole('row').slice(1);
    expect(within(dataRows[0]!).getByText('High')).toBeTruthy();
  });

  it('filters rows by taxonSetName', () => {
    const collection: TaxSEAResultCollection = {
      columns: ['taxonSetName', 'FDR'],
      rows: [
        { taxonSetName: 'Crohns disease', FDR: 0.5 },
        { taxonSetName: 'GABA producers', FDR: 0.01 },
      ],
    };
    render(<ResultTable jobId="job-1" collectionName="C" collection={collection} />);
    fireEvent.change(screen.getByLabelText('Filter by taxon set name'), { target: { value: 'gaba' } });
    expect(screen.getByText('GABA producers')).toBeTruthy();
    expect(screen.queryByText('Crohns disease')).toBeNull();
  });

  it('keeps null values sorted last regardless of direction', () => {
    const collection: TaxSEAResultCollection = {
      columns: ['taxonSetName', 'FDR'],
      rows: [
        { taxonSetName: 'Missing', FDR: null },
        { taxonSetName: 'High', FDR: 0.5 },
        { taxonSetName: 'Low', FDR: 0.01 },
      ],
    };
    render(<ResultTable jobId="job-1" collectionName="C" collection={collection} />);
    let dataRows = screen.getAllByRole('row').slice(1);
    expect(dataRows.map((r) => within(r).getAllByRole('cell')[0]!.textContent)).toEqual(['Low', 'High', 'Missing']);

    fireEvent.click(screen.getByRole('button', { name: 'FDR' })); // toggle to descending
    dataRows = screen.getAllByRole('row').slice(1);
    expect(dataRows.map((r) => within(r).getAllByRole('cell')[0]!.textContent)).toEqual(['High', 'Low', 'Missing']);
  });

  it('sorting a different column resets to ascending and moves aria-sort off the old column', () => {
    const collection: TaxSEAResultCollection = {
      columns: ['taxonSetName', 'FDR'],
      rows: [
        { taxonSetName: 'B', FDR: 0.01 },
        { taxonSetName: 'A', FDR: 0.5 },
      ],
    };
    render(<ResultTable jobId="job-1" collectionName="C" collection={collection} />);
    fireEvent.click(screen.getByRole('button', { name: 'FDR' })); // FDR asc -> desc
    expect(screen.getByRole('columnheader', { name: 'FDR' }).getAttribute('aria-sort')).toBe('descending');

    fireEvent.click(screen.getByRole('button', { name: 'taxonSetName' }));
    expect(screen.getByRole('columnheader', { name: 'FDR' }).getAttribute('aria-sort')).toBe('none');
    expect(screen.getByRole('columnheader', { name: 'taxonSetName' }).getAttribute('aria-sort')).toBe('ascending');
    const dataRows = screen.getAllByRole('row').slice(1);
    expect(within(dataRows[0]!).getByText('A')).toBeTruthy();
  });
});
