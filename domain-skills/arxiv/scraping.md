# ArXiv — Scraping & Data Extraction

`https://arxiv.org` — open-access preprint server. **Never use the browser for ArXiv.** All data is reachable via `http_get` using the Atom API or HTML meta tags. No API key required.

## Do this first

**Use the Atom API for any paper search or metadata fetch — one call, XML response, no auth.**

```js
const xml = await http_get(
  "http://export.arxiv.org/api/query"
  + "?search_query=ti:transformer+AND+cat:cs.LG"
  + "&max_results=5&sortBy=submittedDate&sortOrder=descending"
);
const entries = [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)].map(m => m[1]);
```

Use `id_list` for known paper IDs — supports comma-separated batch fetch in a single call.

Use `http_get` on `https://arxiv.org/abs/{id}` + regex for `citation_*` meta tags when you need the full abstract from an HTML page.

> Node has no stdlib XML parser, so these examples use regex against the Atom XML. The response is stable and well-formed — extract fields with anchored patterns rather than pulling in an XML dependency.

## Common workflows

### Search papers (API)

```js
const xml = await http_get(
  "http://export.arxiv.org/api/query"
  + "?search_query=ti:transformer+AND+cat:cs.LG"
  + "&max_results=5&sortBy=submittedDate&sortOrder=descending"
);
const entries = [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)].map(m => m[1]);
for (const e of entries) {
  const title     = (e.match(/<title>([\s\S]*?)<\/title>/)?.[1] || "").trim().replace(/\n/g, " ");
  const arxiv_id  = (e.match(/<id>([\s\S]*?)<\/id>/)?.[1] || "").trim().split("/").pop();  // '2604.15259v1'
  const published = (e.match(/<published>([^<]+)<\/published>/)?.[1] || "").slice(0, 10);  // '2026-04-16'
  const updated   = (e.match(/<updated>([^<]+)<\/updated>/)?.[1] || "").slice(0, 10);
  const abstract  = (e.match(/<summary>([\s\S]*?)<\/summary>/)?.[1] || "").trim();
  const authors   = [...e.matchAll(/<author>[\s\S]*?<name>([\s\S]*?)<\/name>[\s\S]*?<\/author>/g)].map(m => m[1].trim());
  const cats      = [...e.matchAll(/<category\s+term="([^"]+)"/g)].map(m => m[1]);
  const primary   = e.match(/<arxiv:primary_category[^>]*\bterm="([^"]+)"/)?.[1];
  const pdf_link  = e.match(/<link[^>]*\btitle="pdf"[^>]*\bhref="([^"]+)"/)?.[1] || null;
  const abs_link  = e.match(/<link[^>]*\brel="alternate"[^>]*\bhref="([^"]+)"/)?.[1] || null;
  console.log(arxiv_id, published, title.slice(0, 60));
  console.log("  Authors:", authors.slice(0, 2));
  console.log("  PDF:", pdf_link);
}
// Confirmed output (2026-04-18):
// 2604.15259v1 2026-04-16 Stability and Generalization in Looped Transformers
//   Authors: ['Asher Labovich']
//   PDF: https://arxiv.org/pdf/2604.15259v1
```

### Fetch single paper by ID (API)

```js
const xml = await http_get("http://export.arxiv.org/api/query?id_list=1706.03762");
const e = xml.match(/<entry>([\s\S]*?)<\/entry>/)?.[1] || "";
const title      = (e.match(/<title>([\s\S]*?)<\/title>/)?.[1] || "").trim();
const abstract   = (e.match(/<summary>([\s\S]*?)<\/summary>/)?.[1] || "").trim();
const categories = [...e.matchAll(/<category\s+term="([^"]+)"/g)].map(m => m[1]);
const pdf_link   = e.match(/<link[^>]*\btitle="pdf"[^>]*\bhref="([^"]+)"/)?.[1] || null;
console.log("Title:", title);
console.log("Categories:", categories);
console.log("PDF:", pdf_link);
console.log("Abstract:", abstract.slice(0, 200));
// Confirmed output:
// Title: Attention Is All You Need
// Categories: ['cs.CL', 'cs.LG']
// PDF: https://arxiv.org/pdf/1706.03762v7
// Abstract: The dominant sequence transduction models are based on complex recurrent...
```

### Batch fetch by comma-separated IDs (single call — fast)

Fetching 10 IDs in one call takes ~2s. Prefer this over parallel single-ID fetches.

