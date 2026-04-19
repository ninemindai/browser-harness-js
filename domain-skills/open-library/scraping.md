# Open Library — Book Data Extraction

`https://openlibrary.org` — Internet Archive's free book catalog. All endpoints are public JSON APIs — no auth, no browser, no scraping required.

## Do this first

**Every task is a direct HTTP call — never open the browser.**

```js
// Search by title
const results = JSON.parse(await http_get("https://openlibrary.org/search.json?q=dune&limit=5"));
// results.numFound  === 49090
// results.docs      === array of work objects
// results.start     === 0  (offset for pagination)
```

---

## Common workflows

### Search by query, author, title, or ISBN

```js
// Free-text search
let r = JSON.parse(await http_get("https://openlibrary.org/search.json?q=dune+frank+herbert&limit=5"));

// Author search
r = JSON.parse(await http_get(
  "https://openlibrary.org/search.json?author=tolkien&limit=5"
  + "&fields=title,author_name,first_publish_year,isbn"
));
// fields=* returns all available fields; default returns ~15

// Title + author combined
r = JSON.parse(await http_get(
  "https://openlibrary.org/search.json?title=dune&author=frank+herbert&limit=3"
  + "&fields=title,author_name,edition_count,first_publish_year"
));
// r.docs[0].title              === 'Dune'
// r.docs[0].author_name        === ['Frank Herbert']
// r.docs[0].first_publish_year === 1965
// r.docs[0].edition_count      === 120

// ISBN lookup (returns 0–2 results for the same work)
r = JSON.parse(await http_get("https://openlibrary.org/search.json?isbn=9780743273565"));
// r.numFound            === 2
// r.docs[0].title       === 'The Great Gatsby'
// r.docs[0].key         === '/works/OL468431W'
```

**Sort options** (`&sort=`): `new` (recently added), `old`, `random`, `editions` (most editions), `scans` (most scans). Default is relevance.

**Language filter**: `&language=fre` (ISO 639-2/B codes: `eng`, `fre`, `ger`, `spa`, `ita`, etc.)

**Pagination**: `&limit=N&offset=N`. Max limit not enforced but keep under 100.

### Bulk ISBN lookups (parallel)

```js
const isbns = ["9780743273565", "9780451524935", "9780618346257"];

async function lookup_isbn(isbn) {
  const url = `https://openlibrary.org/search.json?isbn=${isbn}&fields=title,author_name,first_publish_year,key`;
  const r = JSON.parse(await http_get(url));
  if (r.docs.length) {
    const d = r.docs[0];
    return {
      isbn, title: d.title,
      author: d.author_name?.[0],
      year: d.first_publish_year,
      key: d.key,
    };
  }
  return { isbn, found: false };
}

const books = await Promise.all(isbns.map(lookup_isbn));
```

### Works API (editions grouped by title)

```js
const work_id = "OL893415W";  // from search doc.key = '/works/OL893415W'
const work = JSON.parse(await http_get(`https://openlibrary.org/works/${work_id}.json`));

// work.title           === 'Dune'
// work.covers          === [11481354, 12375564, 11157826]
// work.subjects        === ['Dune (Imaginary place)', 'Fiction', ...]
// work.authors         === [{author: {key: '/authors/OL79034A'}, type: {...}}]
// work.description     → either str OR {type: '/type/text', value: str}

function get_description(work) {
  const desc = work.description ?? "";
  if (desc && typeof desc === "object") return desc.value || "";
  return desc || "";
}
```

#### Works editions (paginated list of all editions)

```js
const editions_resp = JSON.parse(await http_get(
  `https://openlibrary.org/works/${work_id}/editions.json?limit=10&offset=0`
));
// editions_resp.size    === 120      (total edition count)
// editions_resp.entries === [...]    (up to limit items)
// editions_resp.links   === {self: '...', work: '...', next: '...', prev: '...'}

