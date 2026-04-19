# PubMed / NCBI — Scraping & Data Extraction

`https://pubmed.ncbi.nlm.nih.gov` — 37 M+ biomedical citations. **Never use the browser for PubMed.** All data is reachable via `http_get` using the NCBI E-utilities REST API. No API key required; a free key raises the rate limit from 3 to 10 req/s.

## Do this first

**ESearch → ESummary is the fastest pipeline for most tasks — two calls, JSON responses, no XML parsing.**

```js
// Step 1: search → get PMIDs
const search = JSON.parse(await http_get(
  "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi" +
  "?db=pubmed&term=deep+learning+radiology&retmax=10&retmode=json"
));
const pmids = search.esearchresult.idlist;   // e.g. ['41999029', '41998456', ...]
const count = search.esearchresult.count;    // total hits across all pages

// Step 2: fetch lightweight metadata for all PMIDs in one call
const summary = JSON.parse(await http_get(
  `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi` +
  `?db=pubmed&id=${pmids.join(",")}&retmode=json`
));
const result = summary.result;
for (const uid of result.uids) {
  const art = result[uid];
  console.log(uid, art.pubdate, art.source);
  console.log("  ", art.title.slice(0, 80));
  console.log("  authors:", art.authors.slice(0, 3).map(a => a.name));
}
// Confirmed output (2026-04-18):
// 41999029 2026 Apr 18 Med Sci Monit
//    Use of Deep Learning Models in the Diagnosis of Proptosis Through Orbi
//    authors: ['Kesimal U', 'Akkaya HE', 'Polat Ö']
// 41998456 2026 Apr 17 Sci Rep
//    ...
```

Use **EFetch XML** when you need: full abstract text, MeSH terms, complete author names (not just "Last I"), structured abstract labels, or the DOI from within the article record.

## Common workflows

### Search PubMed (ESearch)

```js
const data = JSON.parse(await http_get(
  "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi" +
  "?db=pubmed" +
  "&term=large+language+models+clinical" +
  "&retmax=5" +
  "&retmode=json" +
  "&sort=pub+date" +                          // newest first; default is relevance
  "&datetype=pdat" +                          // filter by publication date
  "&mindate=2024/01/01&maxdate=2024/12/31"    // YYYY/MM/DD format
));
const result = data.esearchresult;
console.log("Total hits:", result.count);           // '24160' — note: string, not int
console.log("PMIDs:", result.idlist);
console.log("Query translation:", result.querytranslation);
// Confirmed output (2026-04-18):
// Total hits: 24160
// PMIDs: ['41996895', '41996722', '41996006', '41995888', '41995759']
// Query translation: "large language models"[MeSH Terms] OR ...
```

#### ESearch field tags (append to term)

```
machine learning[MeSH Terms]        MeSH controlled vocabulary
Hinton GE[Author]                   author last + initials
attention is all you need[Title]    title words
Nature[Journal]                     journal name
2024[pdat]                          publication year
```

Boolean operators: `AND`, `OR`, `NOT`. Phrase search: `"exact phrase"[Title]`.

#### Sort options (`sort=`)

| Value | Effect |
|---|---|
| *(omit)* | Relevance (default) |
| `pub+date` | Most recent publication first |
| `Author` | First author alphabetical |
| `JournalName` | Journal alphabetical |

### Lightweight metadata — ESummary (JSON, no XML)

```js
const data = JSON.parse(await http_get(
  "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi" +
  "?db=pubmed&id=41999029,41998456,41997837&retmode=json"
));
const result = data.result;
for (const uid of result.uids) {
  const art = result[uid];
  // Key fields available:
  const title           = art.title;            // full title string
  const source          = art.source;           // abbreviated journal name
  const fulljournalname = art.fulljournalname;
  const pubdate         = art.pubdate;          // e.g. '2026 Apr 18'
  const epubdate        = art.epubdate;         // e-pub ahead of print date (may be empty)
  const authors         = art.authors;          // list of {name: 'Last I', authtype: ...}
  const volume          = art.volume;
  const issue           = art.issue;
  const pages           = art.pages;
  const pubtype         = art.pubtype;          // list: ['Journal Article', 'Review', ...]
  // Extract DOI from elocationid or articleids:
  const doiField        = art.elocationid;      // e.g. 'doi: 10.12659/MSM.951157'
  const articleIds      = Object.fromEntries(art.articleids.map(x => [x.idtype, x.value]));
  const doi             = articleIds.doi;
  const pmcId           = articleIds.pmc;       // PMC ID if open access
  console.log(uid, pubdate, source);
  console.log(" ", title.slice(0, 70));
  console.log("  doi:", doi, "| pmc:", pmcId);
}
// Confirmed output (2026-04-18):
// 41999029 2026 Apr 18 Med Sci Monit
//    Use of Deep Learning Models in the Diagnosis of Proptosis Through Orbi
//   doi: 10.12659/MSM.951157 | pmc: undefined
```

