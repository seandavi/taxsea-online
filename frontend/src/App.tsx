// App shell (issue #13) + job submission form (issue #14). Progress and results are #15-#16.
import SubmitForm from './components/SubmitForm';

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
        <SubmitForm />
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
