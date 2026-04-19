# Letterboxd — Film Data Scraping

`https://letterboxd.com` — film logging, rating, and review site. Film pages and user profile root pages are publicly accessible via `http_get` (~200–350ms). Most sub-pages (reviews, ratings, user film lists, browse/genre pages) return 403 and require the browser.

## Access path decision table

| Goal | Method | Latency |
|------|--------|---------|
| Film metadata (title, year, director, cast, genres, rating) | `http_get` + JSON-LD | ~200–350ms |
| Film synopsis, poster, OG data | `http_get` + meta tags | same request |
| Film popular reviews (top 12 inline) | `http_get` film page | same request |
| User profile stats (film count, followers) | `http_get` user root | ~150ms |
| Recent global activity stream | `http_get /films/` | ~200ms |
| User watched film list | browser (`/{username}/films/`) | |
| Ratings distribution histogram | browser (`/film/{slug}/ratings/`) | |
| All reviews (paginated) | browser (`/film/{slug}/reviews/`) | |
| Popular / browse / genre film lists | browser (`/films/popular/`, etc.) | |
| Director / actor pages | browser (`/director/{slug}/`, `/actor/{slug}/`) | |
| User diary / lists | browser (`/{username}/diary/`, `/{username}/lists/`) | |

**Letterboxd's public API** (`api.letterboxd.com/api/v0/`) returns 401 on all endpoints — it requires OAuth2 client credentials (apply at letterboxd.com/api-beta/).

**Cloudflare Turnstile** is configured in the page JS but is not blocking `http_get` on accessible pages. It only activates on the login form.

Small HTML-entity decoder reused throughout:

```js
const unescapeHtml = (s) => s
  .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
  .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)))
  .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
  .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&nbsp;/g, " ");
```

---

## Path 1: Film page via http_get (fastest for metadata + ratings)

Film pages at `letterboxd.com/film/{slug}/` are fully accessible. The JSON-LD block (Movie schema) contains everything you need in one parse.

**URL slug format:** lowercase title, spaces replaced with hyphens. For disambiguation (same title, different year) append `-{year}`: e.g. `parasite-2019`, `alien-1979`.

