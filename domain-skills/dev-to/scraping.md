# DEV Community (dev.to) — Data Extraction

`https://dev.to` — developer blogging platform. Everything useful is available via a public REST API with no auth required. No browser needed for any read task.

## Do this first

**Use the REST API — it returns clean JSON in ~150–250ms with no browser, no login, no JS rendering.**

```js
const articles = JSON.parse(await http_get("https://dev.to/api/articles?per_page=10&tag=python"));
// Each article: id, title, description, url, cover_image, tag_list, tags,
//               published_at, published_timestamp, readable_publish_date,
//               reading_time_minutes, positive_reactions_count,
//               public_reactions_count, comments_count, user, organization,
//               flare_tag, collection_id, slug, path, canonical_url,
//               social_image, language, subforem_id
```

The API serves **V0 (beta) by default** and emits a `Warning: 299` header on every response. Suppress it silently with the V1 `Accept` header (same data, no deprecated warning):

```js
async function dev_get(url) {
  return await http_get(url, {
    "Accept": "application/vnd.forem.api-v1+json",
  });
}

const articles = JSON.parse(await dev_get("https://dev.to/api/articles?per_page=10&tag=python"));
```

Or just use `http_get` directly if you don't care about the warning header noise.

---

## Common workflows

### Articles by tag

```js
const articles = JSON.parse(await http_get("https://dev.to/api/articles?per_page=10&tag=python"));
// Paginate with &page=2, &page=3 etc. (1-indexed)
for (const a of articles) {
  console.log(a.id, a.positive_reactions_count, a.title.slice(0, 60));
}
```

Confirmed working tags: `python`, `javascript`, `typescript`, `rust`, `go`, `webdev`, `tutorial`, `react`, `devops`, `ai`, `beginners`.

### Top articles by time window

```js
// top=N means "top articles from the last N days"
const top_day   = JSON.parse(await http_get("https://dev.to/api/articles?per_page=10&top=1"));
const top_week  = JSON.parse(await http_get("https://dev.to/api/articles?per_page=10&top=7"));
const top_month = JSON.parse(await http_get("https://dev.to/api/articles?per_page=10&top=30"));
const top_year  = JSON.parse(await http_get("https://dev.to/api/articles?per_page=10&top=365"));
```

### Articles by username

```js
const articles = JSON.parse(await http_get("https://dev.to/api/articles?per_page=10&username=ben"));
// Paginates cleanly: page=1, page=2 etc. Return distinct IDs, no overlap.
```

### New and rising articles

```js
const fresh  = JSON.parse(await http_get("https://dev.to/api/articles?per_page=10&state=fresh"));   // very new
const rising = JSON.parse(await http_get("https://dev.to/api/articles?per_page=10&state=rising"));  // gaining traction
// state=all returns 0 results (requires auth, not useful unauthenticated)
```

### Single article by ID (adds body_html and body_markdown)

```js
const article = JSON.parse(await http_get("https://dev.to/api/articles/3442047"));
// Full article adds two fields not in list response:
//   body_html     — rendered HTML (safe to display directly)
//   body_markdown — raw Markdown source
console.log(article.body_html.length, article.body_markdown.length);
```

### Single article by username/slug

```js
// path field from list response is "/username/slug"
const article = JSON.parse(await http_get("https://dev.to/api/articles/ben/some-article-slug"));
```

### Tags — popular list with colors

```js
const tags = JSON.parse(await http_get("https://dev.to/api/tags?per_page=10"));
// Fields: id, name, bg_color_hex, text_color_hex, short_summary
// Sorted by popularity. Paginate with &page=2 etc.
for (const t of tags) {
  console.log(t.name, t.bg_color_hex, t.text_color_hex);
}
// e.g. webdev  #562765  #ffffff
//      javascript  #f7df1e  #000000
//      ai  #17fd1a  #ffffff
```

### User profile

```js
const user = JSON.parse(await http_get("https://dev.to/api/users/by_username?url=ben"));
// Fields: type_of, id, username, name, twitter_username, github_username,
//         summary, location, website_url, joined_at, profile_image
console.log(user.id, user.username, user.summary);
// e.g. 1  ben  "A Canadian software developer who thinks he's funny."
```

