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
    <section className="result-table">
      <h3>{collectionName}</h3>
      <div className="result-table-controls">
        {hasTaxonFilter && (
          <label>
            Filter by taxon set name
            <input
              type="text"
              value={filterText}
              onChange={(e) => setFilterText(e.target.value)}
              placeholder="Filter…"
            />
          </label>
        )}
        <button type="button" onClick={() => downloadCollectionTSV(jobId, collectionName, collection)}>
          Download {collectionName} TSV
        </button>
      </div>

      {rows.length === 0 ? (
        <p>No enriched sets</p>
      ) : (
        <>
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  {columns.map((col) => (
                    <th key={col} aria-sort={ariaSortFor(col)}>
                      <button type="button" onClick={() => handleSort(col)}>
                        {col}
                      </button>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {sortedRows.map((row, i) => (
                  <tr key={i}>
                    {columns.map((col) => (
                      <td key={col}>{formatCell(col, row[col])}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {sortedRows.length === 0 && <p>No rows match the filter.</p>}
        </>
      )}
    </section>
  );
}
