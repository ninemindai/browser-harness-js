# arXiv Bulk Harvest + Semantic Scholar — OAI-PMH & Citation Enrichment

Companion to `domain-skills/arxiv/scraping.md`. Use the **arxiv** skill for search-and-fetch workflows. Use **this skill** when you need:

- Bulk-harvesting all papers in a subject area or date window (OAI-PMH)
- Citation counts, influential-citation scores, and cross-database IDs (Semantic Scholar)
- Per-paper version history and submitter info (`arXivRaw` metadata)

No API key required for either endpoint. Both return JSON or XML over plain HTTP.

> Node has no stdlib XML parser. OAI-PMH XML is extracted with regex below — see the companion `arxiv` skill for the same pattern.

---

## OAI-PMH bulk harvest

### Endpoint (confirmed 2026-04-19)

```
https://oaipmh.arxiv.org/oai
```

`https://export.arxiv.org/oai2` is the old URL — it 301-redirects to the new one. `http_get` (which uses `fetch` under the hood) will follow the redirect automatically, but prefer the canonical URL to avoid the extra round-trip.

### Harvest all cs papers from a date window

```js
function parse_oai_record(rec_xml) {
  // Returns null for deleted records (header has status="deleted")
  const metaMatch = rec_xml.match(/<arXiv:arXiv\b[\s\S]*?<\/arXiv:arXiv>/) || rec_xml.match(/<arXiv[\s\S]*?<\/arXiv>/);
  const meta = metaMatch ? metaMatch[0] : null;
  if (!meta) return null;
  const pick = (tag, src = meta) => (src.match(new RegExp(`<arXiv:${tag}>([\\s\\S]*?)</arXiv:${tag}>`))?.[1] || "").trim();
  const datestamp = rec_xml.match(/<datestamp>([\s\S]*?)<\/datestamp>/)?.[1]?.trim() || null;
  const authorBlocks = [...meta.matchAll(/<arXiv:author>([\s\S]*?)<\/arXiv:author>/g)].map(m => m[1]);
  const authors = authorBlocks.map(a => {
    const fn = (a.match(/<arXiv:forenames>([\s\S]*?)<\/arXiv:forenames>/)?.[1] || "").trim();
    const ln = (a.match(/<arXiv:keyname>([\s\S]*?)<\/arXiv:keyname>/)?.[1] || "").trim();
    return `${fn} ${ln}`.trim();
  });
  return {
    id:          pick("id"),
    datestamp,
    created:     pick("created"),
    updated:     pick("updated"),
    title:       pick("title"),
    authors,
    categories:  pick("categories").split(/\s+/).filter(Boolean),
    abstract:    pick("abstract"),
    doi:         pick("doi") || null,
    journal_ref: (meta.match(/<arXiv:journal-ref>([\s\S]*?)<\/arXiv:journal-ref>/)?.[1] || "").trim() || null,
    license:     pick("license") || null,
  };
}

async function fetch_oai_page(url) {
  // Fetch one OAI-PMH page; return [records_xml_list, next_token_or_null].
  const xml = await http_get(url);
  const records = [...xml.matchAll(/<record>([\s\S]*?)<\/record>/g)].map(m => m[1]);
  const token = (xml.match(/<resumptionToken[^>]*>([\s\S]*?)<\/resumptionToken>/)?.[1] || "").trim() || null;
  return [records, token];
}

// --- Main harvest loop ---
const BASE = "https://oaipmh.arxiv.org/oai";
const first_url = `${BASE}?verb=ListRecords&metadataPrefix=arXiv&set=cs&from=2024-01-01&until=2024-01-02`;

const papers = [];
let url = first_url;
while (url) {
  const [records, token] = await fetch_oai_page(url);
  for (const rec of records) {
    const p = parse_oai_record(rec);
    if (p) papers.push(p);
  }
  console.log(`  fetched ${records.length} records, total so far: ${papers.length}`);
  if (token) {
    url = `${BASE}?verb=ListRecords&resumptionToken=${encodeURIComponent(token)}`;
    await wait(5);   // OAI-PMH policy: >=5s between pages
  } else {
    url = null;
  }
}

console.log(`Done. ${papers.length} papers harvested.`);
// Confirmed output for cs, 2024-01-01 to 2024-01-02:
// fetched 44 records, total so far: 44
// Done. 44 papers harvested.
// For 2024-01-01 to 2024-01-07 (cs): multiple pages, resumptionToken issued when >~200 records
```

