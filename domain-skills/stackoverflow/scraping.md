# Stack Overflow — Scraping & Data Extraction

`https://stackoverflow.com` — all public read-only data is available via the Stack Exchange API v2.3. No auth, no browser required for any read operation. API is fast, returns gzip-compressed JSON, and works transparently with `http_get`.

## Do this first: pick your access path

| Goal | Best approach | Notes |
|------|--------------|-------|
| Top/hot questions by tag | `GET /2.3/questions` | Add `filter=withbody` for question text |
| Answers for a question | `GET /2.3/questions/{id}/answers` | Add `filter=withbody` for answer text |
| Search by keyword + tag | `GET /2.3/search/advanced` | More filters than `/search` |
| Simple title keyword search | `GET /2.3/search` | `intitle=` param |
| Fetch by known question IDs | `GET /2.3/questions/{id1};{id2};...` | Semicolon-delimited batch, up to 100 |
| User profile + reputation | `GET /2.3/users/{id}` | Public fields only |
| User activity timeline | `GET /2.3/users/{id}/timeline` | Events: badges, answers, questions |
| User's questions / answers | `GET /2.3/users/{id}/questions` or `/answers` | Standard listing |
| Comments on a post | `GET /2.3/questions/{id}/comments` | Needs `filter=withbody` for body |
| Related questions | `GET /2.3/questions/{id}/related` | Returns linked/similar questions |
| Answer by ID directly | `GET /2.3/answers/{id}` | One or more semicolon-separated IDs |
| Popular tags | `GET /2.3/tags` | Sort by `popular`, `activity`, or `name` |
| Site-wide statistics | `GET /2.3/info` | Total questions, quota, etc. |
| Question HTML page | `http_get` with User-Agent | Returns 777KB HTML; prefer API |

**Use the API for all data tasks.** The HTML page is 777KB, lacks clean structure, and the JSON-LD block only contains `WebSite` and `Organization` objects (no `QAPage` or `Question` schema). The API returns the same data in milliseconds, fully structured.

---

## Quota limits

The API is unauthenticated-friendly but strictly quota-capped per IP per day:

| Auth level | Daily quota | Burst |
|------------|-------------|-------|
| No key (unauthenticated) | **300 requests/day** | No enforced burst limit observed |
| With API key | **10,000 requests/day** | Same |

Check your remaining quota in every response envelope:

```js
const data = JSON.parse(await http_get("https://api.stackexchange.com/2.3/info?site=stackoverflow"));
console.log("Quota remaining:", data.quota_remaining);  // e.g. 273
console.log("Quota max:", data.quota_max);              // 300 unauthenticated, 10000 with key
// Confirmed: quota_max=300, quota_remaining decrements per call
```

Every API response includes `quota_remaining` in the envelope. Monitor it. When it hits 0, all calls return HTTP 400 with `error_id: 502` (throttle_violation). There is no retry-after header — wait until midnight UTC.

**If you have an API key**, append `&key=YOUR_KEY` to any URL to use the 10,000/day quota.

---

## Response envelope

Every response from the Stack Exchange API is wrapped in a consistent envelope:

```js
{
  items: [...],          // list of result objects
  has_more: true/false,  // whether more pages exist
  quota_max: 300,        // total daily quota
  quota_remaining: 273,  // calls left today
  backoff: null          // seconds to wait before next call (rare)
}
```

Always check `data.backoff` — if it returns an integer, sleep that many seconds before the next call. Ignoring it causes throttle errors.

Error responses throw (not a JSON envelope):
- HTTP 400 — invalid parameter (e.g. bad site name) — throws exception
- HTTP 400 with JSON body — quota exhausted or throttle_violation

```js
try {
  const data = JSON.parse(await http_get("https://api.stackexchange.com/2.3/questions?site=stackoverflow&pagesize=1"));
} catch (e) {
  console.log("API error:", e);   // HTTP Error 400: Bad Request
}
```

---