const e = editions_resp.entries[0];
// e.title, e.publishers, e.publish_date (string, inconsistent format)
// e.isbn_13, e.isbn_10, e.covers, e.number_of_pages
// e.languages === [{key: '/languages/por'}]
// e.key === '/books/OL28969075M'
```

### Books API (specific edition)

```js
const edition_id = "OL7353617M";
const edition = JSON.parse(await http_get(`https://openlibrary.org/books/${edition_id}.json`));
// edition.title, edition.publishers, edition.publish_date
// edition.isbn_13, edition.isbn_10, edition.number_of_pages
// edition.works === [{key: '/works/OL45804W'}]
// edition.ocaid === 'fantast00dahl'  (Internet Archive ID if available)
```

#### Bibkeys API (enriched, multiple books at once)

```js
// jscmd=data: cleaned up object with cover URLs pre-built
const r = JSON.parse(await http_get(
  "https://openlibrary.org/api/books"
  + "?bibkeys=ISBN:9780743273565,ISBN:9780451524935"
  + "&format=json&jscmd=data"
));
// r === {"ISBN:9780743273565": {...}, "ISBN:9780451524935": {...}}

const book = r["ISBN:9780743273565"];
// book.title, book.authors, book.publish_date, book.publishers
// book.number_of_pages, book.url, book.key
// book.cover === {small: '...S.jpg', medium: '...M.jpg', large: '...L.jpg'}
// book.identifiers === {isbn_13: [...], openlibrary: [...]}
// book.subjects === [{name: 'Modern fiction', url: '...'}, ...]

// jscmd=details: raw edition JSON + extra fields
const r2 = JSON.parse(await http_get(
  "https://openlibrary.org/api/books"
  + "?bibkeys=ISBN:9780743273565&format=json&jscmd=details"
));
const item = r2["ISBN:9780743273565"];
// item.preview === 'noview' | 'restricted' | 'full'
// item.thumbnail_url === 'https://covers.openlibrary.org/b/id/14314120-S.jpg'
// item.details → raw edition JSON

// Supported bibkey prefixes: ISBN:, OCLC:, LCCN:, OLID:
```

### Authors API

```js
// Lookup by known author key
const author = JSON.parse(await http_get("https://openlibrary.org/authors/OL26320A.json"));

// author.name           === 'J.R.R. Tolkien'
// author.birth_date     === '3 January 1892'   (string, not parsed)
// author.death_date     === '2 September 1973'
// author.bio            → str or {value: str}
// author.photos         === [6155606, 6433524, ...]
// author.remote_ids     === {wikidata: 'Q892', viaf: '95218067', ...}

// Author works (paginated)
const works = JSON.parse(await http_get("https://openlibrary.org/authors/OL26320A/works.json?limit=5"));
// works.size === 415
// works.entries === [{title, key, covers, authors, created, ...}, ...]
// works.links === {self: '...', next: '...'}
```

#### Author search

```js
const r = JSON.parse(await http_get("https://openlibrary.org/search/authors.json?q=tolkien"));
// r.numFound === 40
// r.docs[0]:
//   name === 'Christopher Tolkien'
//   key === 'OL2623360A'     ← NOTE: no /authors/ prefix here
//   birth_date === '21 November 1924'
//   top_work === 'The War of the Ring'
//   work_count === 43
```

### Cover images

```
# Book covers
https://covers.openlibrary.org/b/id/{cover_id}-{size}.jpg      (most reliable)
https://covers.openlibrary.org/b/isbn/{isbn}-{size}.jpg

# Author photos
https://covers.openlibrary.org/a/id/{photo_id}-{size}.jpg

# Sizes: S (small), M (medium), L (large)
```

```js
async function get_cover_bytes(cover_id, size = "M") {
  // Fetch cover image bytes. Returns null if no cover (43-byte GIF placeholder).
  const url = `https://covers.openlibrary.org/b/id/${cover_id}-${size}.jpg`;
  const r = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0" },
    signal: AbortSignal.timeout(15_000),
  });
  const buf = Buffer.from(await r.arrayBuffer());
  return buf.length === 43 ? null : buf;   // 43-byte GIF = no cover placeholder
}

