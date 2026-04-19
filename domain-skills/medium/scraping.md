# Medium — Data Extraction

`https://medium.com` — blogging platform. Three access paths tested and validated: the undocumented `?format=json` endpoint (fastest for article + publication data), the undocumented GraphQL API (best for targeted metric lookups), and RSS feeds (best for recent posts lists without auth). No browser needed for any read-only task.

## Do this first: pick your access path

| Goal | Best approach | Latency |
|------|--------------|---------|
| Article metadata + full body | `?format=json` on article URL | ~400ms |
| Article metrics only (claps, visibility) | GraphQL `post(id:)` | ~275ms |
| Author profile + follower count | GraphQL `user(username:)` | ~220ms |
| Recent posts for a user (up to 10) | `?format=json` on profile URL | ~240ms |
| Recent posts for a publication | `?format=json` on publication URL | ~300ms |
| Paginated post list (feed) | RSS feed | ~260ms |
| Full article body as HTML | RSS `content:encoded` field | ~260ms |
| Publication subscriber count | `?format=json` on publication URL | ~300ms |

**Never use a browser for read-only Medium tasks.** All article content, metadata, and metrics are available over HTTP. Browser is only needed for authenticated actions (clapping, posting, account management).

---

## The XSSI prefix

Every `?format=json` response starts with the anti-hijacking prefix `])}while(1);</x>` before the JSON. **Strip it before parsing.** The helper below handles this.

```js
async function medium_json(url) {
  // Fetch any Medium URL with ?format=json and return parsed object.
  // Strips the XSSI prefix ])}while(1);</x> automatically.
  // Works on: article URLs, user profile URLs, publication URLs.
  // Does NOT work on: search pages, /latest, profile stream API.
  const sep = url.includes("?") ? "&" : "?";
  const text = await http_get(url + sep + "format=json", {
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
    "Accept": "application/json, */*",
  });
  // Strip everything before the first {
  return JSON.parse(text.replace(/^[^{]+/, ""));
}
```

---

## Path 1: `?format=json` — article metadata + body (fastest for articles)

```js
const data = await medium_json("https://medium.com/@karpathy/software-2-0-a64152b37c35");
const payload = data.payload;
const val     = payload.value;        // article fields
const refs    = payload.references;   // User, Social, SocialStats objects keyed by ID

// --- Article fields ---
const title       = val.title;                              // "Software 2.0"
const article_id  = val.id;                                 // "a64152b37c35"
const creator_id  = val.creatorId;                          // "ac9d9a35533e"
const slug        = val.uniqueSlug;                         // "software-2-0-a64152b37c35"
const url         = val.canonicalUrl;
const first_pub   = val.firstPublishedAt;                   // unix ms: 1510438733751
const last_pub    = val.latestPublishedAt;                  // unix ms: 1615659523264
const visibility  = val.visibility;                         // 0=public, 2=subscriber-locked
const is_locked   = val.isSubscriptionLocked;               // true if paywalled
const locked_src  = val.lockedPostSource;                   // 0=free, 1=Medium Partner Program

// --- Metrics ---
const v = val.virtuals;
const clap_count  = v.totalClapCount;    // 60865 (all claps, including multi-clap)
const recommends  = v.recommends;        // 8846 (unique clappers)
const read_time   = v.readingTime;       // 8.79811320754717 (minutes)
const word_count  = v.wordCount;         // 2146

// --- Tags ---
const tags = v.tags.map(t => t.slug);
// ['machine-learning', 'artificial-intelligence', 'programming', 'software-development', 'future']

// --- Author (from references) ---
const user = refs.User[creator_id];
console.log(user.name, user.username, user.bio, user.twitterScreenName);

// --- Follower count (from SocialStats) ---
const ss = refs.SocialStats[creator_id];
console.log(ss.usersFollowedByCount, ss.usersFollowedCount);
```

### Detect paywall

```js
// Paywalled (Medium Partner Program): isSubscriptionLocked=true, visibility=2, lockedPostSource=1
// Free: isSubscriptionLocked=false, visibility=0, lockedPostSource=0
const is_paywalled = val.isSubscriptionLocked;
```

### Article body

```js
const paragraphs = val.content.bodyModel.paragraphs;

// Paragraph types:
// type=1  -> body text (P)
// type=3  -> heading (H1/H2)
// type=4  -> image (text is empty; metadata has image ID)

// Reconstruct plain text:
const text_paras = paragraphs.filter(p => p.text).map(p => p.text);
const full_text  = text_paras.join("\n\n");
```

---

## Path 2: GraphQL API — targeted metric lookups

