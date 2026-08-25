// One sortable/filterable table for one result collection (issue #16). Column set is whatever
// `collection.columns` says -- never hardcoded -- so an unexpected extra column still renders.
import { useMemo, useState } from 'react';
import type { TaxSEAResultCollection } from '../hooks/useTaxSEAJob';
import { formatCell, sortRows } from '../lib/format';
import { downloadCollectionTSV } from '../lib/download';

export interface ResultTableProps {
  jobId: string;
  collectionName: string;
  collection: TaxSEAResultCollection;
}

type SortDir = 'asc' | 'desc';

export default function ResultTable({ jobId, collectionName, collection }: ResultTableProps) {
  const { columns, rows } = collection;
  const hasTaxonFilter = columns.includes('taxonSetName');

  const [sortColumn, setSortColumn] = useState<string | null>(columns.includes('FDR') ? 'FDR' : null);
  const [sortDir, setSortDir] = useState<SortDir>('asc');
  const [filterText, setFilterText] = useState('');

  const filteredRows = useMemo(() => {
    if (!hasTaxonFilter || filterText.trim() === '') return rows;
    const needle = filterText.trim().toLowerCase();
    return rows.filter((row) => String(row.taxonSetName ?? '').toLowerCase().includes(needle));
  }, [rows, filterText, hasTaxonFilter]);

  const sortedRows = useMemo(
    () => (sortColumn === null ? filteredRows : sortRows(filteredRows, sortColumn, sortDir)),
    [filteredRows, sortColumn, sortDir],
  );

  function handleSort(column: string) {
    if (sortColumn === column) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortColumn(column);
      setSortDir('asc');
    }
  }

  function ariaSortFor(column: string): 'ascending' | 'descending' | 'none' {
    if (sortColumn !== column) return 'none';
    return sortDir === 'asc' ? 'ascending' : 'descending';
  }

  return (
    <section className="flex flex-col gap-3">
      <h3 className="text-base font-semibold text-slate-900 dark:text-slate-100">{collectionName}</h3>
      <div className="flex flex-wrap items-end gap-4">
        {hasTaxonFilter && (
          <label className="flex flex-col gap-1 text-sm font-medium text-slate-900 dark:text-slate-100">
            Filter by taxon set name
            <input
              type="text"
              value={filterText}
              onChange={(e) => setFilterText(e.target.value)}
              placeholder="Filter…"
              className="rounded-md border border-slate-300 bg-white px-2 py-1 text-sm font-normal text-slate-900 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
            />
          </label>
        )}
        <button
          type="button"
          onClick={() => downloadCollectionTSV(jobId, collectionName, collection)}
          className="rounded-md border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
        >
          Download {collectionName} TSV
        </button>
      </div>

      {rows.length === 0 ? (
        <p className="text-sm text-slate-600 dark:text-slate-400">No enriched sets</p>
      ) : (
        <>
          <div className="overflow-x-auto rounded-lg border border-slate-200 dark:border-slate-800">
            <table className="w-full min-w-max border-collapse text-sm">
              <thead className="bg-slate-50 dark:bg-slate-900">
                <tr>
                  {columns.map((col) => (
                    <th
                      key={col}
                      aria-sort={ariaSortFor(col)}
                      className="whitespace-nowrap border-b border-slate-200 px-3 py-2 text-left font-semibold text-slate-900 aria-[sort=ascending]:after:ml-1 aria-[sort=ascending]:after:content-['▲'] aria-[sort=descending]:after:ml-1 aria-[sort=descending]:after:content-['▼'] dark:border-slate-800 dark:text-slate-100"
                    >
                      <button
                        type="button"
                        onClick={() => handleSort(col)}
                        className="font-semibold hover:text-blue-600 dark:hover:text-blue-400"
                      >
                        {col}
                      </button>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200 dark:divide-slate-800">
                {sortedRows.map((row, i) => (
                  <tr key={i} className="hover:bg-slate-50 dark:hover:bg-slate-900/50">
                    {columns.map((col) => (
                      <td key={col} className="whitespace-nowrap px-3 py-2 text-slate-700 dark:text-slate-300">
                        {formatCell(col, row[col])}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {sortedRows.length === 0 && (
            <p className="text-sm text-slate-600 dark:text-slate-400">No rows match the filter.</p>
          )}
        </>
      )}
    </section>
  );
}