### Full article metadata — EFetch XML

Use this for full abstracts, complete author names, MeSH terms, structured abstract sections.

Node has no stdlib XML parser — use regex with `[\s\S]*?` for dot-matches-newline against `<tag>...</tag>`.

```js
const raw = await http_get(
  "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi" +
  "?db=pubmed&id=41999029,36328784&retmode=xml&rettype=abstract"
);

// Helpers to extract tag contents; use [\s\S] to match across newlines.
function tagText(xml, tag) {
  const m = xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`));
  return m ? m[1].replace(/<[^>]+>/g, "").trim() : "";  // strip inner tags like <i>
}
function allTags(xml, tag) {
  return [...xml.matchAll(new RegExp(`<${tag}[^>]*>[\\s\\S]*?</${tag}>`, "g"))].map(m => m[0]);
}
function attr(xml, a) {
  const m = xml.match(new RegExp(`${a}="([^"]*)"`));
  return m ? m[1] : "";
}

const articles = allTags(raw, "PubmedArticle");
for (const art of articles) {
  const pmid = tagText(art, "PMID");
  const articleBlock = (art.match(/<Article[\s\S]*?<\/Article>/) || [""])[0];

  // Title — strip embedded tags like <i>, <sub>
  const title = tagText(articleBlock, "ArticleTitle");

  // Abstract — plain or structured (BACKGROUND / METHODS / RESULTS / CONCLUSION)
  const abstractBlock = (articleBlock.match(/<Abstract>[\s\S]*?<\/Abstract>/) || [""])[0];
  let abstract = "";
  if (abstractBlock) {
    const abstractTexts = allTags(abstractBlock, "AbstractText");
    const sections = abstractTexts.map(t => {
      const label = attr(t, "Label");
      const text = t.replace(/<AbstractText[^>]*>/, "").replace(/<\/AbstractText>/, "")
        .replace(/<[^>]+>/g, "").trim();
      return label ? `[${label}] ${text}` : text;
    });
    abstract = sections.join(" ");
  }  // ~15% of articles have no abstract

  // Journal + year
  const journalBlock = (articleBlock.match(/<Journal>[\s\S]*?<\/Journal>/) || [""])[0];
  const jTitle = tagText(journalBlock, "Title");
  const pubDateBlock = (journalBlock.match(/<PubDate>[\s\S]*?<\/PubDate>/) || [""])[0];
  const yearMatch = pubDateBlock.match(/<Year>([^<]+)<\/Year>/);
  const medlineMatch = pubDateBlock.match(/<MedlineDate>([^<]+)<\/MedlineDate>/);
  const year = yearMatch ? yearMatch[1]
    : medlineMatch ? medlineMatch[1].slice(0, 4) : "";

  // DOI
  const doiMatch = articleBlock.match(/<ELocationID[^>]*EIdType="doi"[^>]*>([^<]+)<\/ELocationID>/);
  const doi = doiMatch ? doiMatch[1] : "";

  // Authors — handle CollectiveName (consortium/group authors)
  const authorListBlock = (articleBlock.match(/<AuthorList[^>]*>[\s\S]*?<\/AuthorList>/) || [""])[0];
  const authors = [];
  if (authorListBlock) {
    for (const a of allTags(authorListBlock, "Author")) {
      const collective = tagText(a, "CollectiveName");
      const last = tagText(a, "LastName");
      const fore = tagText(a, "ForeName");
      if (collective) {
        authors.push(collective);
      } else if (last) {
        authors.push(fore ? `${last}, ${fore}` : last);
      }
    }
  }

  // MeSH controlled vocabulary terms
  const meshListBlock = (art.match(/<MeshHeadingList>[\s\S]*?<\/MeshHeadingList>/) || [""])[0];
  const meshTerms = [];
  if (meshListBlock) {
    for (const mh of allTags(meshListBlock, "MeshHeading")) {
      const d = tagText(mh, "DescriptorName");
      if (d) meshTerms.push(d);
    }
  }

  console.log(`PMID=${pmid} (${year}) ${jTitle}`);
  console.log(`  Title: ${title.slice(0, 70)}`);
  console.log(`  Authors: ${JSON.stringify(authors.slice(0, 3))}`);
  console.log(`  DOI: ${doi}`);
  console.log(`  MeSH: ${JSON.stringify(meshTerms.slice(0, 4))}`);
  console.log(`  Abstract: ${abstract.slice(0, 120)}`);
}
// Confirmed output (2026-04-18):
// PMID=41999029 (2026) Medical science monitor : international medical...
//   Title: Use of Deep Learning Models in the Diagnosis of Proptosis Thro
//   Authors: ['Kesimal, Uğur', 'Akkaya, Habip Eser', 'Polat, Önder']
//   DOI: 10.12659/MSM.951157
//   MeSH: ['Humans', 'Deep Learning', 'Exophthalmos', 'Magnetic Resonance Imaging']
//   Abstract: BACKGROUND Proptosis is a common manifestation of orbital disease...
// PMID=36328784 (...)
//   Abstract: [OBJECTIVES] Physical inactivity and sedentary behaviour...  ← structured
```

### Large result sets — usehistory + WebEnv

When `count` exceeds `retmax` (max 10 000), use server-side history to paginate EFetch without re-running ESearch on every page.

```js
// Step 1: ESearch with usehistory=y — NCBI holds result set on server
const search = JSON.parse(await http_get(
  "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi" +
  "?db=pubmed&term=CRISPR+gene+editing&retmax=0&retmode=json&usehistory=y"
));
const webenv    = search.esearchresult.webenv;       // server-side session token
const queryKey  = search.esearchresult.querykey;     // result set ID within session
const total     = parseInt(search.esearchresult.count, 10);
console.log(`Total: ${total}, WebEnv: ${webenv.slice(0, 30)}..., query_key: ${queryKey}`);
// Confirmed output (2026-04-18):
// Total: 24160, WebEnv: MCID_69e4203757db89391008d6f1..., query_key: 1