`POST https://medium.com/_/graphql` with a JSON body. No auth, no CSRF token required.

```js
async function gql(query) {
  const r = await fetch("https://medium.com/_/graphql", {
    method: "POST",
    headers: {
      "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
      "Content-Type": "application/json",
      "Accept": "application/json",
    },
    body: JSON.stringify({ query }),
    signal: AbortSignal.timeout(20_000),
  });
  return await r.json();
}
```

### Fetch article metrics (fastest)

```js
const result = await gql(`
{
  post(id: "a64152b37c35") {
    title id firstPublishedAt latestPublishedAt visibility
    uniqueSlug canonicalUrl mediumUrl isLocked
    clapCount readingTime wordCount
  }
}
`);
const post = result.data.post;
// post.visibility  -> "PUBLIC" | "LOCKED"  (string, not numeric)
// post.clapCount   -> 60865  (same as totalClapCount in format=json)
// post.readingTime -> 8.79811320754717  (minutes)
```

**Confirmed working `post()` fields:** `title`, `id`, `createdAt`, `updatedAt`, `firstPublishedAt`, `latestPublishedAt`, `visibility`, `uniqueSlug`, `canonicalUrl`, `mediumUrl`, `isLocked`, `clapCount`, `readingTime`, `wordCount`

**Nested objects that work:** `topics { name slug }`, `creator { name username }`, `collection { name id slug description domain creator { name username } }`

**Fields that return HTTP 400:** `tags`, `author`, `recommends`, `content`, `publication`, `responses`, `sequence`

### Fetch author profile

```js
const result = await gql(`
{
  user(username: "karpathy") {
    name username id bio imageId twitterScreenName mediumMemberAt
    socialStats { followerCount followingCount }
  }
}
`);
const user = result.data.user;
// user.socialStats.followerCount -> 60028
// user.mediumMemberAt            -> 0 (not a member); nonzero = unix ms join date
```

**Confirmed working `user()` fields:** `name`, `username`, `id`, `bio`, `imageId`, `twitterScreenName`, `mediumMemberAt`, `socialStats { followerCount followingCount }`

**Fields that return HTTP 400:** `followerCount` (top-level), `followingCount` (top-level), `postCount`

### Fetch collection (publication) by ID

The GraphQL `collection()` query only accepts `id`, not `slug`. Get the ID from `?format=json` on the publication page.

```js
// TDS Archive id: 7f60cf5620c9  (from medium.com/towards-data-science?format=json)
const result = await gql(`
{
  collection(id: "7f60cf5620c9") {
    name id slug description domain creator { name username }
  }
}
`);
const coll = result.data.collection;
// coll.name -> "TDS Archive"
// coll.slug -> "data-science"
```

---

## Path 3: RSS feeds (best for recent posts list + article bodies)

Works with plain `http_get`. Returns up to 10 most recent posts. Full article HTML is in `content:encoded`. No clap count or visibility info in RSS.

```js
function parse_rss_items(rss_xml) {
  // Extract items from Medium RSS feed.
  const cdata = (tag, text) => {
    const m = text.match(new RegExp(`<${tag}[^>]*><!\\[CDATA\\[([\\s\\S]*?)\\]\\]></${tag}>`));
    return m ? m[1].trim() : null;
  };

  const items = [];
  for (const [, raw] of rss_xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const link_m = raw.match(/<link>([\s\S]*?)<\/link>/);
    items.push({
      title:     cdata("title", raw),
      link:      link_m ? link_m[1].trim() : null,
      pubDate:   cdata("pubDate", raw),
      creator:   cdata("dc:creator", raw),
      tags:      [...raw.matchAll(/<category><!\[CDATA\[([\s\S]*?)\]\]><\/category>/g)].map(m => m[1]),
      body_html: cdata("content:encoded", raw),   // full article HTML
    });
  }
  return items;
}

// User feed (up to 10 latest posts)
const rss = await http_get("https://medium.com/feed/@karpathy");
const posts = parse_rss_items(rss);
// posts[0].title     -> "Software 2.0"
// posts[0].pubDate   -> "Sat, 11 Nov 2017 22:18:53 GMT"
// posts[0].creator   -> "Andrej Karpathy"
// posts[0].tags      -> ['programming', 'software-development', ...]
// posts[0].link      -> "https://karpathy.medium.com/software-2-0-a64152b37c35?source=rss-..."
// posts[0].body_html -> full article body as HTML string (~15KB)

// Publication feed (up to 10 latest posts)
const rss_pub = await http_get("https://medium.com/feed/towards-data-science");
const pub_posts = parse_rss_items(rss_pub);
```

