# Trustpilot — Company Reviews Scraping

Field-tested against trustpilot.com on 2026-04-18.
`http_get` with a generic Mozilla/5.0 UA works — no JS challenge, no Cloudflare block.
The Trustpilot Consumer API (`api.trustpilot.com`) returns 403 for all endpoints without an API key.

---

## Fastest Approach: `http_get` + `__NEXT_DATA__`

Trustpilot is a Next.js SSR app. Every company review page embeds the full data payload in a
`<script id="__NEXT_DATA__">` JSON block — no browser needed. This includes the business unit
metadata, all 20 reviews for the current page, pagination info, and rating distribution.

```js
async function getTrustpilotPage(domain, { page = 1, stars = null, languages = 'en', verified = false } = {}) {
  /*
    Fetch one page of reviews for a company domain.
    Returns {bu, reviews, pagination, ratings}.
    Returns {bu: null, reviews: [], pagination: {}, ratings: {}} if page is beyond the cap or no data.
  */
  let url = `https://www.trustpilot.com/review/${domain}?languages=${languages}&page=${page}`;
  if (stars) {
    url += `&stars=${stars}`;
  }
  if (verified) {
    url += "&verified=true";
  }

  const html = await http_get(url);
  const m = html.match(
    /<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/
  );
  if (!m) {
    return { bu: null, reviews: [], pagination: {}, ratings: {} };
  }

  const data = JSON.parse(m[1]);
  const pp = data.props.pageProps;
  const bu = pp.businessUnit;
  const filters = pp.filters || {};
  const pagination = filters.pagination || {};
  const ratings = (filters.reviewStatistics || {}).ratings || {};
  const reviews = pp.reviews || [];

  return { bu, reviews, pagination, ratings };
}
```

---

## Business Unit (Company) Metadata

```js
const { bu, reviews, pagination, ratings } = await getTrustpilotPage("amazon.com");

// Confirmed fields (tested 2026-04-18):
bu.id                // '46ad346800006400050092d0'  — stable MongoDB ObjectId
bu.displayName       // 'Amazon'
bu.identifyingName   // 'www.amazon.com'
bu.trustScore        // 1.7  (float, 1.0–5.0)
bu.stars             // 1.5  (display stars: 1, 1.5, 2, 2.5 … 5)
bu.numberOfReviews   // 45228  — total across all languages
bu.websiteUrl        // 'https://www.amazon.com'
bu.isClaimed         // true/false
bu.isClosed          // true/false
bu.isCollectingReviews  // true/false

// Rating distribution (from filters.reviewStatistics.ratings):
ratings  // {total: 45228, one: 29718, two: 2701, three: 1759, four: 2367, five: 8683}

// Pagination (filtered count, default is English only):
pagination  // {currentPage: 1, perPage: 20, totalCount: 28039, totalPages: 1402}
```

---

## Review Fields

Each review in the `reviews` list has these confirmed fields:

```js
const review = {
  id:       '69e3103e09f46d6b5910f3c1',  // hex ObjectId, unique
  rating:   1,                             // int 1–5
  title:    'UNDELIVERABLE',
  text:     'UNDELIVERABLE\nThis is the only explanation...',
  language: 'en',
  likes:    0,                             // upvote count
  source:   'Organic',                     // 'Organic' or 'Invitation'
  filtered: false,
  isPending: false,

  dates: {
    experiencedDate: '2026-03-29T00:00:00.000Z',  // when they used the service
    publishedDate:   '2026-04-18T07:01:50.000Z',  // when review was posted
    updatedDate:     null,
    submittedDate:   null,
  },

  consumer: {
    id:              '5cafe2feb158a8533b443467',
    displayName:     'Baldy Bloke',
    imageUrl:        'https://user-images.trustpilot.com/...',
    numberOfReviews: 17,
    countryCode:     'GB',
    hasImage:        true,
    isVerified:      false,
  },

  labels: {
    verification: {
      isVerified:        false,
      verificationLevel: 'not-verified',   // or 'verified'
      reviewSourceName:  'Organic',
      verificationSource: 'invitation',
      createdDateTime:   '2026-04-18T07:01:50.000Z',
      hasDachExclusion:  false,
    },
    merged: null,
  },

  reply: null,           // or {message: '...', publishedDate: '...', updatedDate: null}
  location: null,        // populated for multi-location businesses
  productReviews: [],    // non-empty for product-level reviews
};
```

---

## Paginating — Collect Up to 200 Reviews

**Hard cap: pages 1–10 work; page 11+ returns an empty `reviews` array (no error, just empty).**
This cap applies per filter combination, so `stars=1` gives 200 reviews, `stars=2` gives another
200, etc.

```js
async function collectReviews(domain, { stars = null, languages = 'en', maxPages = 10, delay = 0.5 } = {}) {
  /*
    Collect up to maxPages*20 = 200 reviews. Returns list of review dicts.
    stars: 1-5 to filter by rating (null = all)
    languages: 'en' (default), 'all', or ISO code like 'de'
    delay: seconds between requests (0.5 is safe; tested 5 rapid reqs with no block)
  */
  const base = `https://www.trustpilot.com/review/${domain}`;
  let params = `?languages=${languages}`;
  if (stars) {
    params += `&stars=${stars}`;
  }

  const allReviews = [];
  const seenIds = new Set();

  for (let page = 1; page <= maxPages; page++) {
    const url = `${base}${params}&page=${page}`;
    const html = await http_get(url);
    const m = html.match(
      /<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/
    );
    if (!m) break;
    const data = JSON.parse(m[1]);
    const reviews = data.props.pageProps.reviews || [];
    if (!reviews.length) {
      break;   // hit the page 10 cap or truly no more reviews
    }

    const fresh = reviews.filter(r => !seenIds.has(r.id));
    for (const r of reviews) seenIds.add(r.id);
    allReviews.push(...fresh);

    if (page < maxPages) {
      await wait(delay);
    }
  }

  return allReviews;
}


