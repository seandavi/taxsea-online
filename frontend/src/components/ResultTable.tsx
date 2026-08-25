// One sortable/filterable table for one result collection (issue #16, rebuilt on TanStack Table
// for issue #54). Column set is whatever `collection.columns` says -- never hardcoded -- so an
// unexpected extra column still renders.
//
// @tanstack/react-table is on v9, a from-scratch rewrite of the v8 API this issue was written
// against (useReactTable/ColumnDef). v9 ships `@tanstack/react-table/legacy` as an official,
// fully-supported compatibility layer that restores the v8-shaped hook/types (`useLegacyTable`,
// `LegacyColumnDef`, `getCoreRowModel`/`getSortedRowModel` markers) -- that's what's used below,
// since it's the shortest path to the v8-style API the acceptance criteria describe.
import { useMemo, useState } from 'react';
import { flexRender } from '@tanstack/react-table';
import type { SortingState } from '@tanstack/react-table';
import { getCoreRowModel, getSortedRowModel, useLegacyTable } from '@tanstack/react-table/legacy';
import type { LegacyColumnDef } from '@tanstack/react-table/legacy';
import type { TaxSEAResultCollection } from '../hooks/useTaxSEAJob';
import { compareValues, formatCell } from '../lib/format';
import { downloadCollectionTSV } from '../lib/download';

export interface ResultTableProps {
  jobId: string;
  collectionName: string;
  collection: TaxSEAResultCollection;
}

type RowRecord = TaxSEAResultCollection['rows'][number];

export default function ResultTable({ jobId, collectionName, collection }: ResultTableProps) {
  const { columns, rows } = collection;
  const hasTaxonFilter = columns.includes('taxonSetName');

  const [filterText, setFilterText] = useState('');
  const [sorting, setSorting] = useState<SortingState>(() =>
    columns.includes('FDR') ? [{ id: 'FDR', desc: false }] : [],
  );

  const filteredRows = useMemo(() => {
    if (!hasTaxonFilter || filterText.trim() === '') return rows;
    const needle = filterText.trim().toLowerCase();
    return rows.filter((row) => String(row.taxonSetName ?? '').toLowerCase().includes(needle));
  }, [rows, filterText, hasTaxonFilter]);

  const columnDefs = useMemo<LegacyColumnDef<RowRecord>[]>(
    () =>
      columns.map((col) => ({
        id: col,
        header: col,
        // null -> undefined so `sortUndefined: 'last'` (below) keeps missing values at the end
        // regardless of sort direction; formatCell renders null/undefined identically anyway.
        accessorFn: (row: RowRecord) => row[col] ?? undefined,
        cell: (info) => formatCell(col, info.getValue() as number | string | null | undefined),
        sortFn: (rowA, rowB, columnId) =>
          compareValues(rowA.getValue(columnId) as number | string, rowB.getValue(columnId) as number | string),
        sortUndefined: 'last',
      })),
    [columns],
  );

  const table = useLegacyTable<RowRecord>({
    data: filteredRows,
    columns: columnDefs,
    state: { sorting },
    onSortingChange: setSorting,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
  });

  // Single-column sort, no "unsorted" step: clicking the active header flips direction; clicking
  // a different header resets to ascending. Driven directly rather than TanStack's default
  // toggle handler (which cycles through removing the sort) to keep the original behavior.
  function handleSort(columnId: string) {
    setSorting((prev) => {
      const current = prev[0];
      return current?.id === columnId ? [{ id: columnId, desc: !current.desc }] : [{ id: columnId, desc: false }];
    });
  }

  function ariaSortFor(sorted: false | 'asc' | 'desc'): 'ascending' | 'descending' | 'none' {
    if (sorted === 'asc') return 'ascending';
    if (sorted === 'desc') return 'descending';
    return 'none';
  }

  const tableRows = table.getRowModel().rows;

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
                {table.getHeaderGroups().map((headerGroup) => (
                  <tr key={headerGroup.id}>
                    {headerGroup.headers.map((header) => (
                      <th
                        key={header.id}
                        aria-sort={ariaSortFor(header.column.getIsSorted())}
                        className="whitespace-nowrap border-b border-slate-200 px-3 py-2 text-left font-semibold text-slate-900 aria-[sort=ascending]:after:ml-1 aria-[sort=ascending]:after:content-['▲'] aria-[sort=descending]:after:ml-1 aria-[sort=descending]:after:content-['▼'] dark:border-slate-800 dark:text-slate-100"
                      >
                        <button
                          type="button"
                          onClick={() => handleSort(header.column.id)}
                          className="font-semibold hover:text-blue-600 dark:hover:text-blue-400"
                        >
                          {flexRender(header.column.columnDef.header, header.getContext())}
                        </button>
                      </th>
                    ))}
                  </tr>
                ))}
              </thead>
              <tbody className="divide-y divide-slate-200 dark:divide-slate-800">
                {tableRows.map((row) => (
                  <tr key={row.id} className="hover:bg-slate-50 dark:hover:bg-slate-900/50">
                    {row.getVisibleCells().map((cell) => (
                      <td key={cell.id} className="whitespace-nowrap px-3 py-2 text-slate-700 dark:text-slate-300">
                        {flexRender(cell.column.columnDef.cell, cell.getContext())}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {tableRows.length === 0 && (
            <p className="text-sm text-slate-600 dark:text-slate-400">No rows match the filter.</p>
          )}
        </>
      )}
    </section>
  );
}
