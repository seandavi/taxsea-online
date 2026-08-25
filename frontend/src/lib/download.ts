// Client-side downloads via Blob + a throwaway <a download> (issue #16) -- no server round-trip,
// no dependency.
import type { TaxSEAOutput, TaxSEAResultCollection } from '../hooks/useTaxSEAJob';

function triggerDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  try {
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    link.click();
  } finally {
    URL.revokeObjectURL(url);
  }
}

export function downloadOutputJSON(output: TaxSEAOutput): void {
  triggerDownload(new Blob([JSON.stringify(output, null, 2)], { type: 'application/json' }), `taxsea-${output.jobId}.json`);
}

function tsvCell(value: number | string | null | undefined): string {
  if (value === null || value === undefined) return '';
  const str = String(value);
  return /[\t\n"]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
}

export function collectionToTSV(collection: TaxSEAResultCollection): string {
  const lines = [collection.columns.join('\t')];
  for (const row of collection.rows) {
    lines.push(collection.columns.map((col) => tsvCell(row[col])).join('\t'));
  }
  return lines.join('\n');
}

export function downloadCollectionTSV(jobId: string, collectionName: string, collection: TaxSEAResultCollection): void {
  triggerDownload(
    new Blob([collectionToTSV(collection)], { type: 'text/tab-separated-values' }),
    `taxsea-${jobId}-${collectionName}.tsv`,
  );
}
