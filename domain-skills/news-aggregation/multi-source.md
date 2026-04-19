# News Aggregation — Multi-Source

Field-tested against TechCrunch, The Verge, Ars Technica, BBC, Guardian, Wired, NPR, HN, Reuters, CNN, NYT (2026-04-18).

## Lead with RSS — fastest and most reliable

For every site that has a feed, `http_get` + regex/XML parsing is faster and more reliable than a browser. Use `Promise.all` for parallel fetches.

**Confirmed working RSS feeds (tested):**

| Source | Feed URL | Format | Items | Fetch time |
|--------|----------|--------|-------|------------|
| TechCrunch | `https://techcrunch.com/feed/` | RSS 2.0 | 20 | ~0.08s |
| Ars Technica | `https://feeds.arstechnica.com/arstechnica/index` | RSS 2.0 | 20 | ~0.10s |
| BBC News | `http://feeds.bbci.co.uk/news/rss.xml` | RSS 2.0 | 37 | ~0.23s |
| The Guardian (World) | `https://www.theguardian.com/world/rss` | RSS 2.0 | 45 | ~0.11s |
| The Guardian (Tech) | `https://www.theguardian.com/technology/rss` | RSS 2.0 | 32 | ~0.25s |
| Wired | `https://www.wired.com/feed/rss` | RSS 2.0 | 50 | ~0.10s |
| NPR Top Stories | `https://feeds.npr.org/1001/rss.xml` | RSS 2.0 | 10 | ~0.14s |
| Hacker News | `https://news.ycombinator.com/rss` | RSS 2.0 | 30 | ~0.16s |
| CNN Top Stories | `http://rss.cnn.com/rss/cnn_topstories.rss` | RSS 2.0 | 69 | ~0.25s |
| NYT Homepage | `https://rss.nytimes.com/services/xml/rss/nyt/HomePage.xml` | RSS 2.0 | 23 | ~0.12s |
| The Verge | `https://www.theverge.com/rss/index.xml` | **Atom** | 10 | ~0.15s |

## Parallel fetch pattern (4.3x speedup measured)

Sequential fetch of 7 feeds: **0.70s**. Parallel fetch of same 7 feeds: **0.16s** (4.3x speedup).

> Node has no stdlib XML parser, so the examples below extract `<item>`/`<entry>` blocks with regex.

```js
const RSS_FEEDS = [
  ["TechCrunch",     "https://techcrunch.com/feed/"],
  ["Ars Technica",   "https://feeds.arstechnica.com/arstechnica/index"],
  ["BBC News",       "http://feeds.bbci.co.uk/news/rss.xml"],
  ["Guardian World", "https://www.theguardian.com/world/rss"],
  ["Wired",          "https://www.wired.com/feed/rss"],
  ["NPR",            "https://feeds.npr.org/1001/rss.xml"],
  ["CNN",            "http://rss.cnn.com/rss/cnn_topstories.rss"],
];

async function fetch_rss([name, url]) {
  const xml_data = await http_get(url);
  const items = [...xml_data.matchAll(/<item>([\s\S]*?)<\/item>/g)].map(m => m[1]);
  return [name, items];
}

const results = await Promise.all(RSS_FEEDS.map(fetch_rss));

for (const [name, items] of results) {
  for (const item of items.slice(0, 5)) {
    const title = item.match(/<title>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/)?.[1]?.trim();
    const link  = item.match(/<link>([\s\S]*?)<\/link>/)?.[1]?.trim();
    console.log(`[${name}] ${title}`);
  }
}
```

## The Verge requires Atom-style parsing

The Verge's feed is Atom format, not RSS 2.0. The naive `<item>` match returns 0 entries. Atom uses `<entry>` blocks with `<link href="...">`:

```js
const xml_data = await http_get("https://www.theverge.com/rss/index.xml");
const entries = [...xml_data.matchAll(/<entry>([\s\S]*?)<\/entry>/g)].map(m => m[1]);   // 10 entries

for (const e of entries) {
  const title = e.match(/<title[^>]*>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/)?.[1]?.trim();
  const link  = e.match(/<link[^>]*\bhref="([^"]+)"/)?.[1];
  console.log(title, link);
}
```

## Sites that block http_get entirely

