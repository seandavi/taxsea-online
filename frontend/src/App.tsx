// App shell (issue #13) + job submission form (issue #14) + progress/results (issue #15-#16).
import { useState } from 'react';
import SubmitForm, { type JobCreatedResponse } from './components/SubmitForm';
import Results from './components/Results';
import useTaxSEAJob from './hooks/useTaxSEAJob';

export default function App() {
  const [jobId, setJobId] = useState<string | null>(null);
  const job = useTaxSEAJob(jobId);

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
        <SubmitForm onSubmitted={(submitted: JobCreatedResponse) => setJobId(submitted.jobId)} />
        {jobId && <Results job={job} />}
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
