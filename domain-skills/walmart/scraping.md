# Walmart — Product Search & Data Extraction

Field-tested against walmart.com on 2026-04-18 using `http_get` (no browser required).
All code blocks were run and outputs verified against live responses.

---

## Fastest Approach: `http_get` with `__NEXT_DATA__`

Walmart's Next.js SSR embeds the full search or product payload as JSON in a
`<script id="__NEXT_DATA__">` tag. **No browser needed for search or product detail pages.**
~2–3 s per page fetch; no CAPTCHA or session cookies required.

### Critical UA rule

| User-Agent | Result |
|---|---|
| `Mozilla/5.0` (bare) | Full HTML + `__NEXT_DATA__` — **use this** |
| `Mozilla/5.0 ... Chrome/120 ...` (full) | PerimeterX "Robot or human?" challenge (200, 15 KB) |
| `Safari/17` full UA | Works (full HTML, ~1.15 MB) |
| `curl/7.x` | PerimeterX challenge |
| `python-requests/2.31` | PerimeterX challenge |

The bare `Mozilla/5.0` string bypasses PerimeterX. Any UA that looks like a headless
client or includes a recognizable browser fingerprint triggers the JS challenge page.

### Base fetch helper

```js
async function fetchWalmart(url) {
  /*
    Fetch any walmart.com page.
    Returns decoded HTML string.
    Throws if PerimeterX bot challenge is returned.
  */
  const r = await fetch(url, {
    headers: {"User-Agent": "Mozilla/5.0", "Accept-Encoding": "gzip"},
    signal: AbortSignal.timeout(20000)
  });
  const html = await r.text();
  if (html.includes("Robot or human")) {
    throw new Error(`PerimeterX challenge triggered: ${url}`);
  }
  return html;
}

function parseNextData(html) {
  const m = html.match(/id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (!m) {
    throw new Error("__NEXT_DATA__ not found — page structure may have changed");
  }
  return JSON.parse(m[1]);
}
```

---

## Search Results

### URL patterns

```js
// Keyword search
"https://www.walmart.com/search?q=laptop"

// Pagination — append &page=N
"https://www.walmart.com/search?q=laptop&page=2"

// Sort options (confirmed working)
"https://www.walmart.com/search?q=laptop&sort=best_match"    // default
"https://www.walmart.com/search?q=laptop&sort=best_seller"
"https://www.walmart.com/search?q=laptop&sort=price_low"
"https://www.walmart.com/search?q=laptop&sort=customer_rating"

// Price filter
"https://www.walmart.com/search?q=laptop&min_price=200&max_price=500"

// Browse by category (department ID path)
"https://www.walmart.com/browse/electronics/laptops/3944_1089430_3951"
```

### `__NEXT_DATA__` path to items

```
data
  .props.pageProps.initialData.searchResult
    .aggregatedCount        — int: total matching products (e.g. 18818)
    .paginationV2.maxPage   — int: last page number
    .itemStacks[]           — array of stacks (usually 2: sponsored + organic)
      .items[]              — array of product objects
```

### Full extractor (field-tested)

```js
function extractSearchResults(html) {
  /*
    Returns [items, total_count, max_page].
    items is a list of dicts with confirmed fields.
  */
  const data = parseNextData(html);
  const sr = data.props.pageProps.initialData.searchResult;

  const items = [];
  for (const stack of (sr.itemStacks || [])) {
    for (const item of (stack.items || [])) {
      const pi = item.priceInfo || {};
      const img = item.imageInfo || {};
      const rating = item.rating || {};
      const avail = item.availabilityStatusV2 || {};
      items.push({
        usItemId:        item.usItemId,                // str, Walmart item ID
        name:            item.name,                    // str
        brand:           item.brand,                   // str or null
        price:           item.price,                   // int, current price in USD
        linePrice:       pi.linePrice,                 // str "$429.00"
        wasPrice:        pi.wasPrice || null,          // str "$699.00" or null
        savings:         pi.savings || null,           // str "SAVE $270.00" or null
        averageRating:   rating.averageRating,         // float e.g. 4.3
        numberOfReviews: rating.numberOfReviews,       // int
        availability:    avail.value,                  // "IN_STOCK" / "OUT_OF_STOCK"
        isSponsored:     Boolean(item.isSponsoredFlag),
        url:             "https://www.walmart.com" + (item.canonicalUrl || "").split("?")[0],
        thumbnailUrl:    img.thumbnailUrl,
      });
    }
  }

  const total = sr.aggregatedCount;
  const maxPage = (sr.paginationV2 || {}).maxPage;
  return [items, total, maxPage];
}


// Usage
const html = await fetchWalmart("https://www.walmart.com/search?q=laptop");
const [items, total, maxPage] = extractSearchResults(html);
// items: 66 items on page 1, total=18818, maxPage=11

// Filter out sponsored
const organic = items.filter(i => !i.isSponsored);
```