```js
async function extract_film_data(slug) {
  // slug examples: 'the-godfather', 'parasite-2019', 'inception', '2001-a-space-odyssey'
  const html = await http_get(`https://letterboxd.com/film/${slug}/`);
  const result = {};

  // --- JSON-LD (primary source) ---
  const blocks = [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map(m => m[1]);
  for (const block of blocks) {
    // Strip CDATA wrapper that Letterboxd wraps around JSON-LD
    const cleaned = block
      .replace(/\/\*\s*<!\[CDATA\[[\s\S]*?\*\/\s*/g, "")
      .replace(/\/\*\s*\]\]>[\s\S]*?\*\//g, "")
      .trim();
    let data;
    try { data = JSON.parse(cleaned); }
    catch { continue; }
    if (data["@type"] !== "Movie") continue;

    result.title     = data.name;
    result.year      = data.releasedEvent?.[0]?.startDate || null;
    result.directors = (data.director || []).map(d => d.name);
    result.genres    = data.genre || [];
    result.countries = (data.countryOfOrigin || []).map(c => c.name);
    result.studios   = (data.productionCompany || []).map(s => s.name);
    result.actors    = (data.actors || []).map(a => a.name);
    result.poster_url = data.image;
    result.url       = data.url;
    const r = data.aggregateRating || {};
    result.rating       = r.ratingValue;   // float 0.0–5.0
    result.rating_count = r.ratingCount;   // int, total ratings cast
    result.review_count = r.reviewCount;   // int, written reviews only
  }

  // --- OG / meta tags (fast fallback, redundant) ---
  const og = (prop) => html.match(new RegExp(`<meta[^>]+property="og:${prop}"[^>]+content="([^"]*)"`))?.[1] ?? null;
  result.og_title  = og("title");       // includes year: "The Godfather (1972)"
  result.synopsis  = unescapeHtml(og("description") || "");
  result.og_image  = og("image");       // large 1200x675 crop

  // --- Film ID (internal numeric ID) ---
  result.film_id = html.match(/data-film-id="(\d+)"/)?.[1] || null;

  // --- Tagline ---
  const tagline_m = html.match(/<h4 class="tagline">([^<]+)<\/h4>/);
  result.tagline = tagline_m ? unescapeHtml(tagline_m[1]) : null;

  // --- Themes (from tab-genres section) ---
  const themes_m = html.match(/<h3><span>Themes<\/span><\/h3>[\s\S]*?<p>([\s\S]*?)<\/p>/);
  result.themes = themes_m
    ? [...themes_m[1].matchAll(/class="text-slug">([^<]+)<\/a>/g)].map(m => m[1])
    : [];

  // --- Languages ---
  result.languages = [...html.matchAll(/href="\/films\/language\/[^/]+\/"[^>]*>([^<]+)<\/a>/g)].map(m => m[1]);

  // --- Fans count ---
  const fans_m = html.match(/class="accessory"[^>]*>\s*([\d,KkMm]+)\s*fans<\/a>/);
  result.fans = fans_m ? fans_m[1] : null;  // e.g. "133K"

  // --- Popular reviews (top 12 inline on the page) ---
  result.reviews = [];
  const reviewRe = /<article class="production-viewing[^"]*"[^>]*data-viewing-id="(\d+)"[^>]*data-person="([^"]+)">([\s\S]*?)<\/article>/g;
  for (const [, vid, person, block] of html.matchAll(reviewRe)) {
    const dm = block.match(/<strong class="displayname">([^<]+)<\/strong>/);
    const tm = block.match(/class="body-text -prose -reset[^"]*"[^>]*>([\s\S]*?)<\/div>/);
    const lm = block.match(/data-count="(\d+)"/);
    result.reviews.push({
      viewing_id:   vid,
      username:     person,
      display_name: dm ? dm[1] : person,
      review:       tm ? tm[1].replace(/<[^>]+>/g, "").trim() : "",
      likes:        lm ? parseInt(lm[1], 10) : 0,
    });
  }

  return result;
}
```

### Verified output (2026-04-18)

```js
let data = await extract_film_data("the-godfather");
// {
//   title: 'The Godfather', year: '1972',
//   directors: ['Francis Ford Coppola'],
//   genres: ['Crime', 'Drama'], countries: ['USA'],
//   studios: ['Paramount Pictures', 'Alfran Productions'],
//   actors: ['Marlon Brando', 'Al Pacino', 'James Caan', ...],
//   rating: 4.52, rating_count: 2619662, review_count: 372579,
//   fans: '133K', film_id: '51818',
//   tagline: "An offer you can't refuse.",
//   themes: ['Crime, drugs and gangsters', ...],
//   og_title: 'The Godfather (1972)',
//   synopsis: 'Spanning the years 1945 to 1955...',
//   reviews: [...]  // 12 total
// }

data = await extract_film_data("parasite-2019");
// title: 'Parasite', year: '2019', rating: 4.53, rating_count: 5264520, review_count: 690652
data = await extract_film_data("inception");
// title: 'Inception', year: '2010', rating: 4.23, rating_count: 3913620
```

---

## Path 2: User profile via http_get

Only the user root page `letterboxd.com/{username}/` is accessible. Sub-pages (`/films/`, `/diary/`, `/lists/`) return 403.

```js
async function extract_user_profile(username) {
  const html = await http_get(`https://letterboxd.com/${username}/`);

  const dm = html.match(/class="displayname tooltip"[^>]*><span class="label">([^<]+)<\/span>/);

  // Stats block (Films / This year / Lists / Following / Followers)
  const stats_pairs = [...html.matchAll(
    /<span class="value">(\d[\d,]*)<\/span><span class="definition[^"]*">([^<]+)<\/span>/g
  )];
  const stats = Object.fromEntries(
    stats_pairs.map(([, val, label]) => [label.trim(), parseInt(val.replace(/,/g, ""), 10)])
  );

  // Favorites from OG description
  const od = html.match(/<meta[^>]+property="og:description"[^>]+content="([^"]*)"/);
  let favorites = [];
  if (od) {
    const fm = od[1].match(/Favorites:\s*([^.]+)\./);
    if (fm) favorites = fm[1].split(",").map(s => s.trim());
  }

  // Film IDs of films shown on profile page (recent activity)
  const film_ids_on_page = [...new Set(
    [...html.matchAll(/data-film-id="(\d+)"/g)].map(m => m[1])
  )];

  return {
    username,
    display_name: dm ? dm[1] : null,
    stats,
    favorites,
    film_ids_on_page,
  };
}
```

### Verified output

```js
const data = await extract_user_profile("dave");
// {
//   username: 'dave',
//   display_name: 'Dave Vis',
//   stats: {Films: 2553, 'This year': 63, Lists: 155, Following: 77, Followers: 34512},
//   favorites: ['High and Low (1963)', 'Burning (2018)', 'My Neighbor Totoro (1988)', 'Mulholland Drive (2001)'],
//   film_ids_on_page: ['51818', '47756', ...]  // ~32 film IDs
// }
```

---

## Path 3: Global activity stream from /films/

`letterboxd.com/films/` returns the recent global activity feed — approximately 6 full viewing entries, plus many more film slugs from the UI.

```js
async function extract_activity_stream() {
  const html = await http_get("https://letterboxd.com/films/");
  const entries = [];
  const blockRe = /class="production-viewing[^"]*"[^>]*data-owner="([^"]+)"[^>]*data-object-id="([^"]+)"[^>]*>([\s\S]*?)<\/article>/g;
  for (const [, owner, obj_id, block] of html.matchAll(blockRe)) {
    const film_m = block.match(
      /data-item-name="([^"]*)"[\s\S]*?data-item-slug="([^"]*)"[\s\S]*?data-film-id="(\d+)"/
    );
    if (film_m) {
      entries.push({
        owner,
        film_name: unescapeHtml(film_m[1]),
        film_slug: film_m[2],
        film_id:   film_m[3],
      });
    }
  }
  return entries;
}

