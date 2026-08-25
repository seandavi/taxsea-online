// App shell (issue #13) + job submission form (issue #14) + progress/results (issue #15-#16)
// + client-side routing for the About page (issue #51).
import { useState } from 'react';
import { Link, Route, Routes } from 'react-router';
import SubmitForm, { type JobCreatedResponse } from './components/SubmitForm';
import Results from './components/Results';
import About from './components/About';
import useTaxSEAJob from './hooks/useTaxSEAJob';

function Home() {
  const [jobId, setJobId] = useState<string | null>(null);
  const job = useTaxSEAJob(jobId);

  return (
    <main className="mx-auto flex max-w-5xl flex-col gap-10 px-4 py-8 sm:px-6">
      <SubmitForm onSubmitted={(submitted: JobCreatedResponse) => setJobId(submitted.jobId)} />
      {jobId && <Results job={job} />}
    </main>
  );
}

export default function App() {
  return (
    <>
      <header className="border-b border-slate-200 dark:border-slate-800">
        <div className="mx-auto flex max-w-5xl items-start justify-between gap-4 px-4 py-6 sm:px-6">
          <div className="flex flex-col gap-1">
            <h1 className="text-2xl font-bold tracking-tight text-slate-900 dark:text-slate-50 sm:text-3xl">
              <Link to="/">TaxSEA-online</Link>
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
          <div className="mt-1 flex shrink-0 items-center gap-4">
            <Link
              to="/about"
              className="text-sm font-medium text-slate-600 underline-offset-4 hover:text-slate-900 hover:underline dark:text-slate-400 dark:hover:text-slate-50"
            >
              About
            </Link>
            <a
              href="https://github.com/seandavi/taxsea-online"
              target="_blank"
              rel="noreferrer"
              aria-label="View source on GitHub"
              className="text-slate-600 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-50"
            >
              <svg viewBox="0 0 24 24" width="24" height="24" fill="currentColor" aria-hidden="true">
                <path d="M12 .5C5.73.5.5 5.73.5 12c0 5.09 3.29 9.4 7.86 10.93.58.1.79-.25.79-.56 0-.28-.01-1.02-.02-2-3.2.7-3.88-1.54-3.88-1.54-.52-1.33-1.28-1.68-1.28-1.68-1.04-.72.08-.7.08-.7 1.15.08 1.76 1.19 1.76 1.19 1.03 1.75 2.7 1.25 3.36.96.1-.75.4-1.25.73-1.54-2.55-.29-5.24-1.28-5.24-5.69 0-1.26.45-2.29 1.19-3.09-.12-.29-.52-1.46.11-3.05 0 0 .97-.31 3.18 1.18a11 11 0 0 1 5.79 0c2.2-1.49 3.17-1.18 3.17-1.18.64 1.59.24 2.76.12 3.05.74.8 1.19 1.83 1.19 3.09 0 4.42-2.69 5.4-5.25 5.68.41.36.78 1.07.78 2.15 0 1.56-.01 2.81-.01 3.19 0 .31.21.67.8.56A10.52 10.52 0 0 0 23.5 12C23.5 5.73 18.27.5 12 .5z" />
              </svg>
            </a>
          </div>
        </div>
      </header>
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/about" element={<About />} />
      </Routes>
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
          <p className="mt-1">
            Using these results in published work? Please{' '}
            <Link to="/about#citation" className="font-medium text-blue-600 underline-offset-4 hover:underline dark:text-blue-400">
              cite TaxSEA
            </Link>
            . A citation for TaxSEA-online itself is pending publication.
          </p>
        </div>
      </footer>
    </>
  );
}