**Reuters** returns HTTP 403/Forbidden for all `http_get` calls, even with a real browser `User-Agent` header. Use browser fallback (see below).

```
Reuters: ERROR HTTP 401: Forbidden   // with AND without User-Agent
```

Reuters's old RSS feeds (`feeds.reuters.com/reuters/topNews`) resolve to DNS NXDOMAIN — they have been shut down.

## Sites that work fine with http_get + User-Agent

NYT, Guardian, HN, CNN all return full HTML via `http_get` without issues.

```js
const headers = { "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36" };
const nyt_html = await http_get("https://www.nytimes.com", headers);  // 1.1MB
const hn_html  = await http_get("https://news.ycombinator.com");      // 34KB
```

**HN parsing via regex (no HTML parser needed):**
```js
const html = await http_get("https://news.ycombinator.com");
const stories = [...html.matchAll(/class="titleline"><a href="([^"]+)"[^>]*>([^<]+)</g)]
  .map(m => ({ url: m[1], title: m[2] }));
// 30 stories on the front page
```

## Browser extraction — use when RSS is unavailable

### BBC (`bbc.com/news`)

```js
await goto("https://www.bbc.com/news");
await wait_for_load();
await wait(2);

const headlines = await js(`
  Array.from(document.querySelectorAll('article h2'))
    .map(h => ({
      title: h.innerText.trim(),
      url: h.closest('a')?.href || h.closest('[href]')?.href ||
           h.parentElement.querySelector('a')?.href
    }))
    .filter(h => h.title.length > 10)
`);
// Returns 50+ articles
```

If running from a EU IP and a consent banner appears:
```js
const accept = await js(`
  var btns = Array.from(document.querySelectorAll('button'));
  var btn = btns.find(b => /accept all|agree|continue/i.test(b.innerText));
  if (btn) { btn.click(); return 'clicked: ' + btn.innerText; }
  return 'no banner';
`);
```

Confirmed: `h3` elements on BBC are site-chrome labels, NOT article headlines. Use `article h2` only.

### TechCrunch (`techcrunch.com`)

`article` and `.post-block` selectors return 0 results — TechCrunch changed their layout. Articles are in `h3` elements.

```js
await goto("https://techcrunch.com");
await wait_for_load();
await wait(2);

const articles = await js(`
  Array.from(document.querySelectorAll('h3'))
    .map(h => ({
      title: h.innerText?.trim(),
      url: h.closest('a')?.href || h.querySelector('a')?.href ||
           h.parentElement?.querySelector('a')?.href
    }))
    .filter(a => a.title && a.title.length > 20)
`);
// ~10 articles. RSS is preferred (20 items, no JS required).
```

RSS is almost always faster for TechCrunch: **0.08s vs 3-5s browser** load.

### Reuters (`reuters.com`)

`http_get` returns 403. Browser loads but the homepage is heavily JS-rendered.

```js
await goto("https://www.reuters.com");
await wait_for_load();
await wait(3);
await js("window.scrollTo(0, 500)");
await wait(1);
const links = await js(`
  Array.from(document.querySelectorAll('a[href*="/world/"], a[href*="/technology/"]'))
    .filter(a => a.innerText.trim().length > 20)
    .map(a => ({text: a.innerText.trim(), href: a.href}))
`);
```

Reuters headlines are best obtained from the Guardian or AP — Reuters no longer has a public RSS and their JS hydration is slow.

## Decision tree: which approach to use

```
Does the site have an RSS/Atom feed?
  YES → http_get + regex (fastest, ~0.1s per feed)
         - RSS 2.0: match <item> blocks
         - Atom:    match <entry> blocks; <link href="..."> not <link>text</link>
  NO  → Does http_get return valid HTML (not 403/401/JS shell)?
          YES → http_get + regex (fast, ~0.2-0.3s)
          NO  → goto + wait_for_load + wait(2) + js() extraction (slow, 3-8s)
```

## What to skip

- **Reuters RSS** — DNS dead (`feeds.reuters.com` is NXDOMAIN)
- **Reuters http_get** — returns 403 regardless of User-Agent
- **TechCrunch `article`/`.post-block` selectors** — layout changed, use `h3` instead
- **BBC `h3` for headlines** — those are site-chrome labels; use `article h2`
- **The Verge `<item>` regex** — feed is Atom; match `<entry>` instead