// Step 2: EFetch pages using WebEnv (no re-searching)
const batchSize = 200;
for (let start = 0; start < Math.min(total, 1000); start += batchSize) {  // cap at 1000 for demo
  const raw = await http_get(
    `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi` +
    `?db=pubmed&query_key=${queryKey}&WebEnv=${webenv}` +
    `&retstart=${start}&retmax=${batchSize}&retmode=xml&rettype=abstract`
  );
  const articles = [...raw.matchAll(/<PubmedArticle>[\s\S]*?<\/PubmedArticle>/g)];
  console.log(`  Fetched ${articles.length} articles (start=${start})`);
  // process articles here...
}
```

### EInfo — list available NCBI databases

```js
const data = JSON.parse(await http_get(
  "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/einfo.fcgi?retmode=json"
));
const dbs = data.einforesult.dblist;
console.log(`Total databases: ${dbs.length}`);   // Confirmed: 39 (2026-04-18)
console.log(dbs.slice(0, 10));
// ['pubmed', 'protein', 'nuccore', 'ipg', 'nucleotide', 'structure',
//  'genome', 'annotinfo', 'assembly', 'bioproject']
```

Get PubMed-specific metadata (field list, link list):

```js
const data = JSON.parse(await http_get(
  "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/einfo.fcgi?db=pubmed&retmode=json"
));
const dbInfo = data.einforesult.dbinfo[0];
console.log("DB name:", dbInfo.dbname);
console.log("Record count:", dbInfo.count);    // total PubMed records
const linkNames = (dbInfo.linklist ?? []).map(l => l.name);
console.log(`Link types (${linkNames.length}):`, linkNames.slice(0, 5));
// Confirmed (2026-04-18):
// DB name: pubmed
// Record count: 37620453
// Link types (48): ['pubmed_assembly', 'pubmed_bioproject', ...]
```

### ELink — cross-database linking

ELink connects a PubMed record to associated data in other NCBI databases. The `pubmed_pubmed` "related articles" linkname relies on a similarity server that is intermittently unavailable (returns `"Couldn't resolve #exLinkSrv2, the address table is empty."`). Use the non-similarity links below instead.

```js
// Link a PMID to its free full-text in PMC (if open access)
// linkname=pubmed_pmc — may also hit the server outage; check error field
const data = JSON.parse(await http_get(
  "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/elink.fcgi" +
  "?dbfrom=pubmed&id=38325330&linkname=pubmed_pmc&retmode=json"
));
const error = data.ERROR ?? "";
if (error) {
  console.log("ELink error:", error);   // 'Couldn't resolve #exLinkSrv2...' — NCBI server issue
} else {
  for (const ls of (data.linksets ?? [])) {
    for (const lsdb of (ls.linksetdbs ?? [])) {
      console.log(lsdb.linkname, "→", lsdb.links.slice(0, 5));
    }
  }
}
```

Available ELink linknames from pubmed (48 total):

| linkname | Target |
|---|---|
| `pubmed_pmc` | Free full text in PMC |
| `pubmed_pubmed_citedin` | Articles citing this paper |
| `pubmed_pubmed_refs` | References cited by this paper |
| `pubmed_gene` | Related Gene records |
| `pubmed_clinvar` | Clinical variants associated with publication |
| `pubmed_gds` | Related GEO datasets |

**Practical alternative**: If ELink is down, extract DOI from EFetch/ESummary and use `https://doi.org/{doi}` directly for the full-text link.

