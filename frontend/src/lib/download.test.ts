import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { collectionToTSV, downloadCollectionTSV, downloadOutputJSON } from './download';
import type { TaxSEAOutput, TaxSEAResultCollection } from '../hooks/useTaxSEAJob';

describe('collectionToTSV', () => {
  it('joins columns and rows with tabs, in column order, and renders null as empty', () => {
    const collection: TaxSEAResultCollection = {
      columns: ['taxonSetName', 'FDR'],
      rows: [
        { taxonSetName: 'Set A', FDR: 0.01 },
        { taxonSetName: 'Set B', FDR: null },
      ],
    };
    expect(collectionToTSV(collection)).toBe('taxonSetName\tFDR\nSet A\t0.01\nSet B\t');
  });

  it('quotes values containing tabs, newlines, or quotes', () => {
    const collection: TaxSEAResultCollection = {
      columns: ['taxonSetName'],
      rows: [{ taxonSetName: 'has\t"quote"\nand newline' }],
    };
    expect(collectionToTSV(collection)).toBe('taxonSetName\n"has\t""quote""\nand newline"');
  });

  it('handles an empty collection (header row only)', () => {
    expect(collectionToTSV({ columns: ['a', 'b'], rows: [] })).toBe('a\tb');
  });
});

describe('download triggers (Blob + throwaway <a>, no dependency)', () => {
  let createObjectURL: ReturnType<typeof vi.fn>;
  let revokeObjectURL: ReturnType<typeof vi.fn>;
  let clickSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    createObjectURL = vi.fn(() => 'blob:mock-url');
    revokeObjectURL = vi.fn();
    vi.stubGlobal('URL', { ...URL, createObjectURL, revokeObjectURL });
    clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    clickSpy.mockRestore();
  });

  it('downloadOutputJSON creates a JSON blob and clicks a link', () => {
    const output: TaxSEAOutput = {
      jobId: 'job-1',
      status: 'completed',
      executionTimeMs: 10,
      taxsea: { packageVersion: '1.0.0', mode: 'enrichment', params: { minSetSize: 5, maxSetSize: 100 } },
      results: {},
    };
    downloadOutputJSON(output);
    expect(createObjectURL).toHaveBeenCalledTimes(1);
    const blob = createObjectURL.mock.calls[0]![0] as Blob;
    expect(blob.type).toBe('application/json');
    expect(clickSpy).toHaveBeenCalledTimes(1);
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:mock-url');
  });

  it('downloadCollectionTSV creates a TSV blob and clicks a link', () => {
    const collection: TaxSEAResultCollection = { columns: ['taxonSetName'], rows: [{ taxonSetName: 'x' }] };
    downloadCollectionTSV('job-1', 'All_databases', collection);
    expect(createObjectURL).toHaveBeenCalledTimes(1);
    const blob = createObjectURL.mock.calls[0]![0] as Blob;
    expect(blob.type).toBe('text/tab-separated-values');
    expect(clickSpy).toHaveBeenCalledTimes(1);
  });
});