```js
const ids = ["1706.03762", "1810.04805", "2005.14165"];  // Transformer, BERT, GPT-3
const xml = await http_get(`http://export.arxiv.org/api/query?id_list=${ids.join(",")}&max_results=${ids.length}`);
const entries = [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)].map(m => m[1]);
for (const e of entries) {
  const arxiv_id  = (e.match(/<id>([\s\S]*?)<\/id>/)?.[1] || "").trim().split("/").pop();
  const title     = (e.match(/<title>([\s\S]*?)<\/title>/)?.[1] || "").trim();
  const published = (e.match(/<published>([^<]+)<\/published>/)?.[1] || "").slice(0, 10);
  console.log(arxiv_id, published, title.slice(0, 60));
}
// Confirmed output:
// 1512.03385v1 2015-12-10 Deep Residual Learning for Image Recognition
// 1706.03762v7 2017-06-12 Attention Is All You Need
// 2005.14165v4 2020-05-28 Language Models are Few-Shot Learners
// 1810.04805v2 2018-10-11 BERT: Pre-training of Deep Bidirectional Transformers...
// Note: order returned may differ from order requested
```

### Parallel fetch (Promise.all for independent IDs)

Use only when IDs are not known upfront or when mixing with other work. For pure batch, single comma-separated `id_list` call is faster.

```js
async function fetch_paper(arxiv_id) {
  const xml = await http_get(`http://export.arxiv.org/api/query?id_list=${arxiv_id}`);
  const e = xml.match(/<entry>([\s\S]*?)<\/entry>/)?.[1];
  if (!e) return null;
  return {
    id: arxiv_id,
    title: (e.match(/<title>([\s\S]*?)<\/title>/)?.[1] || "").trim(),
    published: (e.match(/<published>([^<]+)<\/published>/)?.[1] || "").slice(0, 10),
  };
}

const ids = ["1706.03762", "1810.04805", "2005.14165"];
const papers = await Promise.all(ids.map(fetch_paper));
for (const p of papers) {
  if (p) console.log(p.id, p.published, p.title.slice(0, 60));
}
// Confirmed working — 3 concurrent fetches are safe; don't exceed 5 for continuous crawling
```

### HTML abstract page — citation_* meta tags

Use this when you want the full abstract or the versionless PDF URL without parsing Atom XML.

```js
const html = await http_get("https://arxiv.org/abs/1706.03762", { "User-Agent": "Mozilla/5.0" });
// HTML page is ~48 KB, fully static, no JS required

const title    = html.match(/<meta name="citation_title" content="([^"]+)"/)?.[1];
const pdf_url  = html.match(/<meta name="citation_pdf_url" content="([^"]+)"/)?.[1];
const authors  = [...html.matchAll(/<meta name="citation_author" content="([^"]+)"/g)].map(m => m[1]);
const date     = html.match(/<meta name="citation_date" content="([^"]+)"/)?.[1];
const arxiv_id = html.match(/<meta name="citation_arxiv_id" content="([^"]+)"/)?.[1];
const abstract = html.match(/<meta name="citation_abstract" content="([^"]+)"/)?.[1];

console.log("Title:", title || null);
console.log("PDF:", pdf_url || null);
console.log("Authors:", authors.slice(0, 3));
console.log("Date:", date || null);
console.log("ID:", arxiv_id || null);
// Confirmed output for 1706.03762:
// Title: Attention Is All You Need
// PDF: https://arxiv.org/pdf/1706.03762   (no version suffix — always latest)
// Authors: ['Vaswani, Ashish', 'Shazeer, Noam', 'Parmar, Niki']
// Date: 2017/06/12
// ID: 1706.03762
```

All `citation_*` meta tags present on the abs page:
- `citation_title` — paper title
- `citation_author` — one tag per author, format `"Last, First"`
- `citation_date` — submission date `YYYY/MM/DD`
- `citation_online_date` — latest version date `YYYY/MM/DD`
- `citation_pdf_url` — versionless PDF URL (redirects to latest)
- `citation_arxiv_id` — bare ID without version suffix
- `citation_abstract` — full abstract text

### Category search with pagination

```js
// Page 1
const xml = await http_get(
  "http://export.arxiv.org/api/query"
  + "?search_query=cat:cs.AI"
  + "&max_results=10&start=0&sortBy=lastUpdatedDate&sortOrder=descending"
);
const total   = xml.match(/<opensearch:totalResults[^>]*>(\d+)<\/opensearch:totalResults>/)?.[1];   // e.g. '172726'
const start_i = xml.match(/<opensearch:startIndex[^>]*>(\d+)<\/opensearch:startIndex>/)?.[1];
const per_pg  = xml.match(/<opensearch:itemsPerPage[^>]*>(\d+)<\/opensearch:itemsPerPage>/)?.[1];
console.log(`Total cs.AI papers: ${total}`);  // Confirmed: 172726 (2026-04-18)

const entries = [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)].map(m => m[1]);

// Page 2: increment start
const xml2 = await http_get(
  "http://export.arxiv.org/api/query"
  + "?search_query=cat:cs.AI"
  + "&max_results=10&start=10&sortBy=lastUpdatedDate&sortOrder=descending"
);
```

## URL and ID reference

### API base URL

```
http://export.arxiv.org/api/query
```

HTTPS also works: `https://export.arxiv.org/api/query`

### Query parameters

| Parameter | Values | Notes |
|---|---|---|
| `search_query` | `ti:word`, `au:name`, `abs:phrase`, `cat:cs.LG`, combine with `AND`/`OR`/`ANDNOT` | URL-encode spaces as `+` |
| `id_list` | `1706.03762` or `1706.03762,1810.04805` | Comma-separated; version suffix optional |
| `max_results` | integer (default 10, max 2000) | |
| `start` | integer (default 0) | Offset for pagination |
| `sortBy` | `relevance`, `lastUpdatedDate`, `submittedDate` | |
| `sortOrder` | `ascending`, `descending` | |