**RSS limitations:**
- RSS does not include clap count, view count, or paywall status.
- `body_html` contains the full article body as HTML.
- Pagination is not supported — RSS always returns the 10 most recent posts.

---

## Path 4: `?format=json` on user profile — recent posts with metrics

```js
const data = await medium_json("https://medium.com/@karpathy?limit=10");
const payload = data.payload;

const user = payload.user;
const refs = payload.references;
const ss   = refs.SocialStats[user.userId];
// ss.usersFollowedByCount -> 60028 (followers)

const posts = refs.Post || {};  // object keyed by post ID
for (const [pid, p] of Object.entries(posts)) {
  const v = p.virtuals;
  console.log(p.title, v.totalClapCount, v.readingTime.toFixed(1));
}

// Paginate: use paging.next from payload
const paging = payload.paging;
const next_params = paging.next;
// next_params = {limit: 10, to: '1495652975362', source: 'overview', page: 2, ignoredIds: []}
const next_url = `https://medium.com/@${user.username}`
  + `?limit=${next_params.limit}&to=${next_params.to}`
  + `&source=${next_params.source}&page=${next_params.page}`;
const data2 = await medium_json(next_url);
```

---

## Path 5: `?format=json` on publication page

```js
const data = await medium_json("https://medium.com/towards-data-science");
const payload = data.payload;

const coll = payload.collection;
// coll.name            -> "TDS Archive"
// coll.subscriberCount -> 828527
// coll.tags            -> ['DATA SCIENCE', 'MACHINE LEARNING', ...]

const posts = payload.references.Post || {};
for (const p of Object.values(posts)) {
  console.log(p.title, p.virtuals.totalClapCount, p.isSubscriptionLocked);
}
```

---

## Retrieving the article ID from a URL

The `id` is the last 12 hex chars of a Medium article URL slug:

```js
const url = "https://medium.com/@karpathy/software-2-0-a64152b37c35";
const article_id = url.replace(/\/$/, "").split("?")[0].match(/-([a-f0-9]{12})$/)?.[1];
// "a64152b37c35"
```

This ID is the same across all URL forms (`medium.com/@user/slug`, `user.medium.com/slug`, `medium.com/publication/slug`).

---

## Gotchas

- **HTTP 403 on plain `http_get`** — The default `http_get` helper sends `User-Agent: Mozilla/5.0` which Medium accepts for most endpoints, but article HTML pages (without `?format=json`) return 403. Always use `?format=json` for article and profile pages.

- **`?format=json` works; profile stream API does not** — `https://medium.com/_/api/users/{id}/profile/stream` returns HTTP 403 for unauthenticated requests. Use `?format=json` on the profile URL instead.

- **`?format=json` on search pages returns 403 or broken JSON** — Search is not available without auth.

- **GraphQL `collection()` requires ID, not slug** — `collection(slug: "...")` returns HTTP 400. You must use the numeric ID. Get it from `?format=json` on the publication page: `payload.collection.id`.

- **GraphQL `tags` field on `post()` returns HTTP 400** — Use `topics { name slug }` instead.

- **GraphQL visibility is a string, not a number** — `post().visibility` returns `"PUBLIC"` or `"LOCKED"`. The `?format=json` `value.visibility` field uses integers: `0`=public, `2`=locked.

- **`totalClapCount` vs `recommends`** — `totalClapCount` (60865) counts all claps (Medium allows up to 50 claps per reader). `recommends` (8846) counts unique clappers. The GraphQL `clapCount` equals `totalClapCount`.

- **RSS returns at most 10 items, no clap counts** — Use `?format=json` profile if you need metrics.

- **RSS link contains tracking params** — Strip with `.split("?")[0]` if you need a clean URL.

- **`content:encoded` in RSS is full HTML, not plaintext** — Strip HTML tags if you want plaintext: `body_html.replace(/<[^>]+>/g, "")`.

- **Medium subdomains** — Some users have custom subdomains (`karpathy.medium.com`). Both `medium.com/@karpathy/...` and `karpathy.medium.com/...` resolve to the same article; `?format=json` works on both.

- **towardsdatascience.com is no longer Medium** — TDS moved to its own WordPress site. Use `medium.com/towards-data-science` for the archived Medium publication.

- **No public search API** — Medium has no Algolia equivalent. Finding articles by keyword requires either a browser, or fetching a user/publication feed and filtering locally.

- **Timestamps are unix milliseconds** — `firstPublishedAt`, `createdAt`, `latestPublishedAt` are all in ms. Convert: `new Date(val.firstPublishedAt)`.
