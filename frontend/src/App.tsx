// App shell only (issue #13). Job submission, progress, and results are #14-#16.
export default function App() {
  return (
    <>
      <header>
        <h1>TaxSEA-online</h1>
        <p>
          <a href="https://bioconductor.org/packages/TaxSEA/" target="_blank" rel="noreferrer">
            TaxSEA on Bioconductor
          </a>
        </p>
      </header>
      <main>
        <p>Taxon set enrichment analysis, coming soon.</p>
      </main>
      <footer>
        <p>
          Powered by{' '}
          <a href="https://bioconductor.org/packages/TaxSEA/" target="_blank" rel="noreferrer">
            TaxSEA
          </a>
          , by Feargal Ryan.
        </p>
      </footer>
    </>
  );
}