`joined_at` is a human string like `"Dec 27, 2015"` — not ISO 8601. Parse with `new Date(user.joined_at)` (the Date constructor accepts that format on V8).

### Comments on an article

```js
const comments = JSON.parse(await http_get("https://dev.to/api/comments?a_id=3442047"));
// Returns top-level comments only (replies nested under children key)
// Fields per comment: id_code (string, not int!), type_of, body_html,
//                     created_at, user (object), children (array of same shape)
for (const c of comments) {
  console.log(c.id_code, c.user.username, c.created_at);
  for (const reply of c.children || []) {
    console.log("  reply:", reply.id_code, reply.user.username);
  }
}
```

### Single comment by id_code

```js
const comment = JSON.parse(await http_get("https://dev.to/api/comments/36lnc"));
// Same fields as above: id_code, body_html, created_at, user, children
```

### Bulk tag fetch (parallel)

```js
const tags = ["python", "javascript", "typescript", "rust", "go",
              "devops", "webdev", "tutorial", "productivity", "react"];

async function fetch_tag(tag) {
  const data = JSON.parse(await http_get(`https://dev.to/api/articles?per_page=5&tag=${tag}`));
  return [tag, data];
}

// 3 concurrent requests (well under the burst limit)
async function pMap(items, limit, fn) {
  const out = [];
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx]);
    }
  });
  await Promise.all(workers);
  return out;
}

const pairs = await pMap(tags, 3, fetch_tag);
const results = Object.fromEntries(pairs);
// 10 tags × 5 articles each: ~0.67s total
```

---

## Endpoint reference

| Endpoint | Auth | Key params | Latency |
|----------|------|-----------|---------|
| `GET /api/articles` | None | `tag`, `username`, `top`, `state`, `page`, `per_page` | ~200ms |
| `GET /api/articles/{id}` | None | — | ~80ms |
| `GET /api/articles/{username}/{slug}` | None | — | ~200ms |
| `GET /api/tags` | None | `page`, `per_page` | ~190ms |
| `GET /api/users/by_username?url={username}` | None | — | ~190ms |
| `GET /api/comments?a_id={article_id}` | None | — | ~160ms |
| `GET /api/comments/{id_code}` | None | — | ~150ms |
| `GET /api/listings` | None | `category`, `page`, `per_page` | ~260ms (returns 0) |

**Listings endpoint returns 0 results.** The `/api/listings` endpoint is documented but returns an empty array for all categories (`jobs`, `forsale`, `education`, `cfp`) without auth. Skip it.

---

## Pagination

All list endpoints paginate with `page=` (1-indexed) and `per_page=`:

```js
async function get_all_articles_by_tag(tag, max_pages = 5) {
  const results = [];
  for (let page = 1; page <= max_pages; page++) {
    const batch = JSON.parse(await http_get(
      `https://dev.to/api/articles?per_page=30&tag=${tag}&page=${page}`
    ));
    if (!batch.length) break;
    results.push(...batch);
  }
  return results;
}
```

- `per_page` supports up to **1000** (confirmed). No documented max, but 1000 works in testing.
- No `total_count` field in list responses — you paginate until an empty array.
- Page ordering is consistent — confirmed no ID overlap between page 1 and page 2.

---

## Article field reference

All fields returned in list responses (single article adds `body_html` and `body_markdown`):

```
id                       int    — article ID, stable, use for single-article fetch
title                    str
description              str    — auto-excerpt, never null
slug                     str    — URL slug component
path                     str    — "/username/slug"
url                      str    — full canonical URL
canonical_url            str    — same as url for native posts; author's site URL for cross-posts
cover_image              str|null — CDN URL or null (~30% of articles have no cover image)
social_image             str    — always present (generated if no cover_image)
tag_list                 array  — e.g. ['python', 'ai', 'tutorial']  ← use this for code
tags                     str    — same tags as comma-separated string "python, ai, tutorial"
published_at             str    — ISO 8601 UTC e.g. "2026-04-18T03:49:36Z"
published_timestamp      str    — identical to published_at
readable_publish_date    str    — human string e.g. "Apr 18"
reading_time_minutes     int
positive_reactions_count int    — hearts/likes count
public_reactions_count   int    — total reactions (usually same as positive_reactions_count)
comments_count           int
user                     object — name, username, twitter_username, github_username,
                                  user_id, website_url, profile_image, profile_image_90