### Available verbs

| Verb | Purpose | Key params |
|---|---|---|
| `Identify` | Repository info, earliest datestamp (`2005-09-16`) | — |
| `ListSets` | All harvestable sets (see table below) | — |
| `ListMetadataFormats` | `oai_dc`, `arXiv`, `arXivOld`, `arXivRaw` | — |
| `ListRecords` | Bulk harvest with date/set filter | `metadataPrefix`, `set`, `from`, `until` |
| `GetRecord` | Single record by OAI identifier | `identifier`, `metadataPrefix` |

### Top-level sets (confirmed)

| setSpec | Name |
|---|---|
| `cs` | Computer Science (all) |
| `cs:cs` | Computer Science (subset notation — same scope) |
| `math` | Mathematics |
| `physics` | Physics |
| `stat` | Statistics |
| `eess` | Electrical Engineering and Systems Science |
| `econ` | Economics |
| `q-bio` | Quantitative Biology |
| `q-fin` | Quantitative Finance |

Subset sets use `topic:topic:SUBCATEGORY` notation, e.g. `cs:cs:LG` for Machine Learning. List all with `verb=ListSets`.

### Available metadata formats

- `arXiv` — rich: id, created/updated dates, authors (keyname + forenames separately), categories, abstract, doi, journal-ref, license. **Use this.**
- `arXivRaw` — adds `<submitter>`, per-version history (`<version version="v1">` with date and file size), author list as flat string. Use when you need version history.
- `oai_dc` — Dublin Core, minimal. Skip unless you need cross-system compatibility.
- `arXivOld` — legacy format pre-2007. Skip.

### GetRecord + arXivRaw (version history)

```js
const xml = await http_get(
  "https://oaipmh.arxiv.org/oai"
  + "?verb=GetRecord"
  + "&metadataPrefix=arXivRaw"
  + "&identifier=oai:arXiv.org:1706.03762"
);
const meta = xml.match(/<arXivRaw\b[\s\S]*?<\/arXivRaw>/)?.[0] || "";

const title     = meta.match(/<title>([\s\S]*?)<\/title>/)?.[1]?.trim();
const submitter = meta.match(/<submitter>([\s\S]*?)<\/submitter>/)?.[1]?.trim();
const versions  = [...meta.matchAll(/<version\s+version="([^"]+)">([\s\S]*?)<\/version>/g)];
for (const [, vnum, vbody] of versions) {
  const date = vbody.match(/<date>([\s\S]*?)<\/date>/)?.[1]?.trim();
  console.log(vnum, date);
}
// Confirmed output for 1706.03762 ("Attention Is All You Need"):
// v1 Mon, 12 Jun 2017 17:57:34 GMT
// v2 Mon, 19 Jun 2017 16:49:45 GMT
// ...
// v7 Wed, 02 Aug 2023 00:41:18 GMT
// submitter: Llion Jones
```

---

## Semantic Scholar — citation enrichment for arXiv papers

No API key required (unauthenticated: 1 req/s, 5000 req/day). With a free key the limit rises to 100 req/s.

Base URL: `https://api.semanticscholar.org/graph/v1/`

### Single paper lookup by arXiv ID

