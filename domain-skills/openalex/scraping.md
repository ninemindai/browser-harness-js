# OpenAlex — Scraping & Data Extraction

`https://api.openalex.org` — open academic knowledge graph covering 260M+ works, 90M+ authors, 110K+ institutions. **Never use the browser for OpenAlex.** The entire API is JSON over HTTPS, completely free, no API key required. Add `mailto=your@email.com` to every request to use the polite pool.

## Do this first

```js
const data = JSON.parse(await http_get(
  "https://api.openalex.org/works?search=transformer+attention&per-page=5&mailto=you@example.com"
));
const works = data.results;
const total = data.meta.count;
```

Always include `mailto=` to stay in the polite pool.

## Common workflows

### Search papers (works)

```js
const data = JSON.parse(await http_get(
  "https://api.openalex.org/works"
  + "?search=transformer+attention"
  + "&per-page=5&sort=cited_by_count:desc"
  + "&select=id,doi,display_name,publication_year,cited_by_count,open_access,primary_location"
  + "&mailto=you@example.com"
));
console.log("total matching:", data.meta.count);
for (const w of data.results) {
  const oa  = w.open_access;
  const src = w.primary_location?.source || {};
  console.log(w.id.split("/").pop(), w.publication_year, w.cited_by_count, w.display_name.slice(0, 60));
  console.log("  doi:", w.doi);
  console.log("  open access:", oa.is_oa, "| pdf:", oa.oa_url);
  console.log("  journal:", src.display_name);
}
```

### Fetch single paper by OpenAlex ID or DOI

```js
// By OpenAlex ID
let w = JSON.parse(await http_get("https://api.openalex.org/works/W2626778328?mailto=you@example.com"));
console.log(w.display_name, w.cited_by_count);
// Attention Is All You Need 6526

// By DOI (pass the full DOI URL as the entity ID)
w = JSON.parse(await http_get(
  "https://api.openalex.org/works/https://doi.org/10.1038/nature14539?mailto=you@example.com"
));
console.log(w.display_name, w.cited_by_count);
// Deep learning 79790
```

### Reconstruct abstract from inverted index

OpenAlex does not return abstracts as plain strings — they come as an inverted index. Reconstruct:

```js
const w = JSON.parse(await http_get(
  "https://api.openalex.org/works/W2626778328"
  + "?select=id,display_name,abstract_inverted_index"
  + "&mailto=you@example.com"
));
const aii = w.abstract_inverted_index || {};
const words_pos = [];
for (const [word, positions] of Object.entries(aii)) {
  for (const pos of positions) words_pos.push([pos, word]);
}
const abstract = words_pos.sort((a, b) => a[0] - b[0]).map(p => p[1]).join(" ");
console.log(abstract.slice(0, 200));
```

### Author lookup

```js
// Search by name
const data = JSON.parse(await http_get(
  "https://api.openalex.org/authors?search=geoffrey+hinton&per-page=3&mailto=you@example.com"
));
for (const a of data.results) {
  const bare_id = a.id.split("/").pop();
  console.log(bare_id, a.display_name, a.works_count, "works |", a.cited_by_count, "cites");
  const affils = a.affiliations || [];
  if (affils.length) console.log("  latest affil:", affils[0].institution.display_name);
}

// Fetch by bare ID
const a = JSON.parse(await http_get("https://api.openalex.org/authors/A5108093963?mailto=you@example.com"));

// Get all works by this author (sorted by citations)
const works_data = JSON.parse(await http_get(
  "https://api.openalex.org/works"
  + "?filter=author.id:A5108093963"
  + "&per-page=5&sort=cited_by_count:desc"
  + "&select=id,display_name,cited_by_count,publication_year"
  + "&mailto=you@example.com"
));
```

### Institution lookup

```js
const data = JSON.parse(await http_get(
  "https://api.openalex.org/institutions?search=MIT&per-page=3&mailto=you@example.com"
));
for (const inst of data.results) {
  const bare_id = inst.id.split("/").pop();
  console.log(bare_id, inst.display_name, inst.country_code, inst.works_count, "works");
}

// Works from an institution
const works = JSON.parse(await http_get(
  "https://api.openalex.org/works"
  + "?filter=institutions.id:I63966007"
  + "&per-page=3&sort=cited_by_count:desc"
  + "&select=id,display_name,cited_by_count,publication_year"
  + "&mailto=you@example.com"
));
```

### Concept/Topic lookup

