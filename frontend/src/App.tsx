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
      <header className="border-b border-slate-200 dark:border-slate-800">
        <div className="mx-auto flex max-w-5xl flex-col gap-1 px-4 py-6 sm:px-6">
          <h1 className="text-2xl font-bold tracking-tight text-slate-900 dark:text-slate-50 sm:text-3xl">
            TaxSEA-online
          </h1>
          <p className="text-sm text-slate-600 dark:text-slate-400">
            <a
              href="https://bioconductor.org/packages/TaxSEA/"
              target="_blank"
              rel="noreferrer"
              className="font-medium text-blue-600 underline-offset-4 hover:underline dark:text-blue-400"
            >
              TaxSEA on Bioconductor
            </a>
          </p>
        </div>
      </header>
      <main className="mx-auto flex max-w-5xl flex-col gap-10 px-4 py-8 sm:px-6">
        <SubmitForm onSubmitted={(submitted: JobCreatedResponse) => setJobId(submitted.jobId)} />
        {jobId && <Results job={job} />}
      </main>
      <footer className="border-t border-slate-200 dark:border-slate-800">
        <div className="mx-auto max-w-5xl px-4 py-6 text-sm text-slate-600 dark:text-slate-400 sm:px-6">
          <p>
            Powered by{' '}
            <a
              href="https://bioconductor.org/packages/TaxSEA/"
              target="_blank"
              rel="noreferrer"
              className="font-medium text-blue-600 underline-offset-4 hover:underline dark:text-blue-400"
            >
              TaxSEA
            </a>
            , by Feargal Ryan.
          </p>
        </div>
      </footer>
    </>
  );
}