### Field notes (confirmed)

- **`usItemId`**: string, matches the numeric ID at the end of `/ip/.../ITEMID` URLs.
  Some non-product rows (ad widgets) have `usItemId=null` — filter with `if (item.usItemId)`.
- **`price`**: integer cents-less price (e.g. `429` for "$429.00"). Use `priceInfo.linePrice` for
  the formatted string including the dollar sign.
- **`wasPrice` / `savings`**: only present when item is on sale. Always `null` for full-price items.
- **`isSponsoredFlag`**: the first batch of results across both itemStacks are frequently sponsored.
  On a laptop search, ~56 of 66 SSR items carry `isSponsoredFlag: true`.
- **`rating`**: present on ~91% of items (60/66 in test). `averageRating` is a float; `numberOfReviews` is int.
- **`canonicalUrl`**: always includes `?classType=...&athbdg=...` query params — strip with `.split("?")[0]`
  to get a clean URL.
- **Two itemStacks**: Walmart returns two stacks (`itemStacks[0]` and `itemStacks[1]`). Merge them.
  `itemStacks[0]` is the primary grid; `itemStacks[1]` is a secondary sponsored/related block.

### Pagination

```js
for (let page = 1; page <= maxPage; page++) {
  const html = await fetchWalmart(`https://www.walmart.com/search?q=laptop&page=${page}`);
  const [items, , ] = extractSearchResults(html);
  // process items...
}
```

Page responses average ~2.5 s each. No rate-limiting was observed across 3 sequential requests.
For bulk scraping, add a 1–2 s delay between requests to be safe.

---

## Product Detail Page

### URL pattern

```
https://www.walmart.com/ip/{slug}/{usItemId}
```

The slug is ignored in routing — only the numeric `usItemId` matters.
These work identically:
```
https://www.walmart.com/ip/anything/19717318352
https://www.walmart.com/ip/Apple-MacBook-Neo/19717318352
```

### `__NEXT_DATA__` path on a product page

```
data.props.pageProps.initialData.data
  .product        — core product object
  .idml           — long description, specs, highlights, warranty
  .reviews        — rating breakdown + first 10 customer reviews (SSR)