organization             object|null — present when posted under an org: name, username, slug,
                                        profile_image, profile_image_90
flare_tag                object|null — {name, bg_color_hex, text_color_hex} — discussion/challenge badge
collection_id            int|null    — series/collection ID if part of a series
language                 str    — e.g. "en"
subforem_id              int|null
crossposted_at           str|null — ISO datetime if cross-posted
edited_at                str|null
last_comment_at          str|null
created_at               str    — ISO 8601
type_of                  str    — always "article"
```

---

## Rate limits

- **Burst limit: ~6 rapid sequential requests**, then HTTP 429.
- **Recovery: `Retry-After: 1` second** — wait 1s after a 429 and you're good again.
- No `X-RateLimit-*` headers in 200 responses — you only see `Retry-After` on the 429 itself.
- With 3 concurrent workers, 10 requests succeed without hitting the limit.
- No difference in limits between V0 (default) and V1 (`Accept` header) — same underlying rate limit.
- **No auth token tested** — all endpoints above work without `api_key`. Authenticated requests likely have higher limits.

Safe pattern for bulk fetching (`http_get` returns body regardless of status — branch on 429 via `fetch`):

```js
async function safe_fetch(url) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const r = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0" },
      signal: AbortSignal.timeout(20_000),
    });
    if (r.status === 429) {
      await wait(1);   // Retry-After is 1s
      continue;
    }
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.json();
  }
  return [];
}

const tags = ["python", "javascript", "typescript", "rust"];
const urls = tags.map(t => `https://dev.to/api/articles?per_page=10&tag=${t}`);
const results = await Promise.all(urls.map(safe_fetch));
```

---

## Gotchas

- **`tag_list` (array) vs `tags` (string)** — both fields always present. `tag_list` is an array; `tags` is the same data as a comma-separated string. Use `tag_list` in code.

- **Comments have `id_code`, not `id`** — comment identifiers are alphanumeric strings like `"36lnc"`, not integers. The integer `id` field is absent from comment objects. Use `id_code` to fetch a specific comment via `GET /api/comments/{id_code}`.

- **Comments endpoint returns top-level only** — replies are nested under `children` recursively, not returned as a flat list. A thread with 100 total comments may only show 60 top-level objects; walk `children` recursively to count all.

- **`cover_image` can be null** — ~30% of articles have no cover image. Always guard: `a.cover_image || a.social_image` for a guaranteed image URL.

- **`flare_tag` is null for most articles** — only discussion/challenge posts carry it. It's an object `{name, bg_color_hex, text_color_hex}` when present.

- **`published_at` === `published_timestamp`** — both fields contain identical ISO 8601 UTC strings. `readable_publish_date` is human-only (`"Apr 18"`, no year).

- **`joined_at` on user profile is not ISO** — it's `"Dec 27, 2015"`. The JS `Date` constructor accepts that format: `new Date(u.joined_at)`.

- **`state=all` returns 0 results unauthenticated** — it's for the authenticated user's own feed. `state=fresh` and `state=rising` work without auth.

- **`top=N` means last N days** — `top=1` is last 24h, `top=7` is last week, `top=30` is last month, `top=365` is last year. Results differ from the `state=` param.

- **V0 warning header on every response** — `Warning: 299 - This endpoint is part of the V0 (beta) API…` appears on all responses without the `Accept` header. It's harmless but noisy. Suppress with `"Accept": "application/vnd.forem.api-v1+json"`.

- **No `total_count` in list responses** — paginate until an empty array. There is no way to know upfront how many total results exist.

- **Listings endpoint returns empty** — `GET /api/listings` and all category variants return `[]` without auth. Documented but non-functional publicly.

- **`/api/articles/{id}/comments` returns 404** — comments must be fetched via `GET /api/comments?a_id={id}`, not as a sub-resource of articles.

- **`canonical_url` may point off-site** — for cross-posted articles, `canonical_url` is the author's original blog URL, not dev.to. Use `url` for the dev.to link.

- **`organization` field is null for personal posts** — only present when the article was posted under an org account. Check before accessing sub-fields.