```js
// Concepts endpoint (Wikidata-linked)
const data = JSON.parse(await http_get(
  "https://api.openalex.org/concepts?search=machine+learning&per-page=5&mailto=you@example.com"
));

// Topics endpoint (newer: domain > field > subfield > topic)
const data2 = JSON.parse(await http_get(
  "https://api.openalex.org/topics?search=machine+learning&per-page=3&mailto=you@example.com"
));
for (const t of data2.results) {
  console.log(t.id.split("/").pop(), t.display_name);
  console.log("  ", t.domain?.display_name, ">", t.field?.display_name, ">", t.subfield?.display_name);
}
```

### Source (journal/venue) lookup

```js
const data = JSON.parse(await http_get(
  "https://api.openalex.org/sources?search=nature&per-page=3&mailto=you@example.com"
));

// Works in a source
const works = JSON.parse(await http_get(
  "https://api.openalex.org/works?filter=primary_location.source.id:S137773608"
  + "&per-page=3&sort=cited_by_count:desc"
  + "&select=id,display_name,cited_by_count"
  + "&mailto=you@example.com"
));
```

### Funder lookup

```js
const data = JSON.parse(await http_get(
  "https://api.openalex.org/funders?search=national+science+foundation&per-page=3&mailto=you@example.com"
));
```

### Citation traversal

```js
const paper_id = "W2626778328";  // Attention Is All You Need

// Papers that CITE this paper (forward citations)
const citing = JSON.parse(await http_get(
  `https://api.openalex.org/works?filter=cites:${paper_id}`
  + "&per-page=5&sort=cited_by_count:desc"
  + "&select=id,display_name,publication_year,cited_by_count"
  + "&mailto=you@example.com"
));

// Papers THIS paper cites (backward — list of IDs in the work object)
const paper = JSON.parse(await http_get(
  `https://api.openalex.org/works/${paper_id}?select=referenced_works&mailto=you@example.com`
));
const ref_ids = (paper.referenced_works || []).map(r => r.split("/").pop());
console.log(`references ${ref_ids.length} works:`, ref_ids.slice(0, 3));
```

### Cursor pagination (bulk harvest)

Use cursor pagination (not page-based) for more than 10,000 results.

```js
async function* harvest_works(query_filter, max_results = 1000, mailto = "you@example.com") {
  let cursor = "*";
  let collected = 0;
  while (collected < max_results) {
    const per_page = Math.min(200, max_results - collected);
    const url = `https://api.openalex.org/works`
      + `?filter=${query_filter}`
      + `&per-page=${per_page}`
      + `&cursor=${encodeURIComponent(cursor)}`
      + `&select=id,display_name,publication_year,cited_by_count`
      + `&mailto=${mailto}`;
    const data = JSON.parse(await http_get(url));
    const results = data.results || [];
    if (!results.length) break;
    for (const w of results) yield w;
    collected += results.length;
    const next_cursor = data.meta.next_cursor;
    if (!next_cursor) break;
    cursor = next_cursor;
  }
}

for await (const w of harvest_works("concepts.id:C119857082,publication_year:2023", 400)) {
  console.log(w.id.split("/").pop(), w.display_name.slice(0, 55));
}
```

### Group-by analytics

```js
const data = JSON.parse(await http_get(
  "https://api.openalex.org/works"
  + "?filter=concepts.id:C119857082"
  + "&group_by=publication_year"
  + "&mailto=you@example.com"
));
console.log("groups_count:", data.meta.groups_count);
for (const g of (data.group_by || []).slice(0, 5)) {
  console.log(`  ${g.key}: ${g.count.toLocaleString("en-US")} works`);
}
```

## Filter syntax reference

Filters go in the `filter=` param as comma-separated `field:value` pairs. All conditions are AND-ed.

```
# Exact match
filter=publication_year:2023

# Full-text search on a field
filter=title.search:deep+learning

# Combine multiple (AND)
filter=title.search:CRISPR,publication_year:2022,open_access.is_oa:true

# OR within one field (pipe operator)
filter=publication_year:2022|2023

# Negation
filter=publication_year:!2020

# Range
filter=cited_by_count:>1000
filter=publication_year:<2010
filter=cited_by_count:100-500