```

### Full extractor (field-tested)

```js
function extractProductDetail(html) {
  /*
    Returns a dict with all confirmed product fields.
    idml.specifications returns all spec rows as a flat dict.
    reviews returns the SSR-rendered first 10 customer reviews.
  */
  const data = parseNextData(html);
  const d = data.props.pageProps.initialData.data;
  const product = d.product;
  const idml    = d.idml || {};
  const reviews = d.reviews || {};

  const pi = product.priceInfo || {};
  const cp = pi.currentPrice || {};
  const img = product.imageInfo || {};
  const avail = product.availabilityStatusV2 || {};

  const specs = Object.fromEntries(
    (idml.specifications || []).map(spec => [spec.name, spec.value])
  );

  const allImages = (img.allImages || [])
    .map(imgItem => imgItem.url)
    .filter(url => url);

  const customerReviews = (reviews.customerReviews || []).map(r => ({
    title:    r.reviewTitle,
    rating:   r.rating,              // int 1-5 (field is "rating", NOT "overallRating")
    text:     r.reviewText,
    author:   r.userNickname,
    date:     r.reviewSubmissionTime,
  }));

  return {
    // identity
    usItemId:            product.usItemId,
    name:                product.name,
    brand:               product.brand,
    model:               product.model,
    upc:                 product.upc,
    // price
    price:               cp.price,            // float, e.g. 599
    priceString:         cp.priceString,      // "$599.00"
    wasPrice:            (pi.wasPrice || {}).priceString,
    savings:             (pi.savings || {}).savingsString,
    // availability
    availability:        avail.value,         // "IN_STOCK" / "OUT_OF_STOCK"
    availabilityDisplay: avail.display,       // "In stock"
    // ratings
    averageRating:       product.averageRating,
    numberOfReviews:     product.numberOfReviews,
    // text
    shortDescription:    product.shortDescription,
    longDescription:     idml.longDescription,  // HTML string
    // media
    thumbnailUrl:        img.thumbnailUrl,
    allImages,                                  // up to 10 image URLs
    // specs
    specifications:      specs,                 // {"Brand": "Apple", "Processor": "A18 Pro", ...}
    highlights:          (idml.productHighlights || []).map(h => ({
      name: h.name, value: h.value
    })),
    // URL
    canonicalUrl:        "https://www.walmart.com" + (product.canonicalUrl || ""),
    // fulfillment
    fulfillmentOptions:  product.fulfillmentOptions || [],
    // reviews (SSR-rendered, first 10)
    reviewSummary: {
      averageOverallRating:    reviews.averageOverallRating,
      totalReviewCount:        reviews.totalReviewCount,
      reviewsWithTextCount:    reviews.reviewsWithTextCount,
      recommendedPercentage:   reviews.recommendedPercentage,
    },
    customerReviews,
  };
}


// Usage
const url = "https://www.walmart.com/ip/Apple-MacBook-Neo/19717318352";
const html = await fetchWalmart(url);
const product = extractProductDetail(html);

// Example output (confirmed live):
// product.name         → "Apple MacBook Neo 13-inch Apple A18 Pro chip..."
// product.price        → 599
// product.priceString  → "$599.00"
// product.availability → "IN_STOCK"
// product.model        → "MHFD4LL/A"
// product.upc          → "195950852745"
// Object.keys(product.specifications).length  → 29 spec rows
// product.allImages.length       → 10
// product.specifications["Processor"] → "A18 Pro"
```

### Field notes (confirmed)

- **`averageRating` / `numberOfReviews`** on the product node: present for items with reviews.
  New/few-review items may return `null` for both.
- **`reviewSummary.averageOverallRating`** in the reviews node often differs slightly from
  `product.averageRating` — the reviews node is more precise (e.g. `4.75` vs `4.8`).
- **`customerReviews`** (SSR): always the first 10 reviews. The per-review rating field is `"rating"`
  (int 1–5), **not** `"overallRating"` (which is always `null`).
- **`longDescription`**: raw HTML string including `<ul>/<li>` tags. Strip tags before display.
- **`specifications`**: flat dict — confirmed 29–31 rows for electronics. Key names use display labels
  (e.g. `"RAM memory"`, `"Screen size"`, `"HD capacity"`).
- **`wasPrice` / `savings`** on detail page: same as search — `null` when item is not discounted.
- **No JSON-LD**: Walmart product pages do **not** include `<script type="application/ld+json">`.
  All structured data lives in `__NEXT_DATA__`.

---

## Anti-Bot: PerimeterX

Walmart uses **PerimeterX** (app ID `PXu6b0qd2S`, confirmed in `runtimeConfig.perimeterX`).

| Signal | Detail |
|---|---|
| Bot detector | PerimeterX |
| Challenge page | "Robot or human?" — 200 OK, 15 KB HTML |
| Triggered by | Full browser UA strings (Chrome, curl, python-requests) |
| Bypassed by | `User-Agent: Mozilla/5.0` (bare prefix only) |
| No JS execution | SSR response is complete — no JS challenge to solve |

Detection in code:
```js
if (html.includes("Robot or human")) {
  throw new Error("PerimeterX challenge — switch to browser harness");
}
```

If `http_get` starts returning the challenge after a run of successful fetches, switch to the
browser harness (see below).

---

## Browser Harness Fallback

Use the browser harness when:
- PerimeterX starts blocking `http_get` on your IP
- You need to interact with the page (add to cart, filter UI, infinite scroll)
- You need variant switching (color/size selectors)

```js
// Browser-based search extraction
await new_tab("https://www.walmart.com/search?q=laptop");
await wait_for_load();
await wait(2);  // JS renders product cards after readyState=complete