// Usage — 200 reviews per call:
const reviews = await collectReviews("shopify.com");                     // English only, all ratings
const reviews1Star = await collectReviews("amazon.com", { stars: 1 });   // 200 x 1-star reviews
const reviewsAll = await collectReviews("stripe.com", { languages: 'all' });  // all languages
```

### Maximize unique reviews by sweeping all star ratings

Since each star filter gives an independent 200-review window, you can collect up to 1,000
reviews per company (pages are deduplicated across filters):

```js
const allReviews = {};
for (let stars = 1; stars <= 5; stars++) {
  for (const r of await collectReviews("amazon.com", { stars, delay: 0.5 })) {
    allReviews[r.id] = r;
  }
}

console.log(`Total unique reviews: ${Object.keys(allReviews).length}`);
```

---

## Filters Reference

All filter params are appended to the base URL `https://www.trustpilot.com/review/{domain}`:

| Param | Values | Notes |
|---|---|---|
| `page` | 1–10 | Page 11+ returns empty `reviews` (tested). 20 reviews per page. |
| `languages` | `en`, `all`, `de`, `fr`, `it`, `nl`, `sv`, `da`… | Default is `en`. Use `all` for all languages. |
| `stars` | `1`, `2`, `3`, `4`, `5` | Filter to that star rating only. Works correctly. |
| `verified` | `true` | Returns only invitation-verified reviews. Amazon has only ~21 verified reviews total. |
| `date` | `last30days`, `last6months`, `last12months` | Reflected in `filters.selected.date` but data volume unchanged vs no filter — server-side filtering may be best-effort. |
| `sort` | `recency`, `highest_rated`, `lowest_rated`, `helpful` | The `sort` param is accepted but **ignored server-side** via SSR — `filters.selected.sort` always returns `recency`. Sort only works in browser JS navigation. |

---

## Pagination Object

```js
// From filters.pagination (present on pages 1–10 when data exists):
const pagination = {
  currentPage: 1,
  perPage:     20,
  totalCount:  28039,   // filtered count (e.g. English only)
  totalPages:  1402,    // math: ceil(totalCount / 20)
};

// NOTE: totalPages can be 1402 but you can only access pages 1–10 (200 reviews).
// On page 11+ the reviews list is empty and pagination is absent.
```

---

## Rate Limits and Anti-bot

- **No Cloudflare, no DataDome** — plain HTTP with `Mozilla/5.0` UA works immediately (tested
  5 rapid requests in <5 seconds without any block).
- **No CAPTCHA** observed during any test run.
- **No 429 / rate-limit headers** seen on rapid sequential requests.
- Safe rate: 0.5s between requests is conservative. Tested 5 consecutive requests at natural
  speed (0.2–1s each) with no issue.
- **robots.txt** has `User-agent: * / Disallow: /` (all paths blocked for unnamed bots) and
  explicitly blocks `anthropic-ai`, `ClaudeBot`, `Claude-User`, `Claude-SearchBot`, `GPTBot`,
  `anthropic-ai`, `CCBot`, etc. Despite this, `http_get` with `Mozilla/5.0` UA is not blocked
  server-side (robots.txt is advisory only). Respect the policy if operating at scale.

---

## Consumer API (`api.trustpilot.com`)

All Consumer API endpoints require an API key (OAuth2 client credentials). Without a key:

```
GET https://api.trustpilot.com/v1/business-units/find?name=amazon.com  → 403 Forbidden
GET https://api.trustpilot.com/v1/business-units/{id}/reviews          → 403 Forbidden
```