# Nested field access
filter=author.id:A5108093963
filter=institutions.id:I63966007
filter=concepts.id:C119857082
filter=primary_location.source.id:S137773608
filter=open_access.is_oa:true
filter=cites:W2626778328
```

Commonly useful filter fields for works:

| Filter field | Example |
|---|---|
| `title.search` | `title.search:machine+learning` |
| `abstract.search` | `abstract.search:attention` |
| `publication_year` | `publication_year:2023` |
| `from_publication_date` | `from_publication_date:2023-01-01` |
| `to_publication_date` | `to_publication_date:2023-12-31` |
| `cited_by_count` | `cited_by_count:>500` |
| `open_access.is_oa` | `open_access.is_oa:true` |
| `author.id` | `author.id:A5108093963` |
| `institutions.id` | `institutions.id:I63966007` |
| `concepts.id` | `concepts.id:C119857082` |
| `primary_location.source.id` | `primary_location.source.id:S137773608` |
| `type` | `type:journal-article` |
| `language` | `language:en` |
| `cites` | `cites:W2626778328` |
| `doi` | `doi:10.1038/nature14539` |

## URL and parameter reference

### API base

```
https://api.openalex.org/{entity_type}
```

Entity types: `works`, `authors`, `institutions`, `sources`, `concepts`, `topics`, `funders`, `publishers`

### Query parameters

| Parameter | Example | Notes |
|---|---|---|
| `search` | `search=deep+learning` | Full-text relevance search |
| `filter` | `filter=publication_year:2023` | Structured filters |
| `sort` | `sort=cited_by_count:desc` | Sort field + direction |
| `per-page` | `per-page=200` | Max 200 per page |
| `page` | `page=2` | Fails if `per-page * page > 10000` |
| `cursor` | `cursor=*` | Cursor for bulk pagination |
| `select` | `select=id,doi,display_name` | Return only these fields |
| `group_by` | `group_by=publication_year` | Aggregate counts by field |
| `mailto` | `mailto=you@example.com` | **Always include** |

### Entity ID prefix convention

| Prefix | Entity | Example |
|---|---|---|
| `W` | Work | `W2626778328` |
| `A` | Author | `A5108093963` |
| `I` | Institution | `I63966007` |
| `S` | Source (journal) | `S137773608` |
| `C` | Concept | `C119857082` |
| `T` | Topic | `T11948` |
| `F` | Funder | `F4320306076` |
| `P` | Publisher | `P4310319965` |

Full entity URLs: `https://openalex.org/{ID}`. Bare ID is always `url.split("/").pop()`.

## Rate limits

| Pool | Rate | Daily cap |
|---|---|---|
| Polite pool (with `mailto=`) | 10 req/s | 100,000 req/day |
| Common pool (no `mailto`) | 100 req/s | 100,000 req/day |

- No API key required.
- No `Retry-After` header when throttled — add a short `wait` on 429.
- For bulk harvesting, use cursor pagination + respect the polite pool.

## Gotchas

- **Never use the browser for OpenAlex.** API returns complete structured JSON for all entity types.

- **`mailto=` goes in every call, not just once.** It is a query parameter, not a header.

- **OpenAlex IDs in the `id` field are full URLs, not bare IDs.** Always `url.split("/").pop()` to get the bare ID form needed for `filter=cites:`, `filter=author.id:`, etc.

- **DOI lookup uses the full DOI URL as the path parameter.** Correct: `GET /works/https://doi.org/10.1038/nature14539`. Incorrect: `GET /works/10.1038/nature14539`.

- **Page-based pagination hard stops at 10,000 results.** `per-page=200&page=51` returns HTTP 400. Use `cursor=*` for harvesting more than 10K.

- **`cursor=*` must be URL-encoded on subsequent pages.** The `next_cursor` contains `+`, `=`, `/`. Always `encodeURIComponent(cursor)`.

- **`group_by` and `page` are incompatible.** Group-by returns a `group_by` array, not `results`.

- **`abstract_inverted_index` may be `null` for some papers.** Publisher agreements. Check `if (aii)` before reconstructing.

- **`select` significantly reduces response size and latency.** Specifying `select=id,doi,display_name,cited_by_count` cuts payload by ~90%.

- **`sort=relevance_score:desc` only works with `search=`.** Use `cited_by_count:desc` or `publication_date:desc` for filter-only queries.

- **The `concepts` field is deprecated in favor of `topics`.** Both are still populated.

- **`open_access.oa_url` can be `null` even when `is_oa=true`.** Check `best_oa_location.pdf_url` instead.

- **Negation filter syntax is `field:!value`.** Example: `filter=publication_year:!2020`.

- **Author disambiguation is imperfect.** Use ORCID (`ids.orcid`) when available to cross-reference.

- **`per-page` with `cursor=*` ignores `page=`.** Do not combine cursor + page.