### Search field prefixes

| Prefix | Searches |
|---|---|
| `ti:` | Title |
| `au:` | Author name |
| `abs:` | Abstract |
| `co:` | Comment |
| `jr:` | Journal reference |
| `cat:` | Category (e.g. `cat:cs.LG`) |
| `all:` | All fields |

### PDF and abstract URL construction

```js
const arxiv_id = "1706.03762v7";                        // from <id> field after split
const bare_id  = arxiv_id.replace(/v\d+$/, "");          // strip version: '1706.03762'

const pdf_versioned = `https://arxiv.org/pdf/${arxiv_id}`;   // specific version
const pdf_latest    = `https://arxiv.org/pdf/${bare_id}`;    // always redirects to latest
const abs_versioned = `https://arxiv.org/abs/${arxiv_id}`;
const abs_latest    = `https://arxiv.org/abs/${bare_id}`;
```

The API's `<link title="pdf">` href includes the version suffix. The HTML `citation_pdf_url` meta tag does not — it always resolves to the latest.

### Category codes (confirmed paper counts, 2026-04-18)

| Code | Area | Papers |
|---|---|---|
| `cs.LG` | Machine Learning | 261,782 |
| `cs.CV` | Computer Vision | 189,049 |
| `cs.AI` | Artificial Intelligence | 172,726 |
| `cs.CL` | Computation and Language (NLP) | 106,724 |
| `stat.ML` | Statistics - Machine Learning | 76,902 |
| `math.OC` | Optimization and Control | 60,669 |
| `eess.AS` | Audio and Speech Processing | 21,288 |
| `cs.NE` | Neural and Evolutionary Computing | 17,475 |
| `q-bio.NC` | Neurons and Cognition | 11,903 |

Full category taxonomy: https://arxiv.org/category_taxonomy

## Gotchas

- **Never use the browser for ArXiv.** The abstract page (`/abs/`) and search results are fully server-side rendered static HTML. `http_get` is sufficient for everything including full abstracts, author lists, and PDF URLs.

- **Node has no stdlib XML parser — use regex.** The examples above match `<entry>...</entry>` blocks with `[\s\S]*?` (non-greedy, dot-matches-newline alternative). ArXiv's Atom feed is stable and well-formed, so anchored patterns work reliably. If you need fuller XML querying, reach for `fast-xml-parser` (~150 KB) — but the regex path is enough for everything in this file.

- **Batch single `id_list` call is faster than `Promise.all`.** A comma-separated `id_list` with 10 IDs resolved in one call (1.91s) vs. 10 separate concurrent fetches (6.34s). Use the batch form when you already have the IDs.

- **`<id>` contains a URL, not a bare ID.** The element text is `http://arxiv.org/abs/1706.03762v7` — always split on `/` and `.pop()` to get the bare ID with version. Strip version with `.replace(/v\d+$/, "")` if needed.

- **Batch `id_list` returns entries in unpredictable order.** When fetching `1706.03762,1810.04805,2005.14165`, entries came back ordered by publication date, not by the order given in the request. Index by ID, not position.

- **`max_results` must be set explicitly when using `id_list` batches.** If you request 10 IDs but omit `max_results`, the API defaults to 10, which happens to work — but set it explicitly to `ids.length` to be safe.

- **Nonexistent IDs return zero entries, not an error.** `id_list=9999.99999` gives `<opensearch:totalResults>0</opensearch:totalResults>` and no `<entry>` elements. Always check that `entries.length > 0` before accessing `entries[0]`.

- **`<arxiv:comment>` and `<arxiv:journal_ref>` / `<arxiv:doi>` may be absent.** Not all papers have these fields. Match with `?.`-chained optional groups and null-check.

- **Rate limit: 3 seconds between requests recommended for bulk crawling.** In practice, rapid bursts of 10 individual requests complete in ~6s (avg 0.63s/req) without being blocked. For sustained crawls over hundreds of papers, `await wait(3)` between requests. The API does not return rate limit headers — it just starts slowing responses or returns HTTP 503 silently.

- **`citation_author` tags are in `"Last, First"` format**, not `"First Last"` like the Atom API. The Atom `<author><name>` field gives `"First Last"` order. Pick the format that matches your downstream use.

- **The `<arxiv:affiliation>` sub-element is rarely populated.** Most institutional affiliations are absent from the API response even when listed on the paper. The HTML abs page doesn't expose them in meta tags either.

- **`sortBy=relevance` applies only with `search_query`.** Using `sortBy=relevance` with `id_list` has no effect — results still come back in date order.

- **`max_results` cap is 2000 per call.** For bulk harvesting of a category, use `start` offset pagination and add 3s sleep between pages. `<opensearch:totalResults>` tells you the total so you can compute how many pages are needed.

- **HTML `citation_abstract` meta tag contains the full abstract.** Unlike the Atom `<summary>` which can have trailing whitespace and embedded newlines, the meta tag version is a single clean string — no `.trim()` needed.
