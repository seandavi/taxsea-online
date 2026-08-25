// About page (issue #51): what the service does, the taxon-set databases TaxSEA bundles,
// and links to documentation. Descriptions/URLs below are sourced from the TaxSEA package
// (github.com/feargalr/TaxSEA) and each database's own publication -- not invented.
import { Link } from 'react-router';

interface TaxonSet {
  name: string;
  description: string;
  href?: string;
  linkLabel?: string;
}

// The six named result collections TaxSEA's `taxsea_format_results()` groups taxon sets into
// (see R/taxsea_format_results.R in feargalr/TaxSEA). `results` keys in a job's output are
// whatever TaxSEA returns and are never hardcoded in the app itself (docs/api.md §8) --
// this list is purely informational, for this page.
const TAXON_SETS: TaxonSet[] = [
  {
    name: 'All_databases',
    description: 'The full, unfiltered set of enrichment results across every bundled database below.',
  },
  {
    name: 'Metabolite_producers',
    description:
      'Taxa reported to produce a given metabolite, drawn from MiMeDB (the Human Microbial Metabolome Database) and gutMGene (curated microbe-metabolite-gene relationships).',
    href: 'https://mimedb.org/',
    linkLabel: 'MiMeDB',
  },
  {
    name: 'Health_associations',
    description:
      'Taxa linked to diseases or health states, drawn from GMrepo v2 (a curated human gut microbiome database of disease markers) and mBodyMap (microbes across human body sites and their disease associations).',
    href: 'https://gmrepo.humangut.info/',
    linkLabel: 'GMrepo v2',
  },
  {
    name: 'BacDive_bacterial_physiology',
    description:
      'Taxa grouped by physiological and phenotypic traits (e.g. oxygen tolerance, metabolism) curated in BacDive, the bacterial diversity metadatabase.',
    href: 'https://bacdive.dsmz.de/',
    linkLabel: 'BacDive',
  },
  {
    name: 'BugSigDB',
    description:
      'Curated differential-abundance signatures manually extracted from published microbiome studies by the BugSigDB community.',
    href: 'https://bugsigdb.org/',
    linkLabel: 'BugSigDB',
  },
  {
    name: 'Gut_Brain_Modules_VallesColomer2019',
    description:
      "Gut-brain modules: gene sets for microbial synthesis and degradation of neuroactive compounds, from Valles-Colomer et al.'s 2019 study of the gut microbiota's neuroactive potential.",
    href: 'https://doi.org/10.1038/s41564-018-0337-x',
    linkLabel: 'Valles-Colomer et al. 2019, Nature Microbiology',
  },
];

function SectionHeading({ children }: { children: string }) {
  return <h2 className="text-xl font-bold tracking-tight text-slate-900 dark:text-slate-50">{children}</h2>;
}