## `filter=withbody` — required for post content

By default, the API strips the `body` field from all responses. You **must** add `filter=withbody` to get question or answer text. This applies to questions, answers, and comments alike.

```js
// WITHOUT filter=withbody — body field is ABSENT
let data = JSON.parse(await http_get("https://api.stackexchange.com/2.3/questions?order=desc&sort=votes&tagged=python&site=stackoverflow&pagesize=1"));
let q = data.items[0];
console.log("Has body:", 'body' in q);   // false
console.log("Keys:", Object.keys(q).sort());
// ['accepted_answer_id', 'answer_count', 'content_license', 'creation_date',
//  'is_answered', 'last_activity_date', 'last_edit_date', 'link', 'owner',
//  'protected_date', 'question_id', 'score', 'tags', 'title', 'view_count']

// WITH filter=withbody — body field is PRESENT
data = JSON.parse(await http_get("https://api.stackexchange.com/2.3/questions?order=desc&sort=votes&tagged=python&site=stackoverflow&pagesize=1&filter=withbody"));
q = data.items[0];
console.log("Has body:", 'body' in q);   // true
console.log("Body preview:", q.body.slice(0, 60));
// '<p>What functionality does the <a href="https://do...'
```

---

## HTML encoding in API responses

The API returns HTML in two contexts, and plain text in a third:

- **`body` field** (questions, answers, comments) — full HTML markup. Headings, code blocks, links, blockquotes, lists. Strip with a regex/parser for plain text.
- **`title` field** — HTML-entity-encoded plain text. Quotes, angle brackets, and ampersands are escaped (`&quot;`, `&lt;`, `&amp;`). Decode with `unescapeHtml()`.
- **`display_name`, `link`, `tags`** — plain text, no encoding.

```js
const unescapeHtml = (s) => s
  .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
  .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)))
  .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
  .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&nbsp;/g, " ");

const data = JSON.parse(await http_get("https://api.stackexchange.com/2.3/questions/231767?site=stackoverflow&filter=withbody"));
const q = data.items[0];

// Title has HTML entities
console.log("Raw title:", q.title);
// 'What does the &quot;yield&quot; keyword do in Python?'
console.log("Decoded:", unescapeHtml(q.title));
// 'What does the "yield" keyword do in Python?'

// Body is full HTML — strip for plain text with a simple tag remover
const stripTags = (html) => html.replace(/<[^>]*>/g, "");
console.log(stripTags(q.body).slice(0, 200));
// 'What functionality does the yield keyword do in Python?\nWhat is the ...'
```

---

## Common workflows

### Top questions by tag (API)

```js
const unescapeHtml = (s) => s
  .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
  .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)))
  .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
  .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&nbsp;/g, " ");

const data = JSON.parse(await http_get(
  "https://api.stackexchange.com/2.3/questions"
  + "?order=desc&sort=votes&tagged=python&site=stackoverflow&pagesize=5&filter=withbody"
));
for (const q of data.items) {
  console.log(q.question_id, q.score, unescapeHtml(q.title).slice(0, 60));
  console.log("  Tags:", q.tags.slice(0, 3), "Answers:", q.answer_count);
}
console.log("Quota remaining:", data.quota_remaining);
// 231767 13133 What does the "yield" keyword do in Python?
//   Tags: ['python', 'iterator', 'generator'] Answers: 51
// 419163 8438 What does if __name__ == "__main__": do?
//   Tags: ['python', 'namespaces', 'program-entry-point'] Answers: 40
// Quota remaining: 299
```

Sort options for `/questions`: `activity`, `votes`, `creation`, `hot`, `week`, `month`.

### Answers for a question