// Returns ~6 entries. Film names are in "Title (Year)" format.
```

---

## Path 4: Browser for list pages and sub-pages (403 via http_get)

```js
// Popular films
await goto("https://letterboxd.com/films/popular/");
await wait_for_load();
await wait(2);

const films = await js(`
(function() {
  var items = Array.from(document.querySelectorAll('li.film-list-entry, li[class*="poster-container"]'));
  return items.slice(0, 30).map(function(el) {
    var poster = el.querySelector('[data-item-slug]') || el.querySelector('[data-film-slug]');
    return {
      name: poster ? (poster.dataset.itemName || poster.dataset.filmName) : null,
      slug: poster ? (poster.dataset.itemSlug || poster.dataset.filmSlug) : null,
      film_id: poster ? poster.dataset.filmId : null
    };
  }).filter(function(x){ return x.slug; });
})()
`);

// User watched films list (paginated, 72/page)
await goto("https://letterboxd.com/dave/films/");
await wait_for_load();
await wait(2);

const user_films = await js(`
(function() {
  var items = Array.from(document.querySelectorAll('li[data-film-id]'));
  return items.map(function(el) {
    return {
      film_id:   el.dataset.filmId,
      film_slug: el.dataset.targetLink ? el.dataset.targetLink.replace(/\\/film\\/|\\/$/g,'') : null,
      rating:    el.dataset.ownerRating || null
    };
  });
})()
`);

// For paginated browsing, check next page link
const next_page_url = await js(`
  (function() { var a = document.querySelector('a.next'); return a ? a.href : null; })()
`);
// Returns URL for next page or null. Load it with goto(next_page_url).
```

---

## Gotchas

**JSON-LD is wrapped in CDATA comments** — `JSON.parse(block)` will fail without stripping the wrapper. Always strip `/* <![CDATA[ */` and `/* ]]> */` first (see `extract_film_data` above).

**JSON-LD `name` is bare title, not "Title (Year)"** — `data.name` returns `'Parasite'`, not `'Parasite (2019)'`. Year is in `data.releasedEvent[0].startDate`. The OG `og:title` meta tag does include the year.

**OG description contains HTML entities** — `og:description` and `tagline` use `&#039;` etc. Always run through `unescapeHtml` on them.

**`languages` list can have duplicates** — e.g. Parasite returns `['Korean', 'English', 'German', 'Korean']`. Dedupe with `[...new Set(result.languages)]`.

**Disambiguation slugs** — when two films share a title, Letterboxd appends the year to the slug: `parasite-2019` (Bong's film), vs `parasite` (1982 film). If your slug 404s, try appending `-{year}`.

**403 pages** — `/film/{slug}/reviews/`, `/film/{slug}/ratings/`, `/film/{slug}/cast/`, `/film/{slug}/details/`, `/{username}/films/`, `/films/popular/`, `/films/by/rating/`, `/genre/{slug}/`, `/director/{slug}/`, `/actor/{slug}/` all return 403 to `http_get`. These require the browser.

**CSI endpoints are 403** — Letterboxd loads the ratings histogram via `/csi/film/{slug}/rating-histogram/` which returns 403 without a session cookie. Access ratings distribution via browser on `/film/{slug}/ratings/`.

**Cloudflare Turnstile is present but passive** — only activates on the login form. It does not block unauthenticated reads on public film/user pages.

**The official API requires OAuth** — `api.letterboxd.com/api/v0/` returns 401 on all endpoints. Apply for API access at letterboxd.com/api-beta/ to get client credentials.

**Fans count is abbreviated** — `'133K'`, `'175K'`. Parse with:
```js
function parse_abbrev(s) {
  s = s.trim().toUpperCase();
  if (s.endsWith("K")) return Math.round(parseFloat(s.slice(0, -1)) * 1000);
  if (s.endsWith("M")) return Math.round(parseFloat(s.slice(0, -1)) * 1_000_000);
  return parseInt(s.replace(/,/g, ""), 10);
}
```

**Film slug from unknown title** — Letterboxd has no public search API. Construct the slug by lowercasing the title and replacing spaces with hyphens, then `http_get` and check for a 403/404 vs a valid JSON-LD block.