## URL and parameter reference

### E-utilities base URLs

```
https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi   # search → PMIDs
https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi  # PMIDs → JSON summary
https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi    # PMIDs → full XML
https://eutils.ncbi.nlm.nih.gov/entrez/eutils/elink.fcgi     # cross-db links
https://eutils.ncbi.nlm.nih.gov/entrez/eutils/einfo.fcgi     # DB metadata
```

### ESearch parameters

| Parameter | Values | Notes |
|---|---|---|
| `db` | `pubmed` | Always `pubmed` for PubMed |
| `term` | query string | Supports field tags like `[Author]`, `[Title]`, `[MeSH Terms]` |
| `retmax` | integer, max 10000 | Results returned per call |
| `retmode` | `json` | JSON output |
| `sort` | `pub+date`, `Author`, `JournalName` | Default is relevance |
| `datetype` | `pdat` (pub), `edat` (entrez), `mdat` (modified) | |
| `mindate`, `maxdate` | `YYYY/MM/DD` or `YYYY` | Requires `datetype` |
| `usehistory` | `y` | Store results on server; returns `webenv` + `querykey` |

### EFetch parameters

| Parameter | Values | Notes |
|---|---|---|
| `db` | `pubmed` | |
| `id` | `38000000,37999999` | Comma-separated PMIDs; max ~200 per call |
| `query_key` + `WebEnv` | from ESearch `usehistory=y` | Alternative to `id` for large sets |
| `retstart` | integer | Offset for pagination with WebEnv |
| `retmax` | integer, max 10000 | Batch size |
| `retmode` | `xml` | Use XML for EFetch (JSON not available for full records) |
| `rettype` | `abstract` | Returns abstract + core metadata |

### PubMed article URL construction