```js
const data = JSON.parse(await http_get(
  "https://api.stackexchange.com/2.3/questions/231767/answers"
  + "?order=desc&sort=votes&site=stackoverflow&filter=withbody&pagesize=3"
));
for (const a of data.items) {
  console.log(`Score: ${a.score}, Accepted: ${a.is_accepted}`);
  console.log(`  Body preview: ${a.body.slice(0, 150)}`);
}
// Score: 18307, Accepted: true
//   Body preview: <p>To understand what <a href="...">yield</a> does, ...
// Score: 2596, Accepted: false
// Score: 802, Accepted: false
```

Answer fields (with `filter=withbody`): `answer_id`, `question_id`, `score`, `is_accepted`, `body`, `owner`, `creation_date`, `last_activity_date`, `content_license`.

### Fetch questions by ID (batch)

Fetch up to 100 questions in one call using semicolons:

```js
const data = JSON.parse(await http_get(
  "https://api.stackexchange.com/2.3/questions/231767;419163;394809"
  + "?site=stackoverflow&filter=withbody"
));
console.log("Fetched:", data.items.length);   // 3
for (const q of data.items) {
  console.log(q.question_id, q.score, q.title.slice(0, 50));
}
// 231767 13133 What does the &quot;yield&quot; keyword do in Pyth
// 419163 8438  What does if __name__ == &quot;__main__&quot;: do?
// 394809 8125  Does Python have a ternary conditional operator?
```

### Search — `search/advanced` vs `search`

Use `/search/advanced` when you need combined keyword + tag filtering. Use `/search` when searching only by title keyword (`intitle=`).

```js
// search/advanced: keyword in body OR title, filtered by tag, sorted by relevance
let data = JSON.parse(await http_get(
  "https://api.stackexchange.com/2.3/search/advanced"
  + "?q=asyncio+event+loop&tagged=python&site=stackoverflow&pagesize=5&order=desc&sort=relevance"
));
for (const q of data.items) {
  console.log(q.score, q.answer_count, q.title.slice(0, 70));
}
// 137 3  "Asyncio Event Loop is Closed" when getting loop
// 47  3  Can an asyncio event loop run in the background without suspending the

// search: title-only keyword search via intitle=
data = JSON.parse(await http_get(
  "https://api.stackexchange.com/2.3/search"
  + "?intitle=asyncio+event+loop&site=stackoverflow&pagesize=5&order=desc&sort=relevance"
));
```

`search/advanced` additional params: `accepted=True` (only questions with accepted answers), `answers=1` (minimum answer count), `body=` (keyword in body), `user=` (filter by owner user ID), `views=` (minimum view count), `fromdate=`/`todate=` (Unix timestamps).

### User profile

```js
// Basic user info
const user = JSON.parse(await http_get("https://api.stackexchange.com/2.3/users/1?site=stackoverflow"));
const u = user.items[0];
console.log("User:", u.display_name, "Rep:", u.reputation, "Badges:", u.badge_counts);
// User: Jeff Atwood  Rep: 64159  Badges: {bronze: 153, silver: 153, gold: 48}

// Fields: user_id, display_name, reputation, badge_counts, location, link,
//         creation_date, last_access_date, is_employee, account_id,
//         accept_rate, profile_image, website_url

// Timeline (badge, question, answer events)
let data = JSON.parse(await http_get("https://api.stackexchange.com/2.3/users/1/timeline?site=stackoverflow&pagesize=5"));
console.log("Event types:", new Set(data.items.map(i => i.timeline_type)));
// {'badge'}

// User's top answers
const answers = JSON.parse(await http_get("https://api.stackexchange.com/2.3/users/1/answers?site=stackoverflow&pagesize=5&order=desc&sort=votes"));
for (const a of answers.items) {
  console.log("Score:", a.score, "Question ID:", a.question_id);
}

// User's questions
const questions = JSON.parse(await http_get("https://api.stackexchange.com/2.3/users/1/questions?site=stackoverflow&pagesize=3&order=desc&sort=votes"));
for (const q of questions.items) {
  console.log(q.question_id, q.score, q.title.slice(0, 60));
}
// 9  2273  How do I calculate someone&#39;s age based on a DateTime typ
// 11 1656  Calculate relative time in C#
```

