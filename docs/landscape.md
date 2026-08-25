# Landscape: what already exists

Researched 2026-08-25, against primary sources (the TaxSEA paper, the tools' own repos, and
live checks of the deployed services). This had never been done for this project — nothing in
`PLAN.md`, the issue tracker, or `spec.md` addresses prior art.

**Headline: TaxSEA already ships an official web portal.** `taxsea-online` is not the first
browser interface to TaxSEA, and the milestone that assumes it is (M13, publication readiness)
rests on a premise that does not hold.

## 1. Shiny TaxSEA — the official portal

- **URL:** <https://shiny.taxsea.app> — verified live, HTTP 200, on 2026-08-25.
- **Source:** <https://github.com/timrankin/Shiny-TaxSEA> (GPL-3).
- **Status:** works; last commit **2025-03-16**, so ~17 months dormant. 1 star.
- **Named in the TaxSEA paper itself.** Briefings in Bioinformatics
  ([bbaf173](https://academic.oup.com/bib/article/26/2/bbaf173/8116684)), Data Availability:

  > "An R shiny app can be found on GitHub (https://github.com/timrankin/Shiny-TaxSEA) and is
  > also available online (shiny.taxsea.app)."

  and in the Introduction: *"TaxSEA is available as packages in R and Python and a web portal at
  https://shiny.taxsea.app"*.

What it actually offers, from a live inspection of the rendered app:

| | Shiny TaxSEA | taxsea-online |
|---|---|---|
| Input | **File upload** (csv/xlsx) | Paste only (no upload) |
| Enrichment mode | yes | yes |
| ORA mode | not exposed | **yes** |
| Visualisation | **bar plot, volcano plot** | none |
| Results table | one table, DB selector | 6 collections, sortable/filterable |
| Export | download buttons | TSV per collection, full JSON |
| Sample data | yes | yes |
| Hosting | Shiny server | Cloudflare Workers + container |
| Maintenance | dormant since 2025-03 | active |

## 2. MicrobiomeAnalyst 2.0 — TSEA module

<https://www.microbiomeanalyst.ca> — a large, well-cited, actively maintained platform
([NAR 2023](https://academic.oup.com/nar/article/51/W1/W310/7160190)) with a dedicated **Taxon
Set Enrichment Analysis (TSEA)** module: hypergeometric tests against taxon set libraries drawn
from gutMDisorder, GIMICA and MiMeDB, covering immune, metabolite, cancer and drug-treatment
taxon sets.

Different algorithm (hypergeometric over-representation vs TaxSEA's GSEA-like ranking) and a
different set library, but it occupies the same user-facing niche: *paste/upload microbiome
features, get enriched taxon sets, in a browser, for free*.

## 3. Also in the space

- **CBEA** (Competitive Balances for taxonomic Enrichment Analysis) — method + R package, no
  hosted UI.
- **BugSigDB** <https://bugsigdb.org> — the curated signature database TaxSEA consumes; has its
  own web interface for browsing signatures, though not for enrichment analysis.

## 4. What this means

Honest reading of the overlap:

- **The core proposition — "run TaxSEA in a browser, free, no install" — is already delivered**
  by the tool's own authors, and advertised in the paper every prospective user will read first.
- `taxsea-online`'s real differentiators are **ORA mode**, richer result tables across all six
  collections, and serverless hosting with no Shiny server to keep alive. Those are genuine but
  narrow.
- It is also currently **behind** the official portal on two things users notice immediately:
  **file upload** and **plots**.
- The dormancy of Shiny TaxSEA (17 months) is the strongest argument for a second
  implementation — but "the incumbent is unmaintained" is a reason to contribute to or adopt it,
  not automatically to duplicate it.

## 5. Consequences for the backlog

- **M13 (publication readiness) is the one directly invalidated.** A paper or DOI positioning
  this as *the* TaxSEA web interface would be publishing against a portal the TaxSEA paper
  already cites. This needs a decision before any of #81–#85 is worth doing.
- **M10 (security) and M12 (attribution) stand regardless.** The service is publicly deployed
  today; securing it and crediting BugSigDB/MiMeDB/gutMGene correctly are obligations of running
  it at all, not bets on its novelty.
- **M11 (results UX) is worth doing only if the project continues**, and if it does, file upload
  and plots should probably outrank the current M11 items, since that is exactly where the
  official portal is ahead.

## 6. Open question for the maintainer

See issue #100. The collaboration context (the TaxSEA team's possible involvement) sits outside
this repo, and materially changes the answer — this document deliberately records only what is
publicly verifiable.
