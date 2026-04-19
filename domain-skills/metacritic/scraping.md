# Metacritic — Scraping & Data Extraction

Field-tested against metacritic.com on 2026-04-18. All code blocks validated with live requests.

## Do this first

**Use the backend API — it returns clean JSON with both scores in one call, no HTML parsing.**

```js
const API_KEY = "1MOZgmNFxvmljaQR1X9KAij9Mo4xAY3u";

async function get_game_scores(slug) {
  // slug = URL slug e.g. 'elden-ring', 'the-last-of-us'
  const base = "https://backend.metacritic.com";
  const product = JSON.parse(await http_get(
    `${base}/games/metacritic/${slug}/web`
    + `?componentName=product&componentType=Product&apiKey=${API_KEY}`
  ));
  const user_stats = JSON.parse(await http_get(
    `${base}/reviews/metacritic/user/games/${slug}/stats/web`
    + `?componentName=user-score-summary&componentType=ScoreSummary&apiKey=${API_KEY}`
  ));
  const item = product.data.item;
  const crit = item.criticScoreSummary;
  const user = user_stats.data.item;
  return {
    title: item.title,
    platform: item.platform,            // lead platform
    platforms: item.platforms,          // array with per-platform scores
    metascore: crit.score,              // int 0–100 or null
    critic_reviews: crit.reviewCount,
    critic_sentiment: crit.sentiment,
    user_score: user.score,             // float 0.0–10.0 or null
    user_reviews: user.reviewCount,
    user_sentiment: user.sentiment,
    release_date: item.releaseDate,     // "YYYY-MM-DD"
  };
}

console.log(await get_game_scores("the-last-of-us"));
// {title: 'The Last of Us', platform: 'PlayStation 3',
//  metascore: 95, critic_reviews: 98,
//  user_score: 9.2, user_reviews: 17207, ...}
```

Use the browser **only** if you need music pages — `metacritic.com/music/*` returns HTTP 403 to `http_get`.

---

## Fastest approach: JSON-LD (critic score + review count only)

```js
const url = "https://www.metacritic.com/game/elden-ring/";
const html = await http_get(url);

const block = [...html.matchAll(/<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g)][0][1];
const ld = JSON.parse(block);

const agg = ld.aggregateRating;
console.log(ld.name);              // "Elden Ring"
console.log(agg.ratingValue);      // 96  (metascore)
console.log(agg.reviewCount);      // 93  (critic reviews count)
console.log(ld.gamePlatform);      // ['Xbox One', 'PC', 'PlayStation 4', 'Xbox Series X', 'PlayStation 5']
console.log(ld.genre);             // "Action RPG"
console.log(ld.contentRating);     // "M"
console.log(ld.datePublished);     // "2022-02-25"
```

**JSON-LD limitations:**
- Only contains Metascore and critic review count — **no user score, no user review count**.
- For multi-platform games, `ratingValue` is the lead platform score.
- `@type` is `VideoGame` for games, `Movie` for movies, `TVSeries` for TV shows.

---

## Common workflows

### Get scores for a single title (backend API)

```js
const API_KEY = "1MOZgmNFxvmljaQR1X9KAij9Mo4xAY3u";
const BASE = "https://backend.metacritic.com";

async function scores(media, slug) {
  // media: "games" | "movies" | "shows"
  const p = JSON.parse(await http_get(
    `${BASE}/${media}/metacritic/${slug}/web?componentName=product&componentType=Product&apiKey=${API_KEY}`
  ));
  const u = JSON.parse(await http_get(
    `${BASE}/reviews/metacritic/user/${media}/${slug}/stats/web?componentName=user-score-summary&componentType=ScoreSummary&apiKey=${API_KEY}`
  ));
  const c = p.data.item.criticScoreSummary;
  const us = u.data.item;
  return {
    metascore: c.score, critic_reviews: c.reviewCount,
    user_score: us.score, user_reviews: us.reviewCount,
  };
}

console.log(await scores("games", "the-last-of-us"));
// {metascore: 95, critic_reviews: 98, user_score: 9.2, user_reviews: 17207}
console.log(await scores("movies", "the-godfather"));
// {metascore: 100, critic_reviews: 16, user_score: 9.2, user_reviews: 4450}
console.log(await scores("shows", "breaking-bad"));
// {metascore: 87, critic_reviews: 98, user_score: 9.4, user_reviews: 19070}
```

### Parallel fetching (multiple titles at once)

10 API calls in 0.68s with 5 workers — no rate-limit errors:

```js
const API_KEY = "1MOZgmNFxvmljaQR1X9KAij9Mo4xAY3u";

async function batch_game_scores(slugs) {
  const BASE = "https://backend.metacritic.com";
  const AK = `apiKey=${API_KEY}`;

  const fetchOne = async (slug) => {
    const c = JSON.parse(await http_get(
      `${BASE}/reviews/metacritic/critic/games/${slug}/stats/web?componentName=critic-score-summary&componentType=ScoreSummary&${AK}`
    ));
    const u = JSON.parse(await http_get(
      `${BASE}/reviews/metacritic/user/games/${slug}/stats/web?componentName=user-score-summary&componentType=ScoreSummary&${AK}`
    ));
    const ci = c.data.item, ui = u.data.item;
    return { slug, metascore: ci.score, critic_reviews: ci.reviewCount, user_score: ui.score, user_reviews: ui.reviewCount };
  };

  return await Promise.all(slugs.map(fetchOne));
}

const results = await batch_game_scores([
  "the-last-of-us", "elden-ring", "god-of-war",
  "red-dead-redemption-2", "the-witcher-3-wild-hunt"
]);
```

### Search by title

```js
const API_KEY = "1MOZgmNFxvmljaQR1X9KAij9Mo4xAY3u";

async function search(query, media_type = null, limit = 10) {
  // media_type: null='all', 'games' (mcoTypeId=13), 'movies' (2), 'shows' (1)
  const type_map = { games: 13, movies: 2, shows: 1 };
  const q = encodeURIComponent(query);
  const type_param = media_type
    ? `&mcoTypeId=${type_map[media_type]}`
    : "&mcoTypeId=1%2C2%2C3%2C13";
  const url = `https://backend.metacritic.com/finder/metacritic/search/${q}/web`
    + `?offset=0&limit=${limit}&sortBy=META_SCORE&sortDirection=DESC`
    + `${type_param}&componentName=search&componentType=SearchResult`
    + `&apiKey=${API_KEY}`;
  const data = JSON.parse(await http_get(url));
  return data.data.items.map(i => ({
    title: i.title,
    type: i.type,          // "game-title", "movie", "tv-show"
    slug: i.slug,
    year: i.premiereYear,
    metascore: i.criticScoreSummary?.score,
    user_score: i.userScore,  // null in search results
  }));
}

const results = await search("elden ring", "games");
```

### Browse/list titles by score

```js
const API_KEY = "1MOZgmNFxvmljaQR1X9KAij9Mo4xAY3u";

async function browse_games({ sort_by = "-metaScore", year_min, year_max, offset = 0, limit = 24 } = {}) {
  let params = `sortBy=${sort_by}&mcoTypeId=13&offset=${offset}&limit=${limit}`;
  if (year_min) params += `&releaseYearMin=${year_min}`;
  if (year_max) params += `&releaseYearMax=${year_max}`;
  const url = `https://backend.metacritic.com/finder/metacritic/web?${params}&componentName=finder&componentType=Finder&apiKey=${API_KEY}`;
  const data = JSON.parse(await http_get(url));
  const total = data.data.totalResults;
  const items = data.data.items.map(i => ({
    title: i.title,
    slug: i.slug,
    year: i.premiereYear,
    metascore: i.criticScoreSummary?.score,
    critic_reviews: i.criticScoreSummary?.reviewCount,
    user_score: typeof i.userScore === "object" && i.userScore !== null
      ? i.userScore.score
      : i.userScore,
  }));
  return [total, items];
}

const [total, games] = await browse_games({ year_min: 2023, year_max: 2024 });
console.log(`${total} games 2023-2024`);   // 953
```

Finder API totals (confirmed 2026-04-18):
- Games (mcoTypeId=13): 14,160
- Movies (mcoTypeId=2): 17,152
- TV Shows (mcoTypeId=1): 3,392

### Get per-platform scores for multi-platform games

```js
const API_KEY = "1MOZgmNFxvmljaQR1X9KAij9Mo4xAY3u";

async function game_platforms(slug) {
  const url = `https://backend.metacritic.com/games/metacritic/${slug}/web`
    + `?componentName=product&componentType=Product&apiKey=${API_KEY}`;
  const data = JSON.parse(await http_get(url));
  return data.data.item.platforms.map(p => ({
    name: p.name,
    slug: p.slug,
    is_lead: p.isLeadPlatform,
    metascore: p.criticScoreSummary.score,
    critic_reviews: p.criticScoreSummary.reviewCount,
    release_date: p.releaseDate,
  }));
}
```

### Get critic reviews (paginated)

```js
const API_KEY = "1MOZgmNFxvmljaQR1X9KAij9Mo4xAY3u";