### Comments (requires `filter=withbody`)

```js
const data = JSON.parse(await http_get(
  "https://api.stackexchange.com/2.3/questions/231767/comments"
  + "?site=stackoverflow&pagesize=5&order=desc&sort=creation&filter=withbody"
));
for (const c of data.items) {
  console.log("Score:", c.score, "Body:", (c.body || "").slice(0, 80));
}
// Comment keys (without filter): comment_id, content_license, creation_date,
//   edited, owner, post_id, reply_to_user, score
// With filter=withbody: adds 'body' field (HTML-encoded)
```

### Related questions

```js
const related = JSON.parse(await http_get(
  "https://api.stackexchange.com/2.3/questions/231767/related?site=stackoverflow&pagesize=5"
));
for (const q of related.items) {
  console.log(q.question_id, q.score, q.title.slice(0, 60));
}
// 25232350 15 how generators work in python
// 28880095 11 What does a plain yield keyword do in Python?
```

### Popular tags

```js
const tags = JSON.parse(await http_get("https://api.stackexchange.com/2.3/tags?order=desc&sort=popular&site=stackoverflow&pagesize=5"));
for (const t of tags.items) {
  console.log(`${t.name}: ${t.count.toLocaleString()} questions`);
}
// javascript: 2,531,995 questions
// java: 1,921,907 questions
// c#: 1,626,728 questions
// python: (check live — grows daily)
```

---

## Pagination

Use `page=` (1-indexed) and `pagesize=` (max 100). Check `has_more` in the envelope to know whether a next page exists.

```js
async function fetchAllPages(urlBase, maxPages = 5) {
  // Fetch multiple pages from any Stack Exchange API endpoint.
  const results = [];
  for (let page = 1; page <= maxPages; page++) {
    const data = JSON.parse(await http_get(`${urlBase}&page=${page}`));
    results.push(...data.items);
    if (!data.has_more) break;
    if (data.backoff) {
      await wait(data.backoff);
    }
  }
  return results;
}

const questions = await fetchAllPages(
  "https://api.stackexchange.com/2.3/questions?order=desc&sort=votes"
  + "&tagged=python&site=stackoverflow&pagesize=10",
  3
);
console.log("Total fetched:", questions.length);  // up to 30
```

Note: `page=2` with `pagesize=3` returns the 4th–6th items. Confirmed working — `has_more: true` on page 2 of top Python questions.

---

## Parallel fetching (multiple questions or answers)

```js
async function pMap(items, limit, fn) {
  const out = []; let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) { const idx = i++; out[idx] = await fn(items[idx]); }
  });
  await Promise.all(workers); return out;
}

async function fetchTopAnswer(qid) {
  const data = JSON.parse(await http_get(
    `https://api.stackexchange.com/2.3/questions/${qid}/answers`
    + "?order=desc&sort=votes&site=stackoverflow&filter=withbody&pagesize=1"
  ));
  if (data.items.length) {
    const a = data.items[0];
    return { qid, top_score: a.score, accepted: a.is_accepted };
  }
  return { qid, top_score: 0 };
}

const qids = [231767, 419163, 394809, 100003, 82831];
const results = await pMap(qids, 3, fetchTopAnswer);

for (const r of results) {
  console.log(r);
}
// {qid: 231767, top_score: 18307, accepted: true}
// {qid: 419163, top_score: 9051, accepted: true}
// {qid: 394809, top_score: 9355, accepted: true}
// {qid: 100003, top_score: 9334, accepted: false}
// {qid: 82831, top_score: 6793, accepted: false}
```

Keep concurrency limit at 3 or below when unauthenticated — parallel calls consume quota simultaneously. At 3 workers, 5 questions used 5 quota units (expected).

---

## HTML page scraping (avoid for data tasks)

The HTML page works but returns 777KB and has no clean `QAPage` JSON-LD. Use it only when you need something not in the API (e.g. rendered MathJax, ads context).

```js
const unescapeHtml = (s) => s
  .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
  .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)))
  .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
  .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&nbsp;/g, " ");