function cover_url(cover_id, size = "M") {
  return `https://covers.openlibrary.org/b/id/${cover_id}-${size}.jpg`;
}

// Usage:
const work = JSON.parse(await http_get("https://openlibrary.org/works/OL893415W.json"));
if (work.covers?.length) {
  const img = await get_cover_bytes(work.covers[0], "L");
}

// Medium-size cover by ISBN, 404 (not GIF placeholder) for missing:
const url_safe = `https://covers.openlibrary.org/b/isbn/${isbn}-M.jpg?default=false`;
```

### Subjects API

```js
// Subject slugs: lowercase, underscores for spaces
const r = JSON.parse(await http_get("https://openlibrary.org/subjects/science_fiction.json?limit=5"));
// r.name === 'science fiction'
// r.subject_type === 'subject'   (also: 'person', 'place', 'time')
// r.work_count === 20973
// r.works === [{title, key, cover_id, authors, edition_count, ...}, ...]

// Place subject:
const r2 = JSON.parse(await http_get("https://openlibrary.org/subjects/place:london.json?limit=5"));
// r2.subject_type === 'place', r2.work_count === 23927

// Person / Time subjects:
// https://openlibrary.org/subjects/person:napoleon.json?limit=5
// https://openlibrary.org/subjects/time:middle_ages.json?limit=5

// Combine with ebooks=true to filter to only freely readable books:
const r3 = JSON.parse(await http_get("https://openlibrary.org/subjects/science_fiction.json?limit=5&ebooks=true"));
```

### Trending books

```js
for (const period of ["daily", "weekly", "monthly"]) {
  const r = JSON.parse(await http_get(`https://openlibrary.org/trending/${period}.json?limit=10`));
  console.log(period, r.works[0].title);
}
```

---

## Rate limits

No authentication required. No API key. No explicit rate limit published.

Observed in testing: 5 requests completed in ~1 second with no throttling. The API is served from CDN/Solr — in practice you can make 10–20 parallel requests without issue.

**No `User-Agent` override needed** — the default `Mozilla/5.0` from `http_get` is accepted.

---

## Gotchas

**`description` field has two shapes.** Both are real — check at runtime:
```js
const desc = work.description ?? "";
const text = (desc && typeof desc === "object") ? (desc.value || "") : (desc || "");
```

**Author search `key` has no prefix.** `/search/authors.json` returns `key: 'OL26320A'`, but the Authors API uses `/authors/OL26320A`. Add the prefix manually.

**Missing cover → 43-byte GIF placeholder, not 404.** Without `?default=false`, the covers API returns a 1×1 transparent GIF. Check `buf.length === 43` to detect missing covers.

**`covers.openlibrary.org/b/olid/{work_id}` is unreliable.** OLID-based cover URLs for work IDs (OL...W) return the placeholder even when covers exist. Always use `b/id/{cover_id}` or `b/isbn/{isbn}`.

**Bibkeys API picks one edition per ISBN.** When the same ISBN appears on multiple editions, `api/books?bibkeys=ISBN:...` returns one — may not be the most common edition.

**`publish_date` is a raw string.** Values like `'October 1, 1988'`, `'19/08/2017'`, `'2021'`, and `'1965-01-01'` all appear. Don't parse without normalization.

**`/works/.../editions.json` pagination uses `links.next`.** Check `links.next` in the response to know if more pages exist:
```js
let resp = JSON.parse(await http_get("https://openlibrary.org/works/OL893415W/editions.json?limit=50"));
while (resp.links?.next) {
  resp = JSON.parse(await http_get("https://openlibrary.org" + resp.links.next));
  // process resp.entries
}
```

**404 for non-existent IDs.** `/works/OL99999999W.json`, `/books/OL99999999M.json`, and `/authors/OL99999999A.json` all return 404. `http_get` returns the body regardless — parse and check for an error key, or use `fetch` directly to inspect status.

**Search `docs` default fields are minimal.** The default response includes ~15 fields. Add `&fields=*` to get all 100+ Solr fields. Alternatively specify exactly what you need: `&fields=title,isbn,ratings_average`.