export default function About() {
  return (
    <main className="mx-auto flex max-w-5xl flex-col gap-10 px-4 py-8 sm:px-6">
      <div>
        <Link
          to="/"
          className="text-sm font-medium text-blue-600 underline-offset-4 hover:underline dark:text-blue-400"
        >
          &larr; Back to the app
        </Link>
      </div>

      <section className="flex flex-col gap-3">
        <SectionHeading>About TaxSEA-online</SectionHeading>
        <p className="text-sm text-slate-700 dark:text-slate-300">
          TaxSEA-online is an asynchronous web service for taxon-set enrichment analysis using the Bioconductor
          package{' '}
          <a
            href="https://bioconductor.org/packages/TaxSEA/"
            target="_blank"
            rel="noreferrer"
            className="font-medium text-blue-600 underline-offset-4 hover:underline dark:text-blue-400"
          >
            TaxSEA
          </a>
          . It's for microbiome researchers who have a differential-abundance result -- a ranked list of taxa, or
          just a taxon list from an ORA-style workflow -- and want to know whether known taxon sets are enriched in
          it, without installing R or Bioconductor locally.
        </p>
        <p className="text-sm text-slate-700 dark:text-slate-300">
          A submission is a single async job, not a request/response call: submitting your data returns immediately
          with a job ID and hands off to a per-job server-side coordinator, which runs TaxSEA in an isolated,
          on-demand compute container with no network access and no storage credentials. The result streams back to
          this page over a WebSocket the instant the job finishes (falling back to polling if needed) -- no queue,
          external database, or second cloud involved.
        </p>
      </section>

      <section className="flex flex-col gap-4">
        <SectionHeading>Taxon-set databases TaxSEA bundles</SectionHeading>
        <p className="text-sm text-slate-700 dark:text-slate-300">
          TaxSEA tests your input against curated taxon sets grouped into the following result collections. Which
          collections and columns actually appear in a given job's results depend on the TaxSEA package version and
          are never hardcoded here -- this is a description of what's typically bundled.
        </p>
        <dl className="flex flex-col gap-4">
          {TAXON_SETS.map((set) => (
            <div
              key={set.name}
              className="rounded-lg border border-slate-200 p-4 dark:border-slate-800"
            >
              <dt className="font-mono text-sm font-semibold text-slate-900 dark:text-slate-50">{set.name}</dt>
              <dd className="mt-1 text-sm text-slate-700 dark:text-slate-300">
                {set.description}
                {set.href && (
                  <>
                    {' '}
                    <a
                      href={set.href}
                      target="_blank"
                      rel="noreferrer"
                      className="font-medium text-blue-600 underline-offset-4 hover:underline dark:text-blue-400"
                    >
                      {set.linkLabel}
                    </a>
                    .
                  </>
                )}
              </dd>
            </div>
          ))}
        </dl>
      </section>

      <section className="flex flex-col gap-3">
        <SectionHeading>Documentation</SectionHeading>
        <ul className="flex flex-col gap-1 text-sm">
          <li>
            <a
              href="https://github.com/seandavi/taxsea-online"
              target="_blank"
              rel="noreferrer"
              className="font-medium text-blue-600 underline-offset-4 hover:underline dark:text-blue-400"
            >
              GitHub repository
            </a>{' '}
            <span className="text-slate-600 dark:text-slate-400">-- source code, issues, and full README.</span>
          </li>
          <li>
            <a
              href="https://github.com/seandavi/taxsea-online/blob/main/docs/api.md"
              target="_blank"
              rel="noreferrer"
              className="font-medium text-blue-600 underline-offset-4 hover:underline dark:text-blue-400"
            >
              API documentation
            </a>{' '}
            <span className="text-slate-600 dark:text-slate-400">
              -- the full HTTP contract for submitting jobs and reading results, for anyone scripting against the
              API directly.
            </span>
          </li>
          <li>
            <a
              href="https://bioconductor.org/packages/TaxSEA/"
              target="_blank"
              rel="noreferrer"
              className="font-medium text-blue-600 underline-offset-4 hover:underline dark:text-blue-400"
            >
              TaxSEA on Bioconductor
            </a>{' '}
            <span className="text-slate-600 dark:text-slate-400">
              -- the R package this service wraps, including its reference manual and vignette.
            </span>
          </li>
        </ul>
      </section>

      <section id="citation" className="flex flex-col gap-2">
        <SectionHeading>Citation</SectionHeading>
        <p className="text-sm text-slate-700 dark:text-slate-300">
          This service is a thin web wrapper around TaxSEA; the enrichment analysis itself is entirely TaxSEA's. If
          you use results from this service in published work, please cite the package:
        </p>
        <p className="rounded-lg border border-slate-200 p-4 text-sm text-slate-700 dark:border-slate-800 dark:text-slate-300">
          Pham CM, Rankin TJ, Stinear TP, Walsh CJ, Ryan FJ. TaxSEA: rapid interpretation of microbiome alterations
          using taxon set enrichment analysis and public databases. <em>Briefings in Bioinformatics</em>.
          2025;26(2):bbaf173. doi:{' '}
          <a
            href="https://doi.org/10.1093/bib/bbaf173"
            target="_blank"
            rel="noreferrer"
            className="font-medium text-blue-600 underline-offset-4 hover:underline dark:text-blue-400"
          >
            10.1093/bib/bbaf173
          </a>
        </p>
        <p className="text-sm text-slate-700 dark:text-slate-300">
          A citation for TaxSEA-online itself (this web service) will be added here once it's published. Until then,
          if you'd like to reference the service, please link to the{' '}
          <a
            href="https://github.com/seandavi/taxsea-online"
            target="_blank"
            rel="noreferrer"
            className="font-medium text-blue-600 underline-offset-4 hover:underline dark:text-blue-400"
          >
            GitHub repository
          </a>
          .
        </p>
      </section>
    </main>
  );
}