const headers = {"User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36"};
const page = await http_get("https://stackoverflow.com/questions/231767/what-does-the-yield-keyword-do-in-python", headers);
console.log("HTML length:", page.length);   // 777138

// Page title (includes site suffix)
const titleM = page.match(/<title>([^<]+)<\/title>/);
if (titleM) {
  console.log(unescapeHtml(titleM[1]));
}
// 'iterator - What does the "yield" keyword do in Python? - Stack Overflow'

// Answer count via itemprop
const ansCount = page.match(/itemprop="answerCount"[^>]*>(\d+)</);
if (ansCount) {
  console.log("Answers:", ansCount[1]);   // '51'
}

// Score via itemprop (has whitespace around number)
const scoreM = page.match(/itemprop="upvoteCount"[^>]*>\s*(-?\d+)\s*</);
if (scoreM) {
  console.log("Score:", scoreM[1]);   // '13133'
}

// JSON-LD is present but only has WebSite and Organization — NOT QAPage/Question
const ldMatch = page.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/);
if (ldMatch) {
  const d = JSON.parse(ldMatch[1]);
  const types = (d["@graph"] || []).map(item => item["@type"]);
  console.log("JSON-LD types:", types);   // ['WebSite', 'Organization'] — no QAPage
}
```

---

## Gotchas

- **300 req/day unauthenticated is per IP, resets at midnight UTC.** 6 tests consumed ~27 quota units in one session. With parallel workers and loops, you can burn through 300 in minutes. Always check `quota_remaining` in responses.

- **`filter=withbody` is required for body content.** Without it, `body` is simply absent from the response — no error, no empty string, just a missing key. Applies to questions, answers, AND comments.

- **Title field has HTML entities, body field has full HTML markup.** They need different decoding strategies: `unescapeHtml()` for titles, tag-stripping for bodies. Don't confuse them.

- **Titles in API responses contain `&quot;`, `&lt;`, `&amp;`, `&#39;`** — raw output is `What does the &quot;yield&quot; keyword do in Python?`. Always call `unescapeHtml()` before displaying or comparing.

- **Batch IDs with semicolons, not commas.** `/questions/231767;419163;394809` fetches 3 questions in one API call. Using commas returns a 400 error.

- **`search/advanced` includes body text in results; `/search` only searches titles.** Use `search/advanced` with `q=` for full-text search. Use `/search` with `intitle=` for title-only.

- **HTTP errors are thrown as exceptions, not returned as JSON.** A bad `site=` param causes an HTTP 400 error — there's no JSON body accessible from `http_get`. Wrap API calls in try/catch.

- **`backoff` in the response envelope must be respected.** If `data.backoff` returns an integer (rare, typically 10–30 seconds), sleep that duration before the next call. Ignoring it will cause throttle errors on subsequent requests.

- **`/info` endpoint wraps stats inside `items[0]`**, not directly in the envelope. Access as `data.items[0].total_questions`.

- **JSON-LD on the HTML page is NOT QAPage schema.** The `<script type="application/ld+json">` block only contains `WebSite` and `Organization` objects in the `@graph` array. There is no `Question`, `Answer`, or `QAPage` type — confirmed on the most-voted Python question (231767). Don't rely on structured data from the HTML page.

- **User timeline `timeline_type` can be `badge`, `question`, `answer`, `comment`, `revision`, `suggested_edit`, `accepted`.** For very old/inactive users, all recent events may be `badge` only.

- **Multi-site support.** Change `site=stackoverflow` to any Stack Exchange site: `site=superuser`, `site=serverfault`, `site=askubuntu`, `site=unix`, `site=datascience`, `site=math`. Same API, same quota pool per IP.

- **`pagesize` max is 100.** Requesting more returns a 400 error. For bulk fetching, loop with `page=` and check `has_more`.