```js
const paper = JSON.parse(await http_get(
  "https://api.semanticscholar.org/graph/v1/paper/arXiv:1706.03762"
  + "?fields=title,year,venue,publicationDate,citationCount,"
  + "influentialCitationCount,authors,abstract,externalIds"
));
console.log(paper.title);                    // "Attention is All you Need"
console.log(paper.citationCount);            // 173155  (confirmed 2026-04-19)
console.log(paper.influentialCitationCount); // 19629
console.log(paper.venue);                    // "Neural Information Processing Systems"
console.log(paper.externalIds.ArXiv);        // "1706.03762"
console.log(paper.externalIds.DOI);          // undefined if no DOI
for (const a of paper.authors) {
  console.log(a.name, a.authorId);
}
```

The ID format `arXiv:NNNN.NNNNN` is accepted directly — no conversion needed.

### Batch lookup (up to 500 IDs per POST)

`http_get` is GET-only. Use `fetch` directly for POST.

```js
const ids = ["arXiv:1706.03762", "arXiv:1810.04805", "arXiv:2005.14165"];
const fields = "paperId,externalIds,title,year,citationCount,influentialCitationCount";

const r = await fetch(
  `https://api.semanticscholar.org/graph/v1/paper/batch?fields=${fields}`,
  {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ids }),
    signal: AbortSignal.timeout(20_000),
  }
);
const results = await r.json();

for (const p of results) {
  console.log(p.externalIds.ArXiv, p.citationCount, (p.title || "").slice(0, 50));
}
// Confirmed output (2026-04-19):
// 1706.03762  173155  Attention is All you Need
// 1810.04805  113138  BERT: Pre-training of Deep Bidirectional Tran...
// 2005.14165  (varies)  Language Models are Few-Shot Learners
```

### Paper search

```js
const results = JSON.parse(await http_get(
  "https://api.semanticscholar.org/graph/v1/paper/search"
  + "?query=large+language+model"
  + "&fields=paperId,externalIds,title,year,citationCount"
  + "&limit=5"
));
const total = results.total;   // e.g. 3473582 for "large language model"
for (const p of results.data) {
  const arxiv_id = p.externalIds?.ArXiv || "no-arxiv";
  console.log(arxiv_id, p.year, p.citationCount, (p.title || "").slice(0, 50));
}
// next page: use offset=5, offset=10, etc.
```

### Available fields (pass as comma-separated `fields=` query param)

| Field | Type | Notes |
|---|---|---|
| `paperId` | str | Semantic Scholar internal ID |
| `externalIds` | object | Keys: `ArXiv`, `DOI`, `DBLP`, `MAG`, `ACL`, `CorpusId` |
| `title` | str | |
| `abstract` | str | |
| `year` | int | Publication year |
| `publicationDate` | str | `YYYY-MM-DD` |
| `venue` | str | Conference/journal name |
| `citationCount` | int | Total citations |
| `influentialCitationCount` | int | Citations deemed highly influential |
| `authors` | array | Each: `{authorId, name}` |
| `references` | array | List of paper objects (needs own `fields`) |
| `citations` | array | Citing papers (needs own `fields`) |
| `openAccessPdf` | object | `{url, status, license}` |

---

## Downloading PDFs

Direct PDF download — no auth, no redirect for versionless URLs (returns 200 + PDF body directly).

```js
const { writeFileSync } = await import("node:fs");

async function download_pdf(arxiv_id, dest_path, version = null) {
  // arxiv_id: bare ID like '1706.03762' or versioned '1706.03762v7'
  // version:  if given, appended as 'v{version}' — ignored if arxiv_id already has version
  // dest_path: where to save, e.g. '/tmp/paper.pdf'
  const lastSegment = arxiv_id.split(".").pop();
  if (!/v\d+$/.test(lastSegment) && version) {
    arxiv_id = `${arxiv_id}v${version}`;
  }
  const url = `https://arxiv.org/pdf/${arxiv_id}`;
  const r = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0" },
    signal: AbortSignal.timeout(60_000),
  });
  const buf = Buffer.from(await r.arrayBuffer());
  writeFileSync(dest_path, buf);
  console.log(`Saved ${buf.length} bytes to ${dest_path}`);
}