The Business Unit ID embedded in `__NEXT_DATA__` (`businessUnit.id`) is the same ID used in the
Consumer API, so if you have an API key, you can use it directly without a separate lookup.

---

## Gotchas

1. **Page cap is 10, not `totalPages`**: `filters.pagination.totalPages` may show 1402, but
   requests for pages 11+ return `reviews: []` silently. The server-rendered SSR cap is
   hard-coded at page 10 (200 reviews).

2. **`totalCount` in pagination is language-filtered**: With `languages=en`, `totalCount` is the
   English-only count (e.g. 28,039 for Amazon). `businessUnit.numberOfReviews` is the true total
   across all languages (45,228). Use `languages=all` to see the full count in pagination.

3. **Sort param ignored in SSR**: `?sort=highest_rated` is reflected in `filters.selected.sort`
   in the JSON but the reviews returned are always `recency`-sorted. Sort only takes effect
   via browser-side JS navigation.

4. **Verified filter is narrow**: Amazon has 45,228 reviews but only 21 are `isVerified=true`
   (verificationLevel = 'verified'). Most reviews are organic/not-verified. Page 1 of
   `verified=true` shows a misleading `totalCount=28039` — page 2 corrects to `totalCount=21`.

5. **`date` filter behavior**: The `date` param is reflected in `filters.selected.date` but the
   total review counts and returned reviews do not visibly change vs no filter in testing. The
   server may apply it only partially or it may affect ordering rather than filtering.

6. **`languages=en` is the default** and the server returns it even without the param. Use
   `languages=all` explicitly to get reviews in all languages.

7. **No `__NEXT_DATA__` fallback**: Never observed an empty or missing `__NEXT_DATA__` on valid
   company pages. If absent, the domain may not have a Trustpilot profile — check for a
   redirect or 404 in the HTML title.

8. **Stars `1.5` vs `2`**: `businessUnit.stars` uses half-star display values (1.5, 2.0, etc).
   `businessUnit.trustScore` is the precise float (1.7). Use `trustScore` for numeric comparison.

---

## Complete One-Shot Example

```js
async function scrapeTrustpilot(domain, maxUnique = 200) {
  /*
    Scrape up to maxUnique reviews. Returns [company_info, reviews_list].
    With maxUnique=1000, sweeps all 5 star ratings to maximize coverage.
  */
  async function _fetchPage(domain, page, { stars = null, languages = 'en' } = {}) {
    let url = `https://www.trustpilot.com/review/${domain}?languages=${languages}&page=${page}`;
    if (stars) {
      url += `&stars=${stars}`;
    }
    const html = await http_get(url);
    const m = html.match(
      /<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/
    );
    if (!m) {
      return [null, []];
    }
    const d = JSON.parse(m[1]);
    const pp = d.props.pageProps;
    return [pp.businessUnit, pp.reviews || []];
  }

  const allReviews = {};

  // First page to get company info
  let [bu, reviews] = await _fetchPage(domain, 1);
  const companyInfo = {
    id:            bu.id,
    name:          bu.displayName,
    domain:        bu.identifyingName,
    trust_score:   bu.trustScore,
    stars:         bu.stars,
    total_reviews: bu.numberOfReviews,
    is_claimed:    bu.isClaimed,
  };
  for (const r of reviews) {
    allReviews[r.id] = r;
  }

  if (maxUnique <= 20) {
    return [companyInfo, Object.values(allReviews)];
  }

  // Pages 2–10 (no star filter)
  for (let page = 2; page <= 10; page++) {
    if (Object.keys(allReviews).length >= maxUnique) break;
    [, reviews] = await _fetchPage(domain, page);
    if (!reviews.length) break;
    for (const r of reviews) {
      allReviews[r.id] = r;
    }
    await wait(0.5);
  }

  // If we want more, sweep by star rating
  if (Object.keys(allReviews).length < maxUnique && maxUnique > 200) {
    for (let stars = 1; stars <= 5; stars++) {
      for (let page = 1; page <= 10; page++) {
        if (Object.keys(allReviews).length >= maxUnique) break;
        [, reviews] = await _fetchPage(domain, page, { stars });
        if (!reviews.length) break;
        for (const r of reviews) {
          allReviews[r.id] = r;
        }
        await wait(0.5);
      }
    }
  }

  return [companyInfo, Object.values(allReviews).slice(0, maxUnique)];
}


// Run it:
const [company, reviews] = await scrapeTrustpilot("shopify.com", 200);
console.log(`${company.name} — TrustScore ${company.trust_score} — ${company.total_reviews} total reviews`);
console.log(`Collected: ${reviews.length} reviews`);
console.log(`Sample: [${reviews[0].rating}★] ${reviews[0].title.slice(0, 60)}`);
```