async function get_critic_reviews(slug, { media = "games", offset = 0, limit = 10, sort = "date" } = {}) {
  const url = `https://backend.metacritic.com/reviews/metacritic/critic/${media}/${slug}/web`
    + `?offset=${offset}&limit=${limit}&sort=${sort}`
    + `&componentName=latest-critic-reviews&componentType=CriticReviewList&apiKey=${API_KEY}`;
  const data = JSON.parse(await http_get(url));
  const total = data.data.totalResults;
  const reviews = data.data.items.map(r => ({
    score: r.score,
    publication: r.publicationName,
    quote: r.quote,
    date: r.date,
    url: r.url,
  }));
  return [total, reviews];
}

const [total, reviews] = await get_critic_reviews("the-last-of-us", { sort: "score" });
```

### Get user reviews (paginated)

```js
const API_KEY = "1MOZgmNFxvmljaQR1X9KAij9Mo4xAY3u";

async function get_user_reviews(slug, { media = "games", offset = 0, limit = 10, order_by = "score", order_type = "desc" } = {}) {
  const url = `https://backend.metacritic.com/reviews/metacritic/user/${media}/${slug}/web`
    + `?offset=${offset}&limit=${limit}&orderBy=${order_by}&orderType=${order_type}`
    + `&componentName=top-user-reviews&componentType=UserReviewList&apiKey=${API_KEY}`;
  const data = JSON.parse(await http_get(url));
  const total = data.data.totalResults;
  const reviews = data.data.items.map(r => ({
    score: r.score,
    quote: r.quote,
    date: r.date,
    spoiler: r.spoiler ?? false,
  }));
  return [total, reviews];
}
```

---

## URL slug patterns

Metacritic slugs are lowercased, spaces replaced with hyphens, special chars dropped:

| Title | Slug |
|-------|------|
| `The Last of Us` | `the-last-of-us` |
| `Baldur's Gate 3` | `baldurs-gate-3` |
| `Elden Ring: Shadow of the Erdtree` | `elden-ring-shadow-of-the-erdtree` |
| `Breaking Bad` | `breaking-bad` |

Derive slug from the page URL:

```js
function slug_from_url(url) {
  return url.match(/\/(?:game|movie|tv)\/([^/]+)\//)?.[1] || null;
}
```

---

## Anti-bot measures

- **Cloudflare** is in front of both `metacritic.com` and `backend.metacritic.com`.
- **Frontend pages**: Require a non-empty User-Agent. `Mozilla/5.0` works.
- **Backend API**: Same rule — any non-empty User-Agent works.
- **Music pages** (`metacritic.com/music/*`): HTTP 403 even with valid User-Agent. Use the browser via CDP for music pages.
- **Cache**: Frontend pages are Cloudflare-cached (10 minute TTL). Backend API responses are not cached.
- **No CAPTCHA** observed during testing.
- **No rate limit** hit during testing.

---

## Gotchas

- **API key is embedded in every Metacritic page HTML** — find it by searching for `apiKey=` in `backend.metacritic.com` URLs. The key `1MOZgmNFxvmljaQR1X9KAij9Mo4xAY3u` was confirmed active as of 2026-04-18. If it rotates: `html.match(/apiKey=([A-Za-z0-9]+)/)[1]`.

- **userScore is null in search results** — call the stats API separately with the slug.

- **Metascore null means < 4 reviews** — the backend API returns `score: null` (not 0). Always check `if (score != null)` before using.

- **Multi-platform games: JSON-LD shows lead platform score** — for a game on PS5 and Xbox, `aggregateRating.ratingValue` in JSON-LD is the lead platform's score. Use the product API's `platforms` array for per-platform breakdown.

- **Music is blocked** — `metacritic.com/music/*` returns HTTP 403. The backend API for albums also returns 404. Music data requires a real browser session via CDP.

- **`http_get` default UA is `Mozilla/5.0`** — this works for Metacritic. No need to override it.

- **Backend API `componentName` and `componentType` params are required** — omitting them returns HTTP 400.

- **Finder `userScore` format**: In finder/browse results, `userScore` is `{score: 9.1}` (an object with just `score`). In the stats API, it's a full object with `reviewCount`, `sentiment`, etc. In search results, it's `null`.

- **Media type URL paths**: games=`/games/`, movies=`/movies/`, TV shows=`/shows/`. There is no `/tv/` path in the backend API.

- **Finder API does not support free-text search** — the `q=` param is silently ignored. Use the `/finder/metacritic/search/{query}/web` endpoint for title search.