```js
const pmid = "41999029";
const pubmedUrl  = `https://pubmed.ncbi.nlm.nih.gov/${pmid}/`;
const doi        = "10.12659/MSM.951157";
const doiUrl     = `https://doi.org/${doi}`;       // resolves to publisher page
const pmcId      = "PMC9876543";                   // from ESummary articleids
const pmcUrl     = `https://www.ncbi.nlm.nih.gov/pmc/articles/${pmcId}/`;
```

## Gotchas

- **`count` is a string, not int.** `search.esearchresult.count` returns `'24160'`, not `24160`. Always cast with `parseInt(..., 10)` before arithmetic.

- **EFetch retmode must be `xml` for full records.** Unlike ESearch and ESummary, EFetch with `retmode=json` returns flat text (the MEDLINE citation text format), not structured JSON. Parse EFetch responses with regex against the XML (Node has no stdlib XML parser).

- **`ArticleTitle` may contain embedded XML tags.** Titles with italics (`<i>Staphylococcus aureus</i>`) or math (`<sub>2</sub>`) are mixed-content nodes. Strip inner tags with `.replace(/<[^>]+>/g, "")` rather than assuming the title is plain text.

- **~15% of articles have no abstract.** The `<Abstract>` block may be absent for short communications, editorials, letters, and older records. Always guard before extracting abstract text.

- **Author names vary in structure — always handle `CollectiveName`.** Consortium papers list a group name (`'GeKeR Study Group'`, `'Breast Cancer Association Consortium'`) under `<CollectiveName>` instead of `<LastName>/<ForeName>`. Individual authors have `<LastName>` + optionally `<ForeName>` and `<Initials>`. Check `CollectiveName` first; falling through to `LastName` without the check produces empty/null values.
  - Confirmed real examples (2026-04-18): PMID 37586835 (`GeKeR Study Group`), PMID 36328784 (`Breast Cancer Association Consortium`)

- **PubDate has three possible structures.** Most articles have `<Year>` + optional `<Month>` + optional `<Day>`. Seasonal journals use `<Season>` (e.g. `Jul-Aug`, `Oct-Dec`) instead of `<Month>`. A minority of older records use `<MedlineDate>` (e.g. `1995 Fall`) with no `<Year>`. Safe extraction pattern:
  ```js
  const yearMatch = pubDateBlock.match(/<Year>([^<]+)<\/Year>/);
  const medlineMatch = pubDateBlock.match(/<MedlineDate>([^<]+)<\/MedlineDate>/);
  const year = yearMatch ? yearMatch[1]
    : medlineMatch ? medlineMatch[1].slice(0, 4) : "";
  ```

- **Batch EFetch: keep IDs to ~200 per call.** The API accepts comma-separated IDs in `id=`, but very large batches (500+) occasionally time out or return truncated XML. For >200 articles, iterate in chunks or use `usehistory` + `WebEnv`.

- **ELink `pubmed_pubmed` (related articles) is intermittently broken.** The NCBI similarity server returns `"Couldn't resolve #exLinkSrv2, the address table is empty."` — this is a persistent server-side issue as of 2026-04-18, not a rate-limit error. Other linknames (`pubmed_gene`, `pubmed_pmc`, `pubmed_clinvar`) fail with the same error. Use the DOI as a fallback link to publisher full text.

- **Rate limits: 3 req/s without API key, 10 req/s with free key.** Exceeding 3 req/s returns HTTP 429. Insert `await wait(0.34)` between sequential calls without a key. Get a free API key at https://www.ncbi.nlm.nih.gov/account/ and append `&api_key=YOUR_KEY` to all URLs.

- **`retmax` upper bound is 10 000 for ESearch.** To retrieve more than 10 000 PMIDs for a search, use `usehistory=y` and page through EFetch with `retstart` offsets. EFetch itself also accepts `retmax` up to 10 000 per call.

- **`retmax=0` in ESearch returns only the count, not IDs — useful for counting.** Combine with `usehistory=y` to store the result for later paging without fetching IDs upfront:
  ```js
  const search = JSON.parse(await http_get(
    "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi" +
    "?db=pubmed&term=cancer&retmax=0&retmode=json&usehistory=y"
  ));
  const total  = parseInt(search.esearchresult.count, 10);   // e.g. 4800000
  const webenv = search.esearchresult.webenv;
  ```

- **ESummary `authors` field uses abbreviated names (`Last I`), not full names.** Use EFetch XML to get `ForeName` (e.g. `'Kesimal, Uğur'` vs ESummary `'Kesimal U'`). For bulk tasks where full names are not needed, ESummary is faster.

- **`querytranslation` shows how NCBI interpreted your term.** The ESearch response includes `esearchresult.querytranslation` — a MeSH-expanded version of your query. Inspect it to verify the search matched what you intended.