await download_pdf("1706.03762", "/tmp/attention.pdf");
// Confirmed: saves 2215244 bytes, filename hint in header: '1706.03762v7.pdf'
// Versionless URL resolves to latest version server-side (no redirect, 200 direct)
```

---

## Gotchas

- **OAI-PMH endpoint moved.** `https://export.arxiv.org/oai2` 301-redirects to `https://oaipmh.arxiv.org/oai`. `http_get` (backed by `fetch`) follows redirects automatically, but prefer the canonical URL.

- **OAI-PMH rate limit: 5 seconds between pages.** The protocol requires a `Retry-After` interval. The server embeds an `expirationDate` on the resumptionToken. Violating the rate limit causes the token to be invalidated and the harvest fails silently. Always `await wait(5)` between pages.

- **Resumption token is opaque — encode it once for the URL.** The token contains `=`, `&`, `:` and other URL-unsafe chars. Pass it through `encodeURIComponent` exactly once when building the next URL.

- **`datestamp` in OAI-PMH is last-modified date, not submission date.** A paper submitted in 2008 can appear in a 2024 harvest window if it was revised then. The `<created>` and `<updated>` fields inside the `<arXiv>` metadata are the actual submission/revision dates.

- **Deleted records have no `<metadata>` element.** The `<header>` will carry `status="deleted"`. `parse_oai_record` above returns `null` in that case — filter them out.

- **Author structure differs between OAI-PMH formats.** In `arXiv` metadata, authors are structured: `<author><keyname>Vaswani</keyname><forenames>Ashish</forenames></author>`. In `arXivRaw`, they're a flat comma-separated string: `Ashish Vaswani, Noam Shazeer, ...`. In the Atom API, it's `<name>Ashish Vaswani</name>` (first-last order). Pick the source that matches your downstream use.

- **Semantic Scholar 429 under unauthenticated bursts.** The unauthenticated limit is ~1 req/s. Rapid parallel calls return `{"code": "429"}`. Add `await wait(1)` between single lookups or use the batch POST endpoint (up to 500 IDs, single request) to stay under the limit. The batch endpoint itself counts as 1 request.

- **Semantic Scholar `externalIds` may lack `ArXiv` key.** Not all papers have an arXiv preprint. When enriching an arXiv list with S2 data, always use `p.externalIds?.ArXiv` not `p.externalIds.ArXiv`.

- **Atom API rate limit: 1 request per 3 seconds for sustained crawls.** The API returns HTTP 429 `"Rate exceeded."` on rapid-fire requests. The OAI-PMH endpoint is designed for bulk and is more tolerant, but still requires the 5s sleep between resumption pages.

- **OAI-PMH `set` param uses colon-separated hierarchy, not dot.** The Atom API uses `cat:cs.LG`; OAI-PMH uses `set=cs:cs:LG`. Using `set=cs.LG` returns zero results.

- **`http_get` in JS uses `fetch` and follows redirects by default.** Unlike the Python `urllib` version (which does not), you don't need to manually re-issue on 301/302. If you need the raw status code or final URL, use `fetch` directly and inspect `r.status` / `r.url`.

---

## How this complements the existing arxiv skill

| Task | Use |
|---|---|
| Search by keyword, author, or category | `arxiv` skill — Atom API |
| Fetch 1–2000 specific papers by ID | `arxiv` skill — `id_list` batch |
| Harvest all papers in a subject over a date range | **this skill** — OAI-PMH |
| Get citation counts / influential citations | **this skill** — Semantic Scholar |
| Get per-version history and submitter name | **this skill** — OAI-PMH `arXivRaw` |
| Download a PDF | either skill (same URL structure) |