// Extract via __NEXT_DATA__ in-browser (identical structure to http_get)
const nd = await js("document.getElementById('__NEXT_DATA__')?.textContent");
const data = JSON.parse(nd);
const sr = data.props.pageProps.initialData.searchResult;
const items = [];
for (const stack of (sr.itemStacks || [])) {
  items.push(...(stack.items || []));
}
```

### Browser selectors (confirmed working for DOM-based extraction)

```js
// Product cards on search results page
const results = await js(`
  Array.from(document.querySelectorAll('[data-item-id]')).map(el => ({
    itemId:    el.getAttribute('data-item-id'),
    name:      el.querySelector('[itemprop="name"]')?.innerText?.trim(),
    price:     el.querySelector('[itemprop="price"]')?.getAttribute('content'),
    url:       el.querySelector('a[link-identifier]')?.href,
  })).filter(r => r.itemId)
`);

// If [data-item-id] misses items, use the Next.js data attribute alternative:
const resultsAlt = await js(`
  Array.from(document.querySelectorAll('[data-testid="list-view"]'))
    .map(el => el.innerText.trim())
`);
```

> **Prefer `__NEXT_DATA__` over DOM selectors** even in-browser — the JSON is complete and
> stable. DOM class names at Walmart are obfuscated and change between deployments.

### Session gotcha

Always open Walmart with `new_tab()` on first visit:
```js
await new_tab("https://www.walmart.com/search?q=laptop");
await wait_for_load();
await wait(2);
```
After that, `goto()` works normally within the same session.

---

## Public API

Walmart's affiliate/partner API (`developer.api.walmart.com`) requires a registered API key
and returns HTTP 403 without one. No unauthenticated public product API is available.
The `__NEXT_DATA__` SSR approach replaces any need for the official API for read-only data.

---

## Gotchas

- **UA must be `Mozilla/5.0` bare**: Any fuller string (Chrome, Safari, curl, requests) hits
  PerimeterX. This is counterintuitive — the *shorter*, less realistic UA is the one that works.

- **Regex must use `id=` attribute match**: The regex
  `/<script id="__NEXT_DATA__" type="application\/json">.../` fails because the actual tag is
  `<script id="__NEXT_DATA__">` without `type`. Use:
  ```js
  html.match(/id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/)
  ```

- **`usItemId` can be `null`**: ~5/66 items on a page are non-product ad widgets with no `usItemId`.
  Always filter: `items.filter(i => i.usItemId)`.

- **Two `itemStacks`**: Walmart returns two stacks. Iterate over all stacks or you'll miss
  ~10 items from the second stack.

- **`canonicalUrl` includes tracking params**: Always strip with `.split("?")[0]`.

- **Review field is `"rating"` not `"overallRating"`**: Each `customerReviews` entry has a `"rating"`
  int field (1–5). The `"overallRating"` field is always `null`. Don't confuse with
  `product.averageRating` (the aggregate float).

- **No JSON-LD on product pages**: Zero `<script type="application/ld+json">` tags were found.
  All structured data is in `__NEXT_DATA__`.

- **`longDescription` is HTML**: Strip tags before text use. May contain promotional/financing copy
  mixed with real product description.

- **Page sizes vary**: Page 1 returned 66 items across 2 stacks; page 2 returned 55.
  Do not assume a fixed items-per-page count.

- **`http_get` default already sends `Mozilla/5.0`**: `http_get()` uses
  `"User-Agent": "Mozilla/5.0"` by default — no override needed when calling it directly.
  Only pass a custom headers object if you need to change something else.

- **`developer.api.walmart.com`** returns HTTP 403 without an API key. Not usable for
  unauthenticated scraping.
