# NASA APIs — Scraping & Data Extraction

`https://api.nasa.gov` — open NASA data APIs. **Never use the browser.** All endpoints return JSON via `http_get`. DEMO_KEY works for low-volume use; register for a free personal key at https://api.nasa.gov/ to raise limits.

## Do this first

**All `api.nasa.gov` endpoints share the same rate-limit pool under DEMO_KEY. EPIC and Exoplanet Archive are on separate domains with no rate limit.**

```js
// Simplest call: today's Astronomy Picture of the Day
const apod = JSON.parse(await http_get("https://api.nasa.gov/planetary/apod?api_key=DEMO_KEY"));
console.log(apod.date, apod.title, apod.media_type);
// Confirmed output (2026-04-18): 2026-04-18 PanSTARRS and Planets image
```

Use DEMO_KEY for exploration. Switch to a personal key for any bulk work — DEMO_KEY hits its limit at ~10 req/hour/IP.

## Rate limits

| Key type | Limit | Resets |
|---|---|---|
| `DEMO_KEY` | 10 req/hour, ~50/day per IP | Hourly window; daily hard stop with `retry-after` ~22h |
| Personal key (free) | 1,000 req/hour | Hourly window |

Rate limit headers on every `api.nasa.gov` response:
- `X-Ratelimit-Limit`, `X-Ratelimit-Remaining`, `Retry-After`

**EPIC (`epic.gsfc.nasa.gov`) and Exoplanet Archive (`exoplanetarchive.ipac.caltech.edu`) share no rate-limit pool with `api.nasa.gov`.**

## Common workflows

### APOD — single day

```js
const apod = JSON.parse(await http_get("https://api.nasa.gov/planetary/apod?api_key=DEMO_KEY"));
console.log(apod.date);        // '2026-04-18'
console.log(apod.title);       // 'PanSTARRS and Planets'
console.log(apod.media_type);  // 'image' or 'video'
console.log(apod.url);         // full-res or YouTube embed URL
console.log(apod.hdurl);       // HD image URL (absent when media_type='video')
console.log(apod.copyright);   // undefined if public domain
```

### APOD — date range (array response)

```js
const apods = JSON.parse(await http_get(
  "https://api.nasa.gov/planetary/apod"
  + "?start_date=2024-01-01&end_date=2024-01-07&api_key=DEMO_KEY"
));
for (const a of apods) {
  console.log(a.date, a.media_type, a.title.slice(0, 50));
}
```

Optional params: `date=YYYY-MM-DD` (specific day), `count=N` (N random entries), `thumbs=true` (include `thumbnail_url` for video entries).

### APOD — random sample

```js
const apods = JSON.parse(await http_get(
  "https://api.nasa.gov/planetary/apod?count=5&api_key=DEMO_KEY"
));
for (const a of apods) console.log(a.date, a.title.slice(0, 40));
```

### NEO — Near Earth Objects feed

```js
const data = JSON.parse(await http_get(
  "https://api.nasa.gov/neo/rest/v1/feed"
  + "?start_date=2024-01-01&end_date=2024-01-02&api_key=DEMO_KEY"
));
console.log(data.element_count);   // 32
const neos = data.near_earth_objects;  // object keyed by date string
for (const [date, objects] of Object.entries(neos).sort()) {
  for (const neo of objects) {
    const ca = neo.close_approach_data[0];
    console.log(
      neo.name,
      "hazardous:", neo.is_potentially_hazardous_asteroid,
      "miss km:", ca.miss_distance.kilometers.slice(0, 12),
      "vel kph:", ca.relative_velocity.kilometers_per_hour.slice(0, 10)
    );
  }
}
```

NEO object fields:
- `id`, `name`, `nasa_jpl_url` — identity
- `estimated_diameter` — object with `kilometers`, `meters`, `miles`, `feet` sub-objects, each with `min`/`max`
- `is_potentially_hazardous_asteroid` — bool
- `close_approach_data[0]` — `close_approach_date`, `miss_distance` (au/lunar/km/mi), `relative_velocity` (km/s, km/h, mph), `orbiting_body`

Date range is capped at **7 days per request**. Paginate with `start_date` / `end_date` in 7-day steps. `links.next` in the response gives the next 7-day window URL.

### NEO — single asteroid lookup

```js
const neo = JSON.parse(await http_get(
  "https://api.nasa.gov/neo/rest/v1/neo/2415949?api_key=DEMO_KEY"
));
console.log(neo.name);
console.log(neo.orbital_data.orbit_class.orbit_class_description);
```

### Mars Rover photos — Curiosity by sol

```js
// sol = Martian solar day since landing
const data = JSON.parse(await http_get(
  "https://api.nasa.gov/mars-photos/api/v1/rovers/curiosity/photos"
  + "?sol=1000&api_key=DEMO_KEY"
));
const photos = data.photos;
console.log(`Photos on sol 1000: ${photos.length}`);
const p = photos[0];
console.log(p.earth_date);
console.log(p.img_src);
console.log(p.camera.name, p.camera.full_name);
console.log(p.rover.name, p.rover.status, p.rover.max_sol);

// Filter by camera
const nav = JSON.parse(await http_get(
  "https://api.nasa.gov/mars-photos/api/v1/rovers/curiosity/photos"
  + "?sol=1000&camera=navcam&api_key=DEMO_KEY"
));
```

Available cameras for Curiosity: `fhaz`, `rhaz`, `mast`, `chemcam`, `mahli`, `mardi`, `navcam`. Other rovers: `opportunity`, `spirit`, `perseverance`.

Use `latest_photos` to get the most recent available. Add `&page=N` for pagination (25 photos/page).

### EPIC — Earth Polychromatic Imaging Camera

EPIC images are served from `epic.gsfc.nasa.gov` — **no `api_key` required, no rate limit.**

```js
// Latest available images (natural color)
const images = JSON.parse(await http_get("https://epic.gsfc.nasa.gov/api/natural"));
console.log(`Latest batch: ${images.length} images`);

const img = images[0];
console.log(img.identifier);               // '20260416162050'
console.log(img.image);                    // 'epic_1b_20260416162050'
console.log(img.date);                     // '2026-04-16 16:16:01'
console.log(img.centroid_coordinates);     // {lat: 13.25, lon: -75.59}

// Construct PNG URL from image name + date
const [year, month, day] = img.date.split(" ")[0].split("-");
const png_url = `https://epic.gsfc.nasa.gov/archive/natural/${year}/${month}/${day}/png/${img.image}.png`;
const jpg_thumb = `https://epic.gsfc.nasa.gov/archive/natural/${year}/${month}/${day}/thumbs/${img.image}.jpg`;
```

```js
// Images for a specific date
const by_date = JSON.parse(await http_get("https://epic.gsfc.nasa.gov/api/natural/date/2024-01-15"));

// Enhanced (color-corrected) images
const enhanced = JSON.parse(await http_get("https://epic.gsfc.nasa.gov/api/enhanced/date/2024-01-15"));
const e = enhanced[0];
const [y, m, d] = e.date.split(" ")[0].split("-");
const enhanced_url = `https://epic.gsfc.nasa.gov/archive/enhanced/${y}/${m}/${d}/png/${e.image}.png`;

// All available dates
const all_dates = JSON.parse(await http_get("https://epic.gsfc.nasa.gov/api/natural/all"));
console.log(`Available dates: ${all_dates.length}`);  // 3477 dates
console.log(all_dates[0]);              // {date: '2026-04-16'}  (newest first)
console.log(all_dates.at(-1));          // {date: '2015-06-13'}  (oldest)
```

### Exoplanet Archive — TAP/ADQL queries

No API key or rate limit. SQL-like ADQL queries over the full archive.

```js
// Short-period planets with known radii
const planets = JSON.parse(await http_get(
  "https://exoplanetarchive.ipac.caltech.edu/TAP/sync"
  + "?query=select+pl_name,hostname,pl_orbper+from+ps+where+pl_orbper+%3C+10"
  + "&format=json"
));
console.log(`Rows: ${planets.length}`);      // 17675
console.log(planets[0]);
// {pl_name: 'GJ 1214 b', hostname: 'GJ 1214', pl_orbper: 1.58040482}
```

```js
// Use 'pscomppars' for one row per planet (composite best-estimate params)
const planets = JSON.parse(await http_get(
  "https://exoplanetarchive.ipac.caltech.edu/TAP/sync"
  + "?query=select+pl_name,hostname,disc_year,discoverymethod,pl_orbper,pl_rade,pl_masse,pl_eqt,sy_dist"
  + "+from+pscomppars+where+disc_year+%3E+2020+and+pl_rade+is+not+null"
  + "+order+by+disc_year+desc"
  + "&format=json&maxrec=5"
));
for (const p of planets) {
  console.log(p.pl_name, p.disc_year, p.discoverymethod, `r=${p.pl_rade}Re`);
}
```

Key tables:
- `ps` — all measurements per planet (multiple rows per planet, all sources)
- `pscomppars` — one row per confirmed planet (best composite parameters)

URL-encode operators: `<` = `%3C`, `>` = `%3E`, spaces = `+`.

## URL reference

### api.nasa.gov endpoints

| Endpoint | URL pattern |
|---|---|
| APOD today | `https://api.nasa.gov/planetary/apod?api_key=KEY` |
| APOD by date | `...&date=YYYY-MM-DD` |
| APOD range | `...&start_date=YYYY-MM-DD&end_date=YYYY-MM-DD` |
| APOD random N | `...&count=N` |
| NEO feed | `https://api.nasa.gov/neo/rest/v1/feed?start_date=...&end_date=...&api_key=KEY` |
| NEO by ID | `https://api.nasa.gov/neo/rest/v1/neo/{id}?api_key=KEY` |
| Mars photos by sol | `https://api.nasa.gov/mars-photos/api/v1/rovers/{rover}/photos?sol=N&api_key=KEY` |
| Mars photos by date | `...?earth_date=YYYY-MM-DD&api_key=KEY` |
| Mars latest | `https://api.nasa.gov/mars-photos/api/v1/rovers/{rover}/latest_photos?api_key=KEY` |

### EPIC (no key, no rate limit)

| Endpoint | URL |
|---|---|
| Latest natural images | `https://epic.gsfc.nasa.gov/api/natural` |
| Natural by date | `https://epic.gsfc.nasa.gov/api/natural/date/YYYY-MM-DD` |
| Enhanced latest | `https://epic.gsfc.nasa.gov/api/enhanced` |
| Enhanced by date | `https://epic.gsfc.nasa.gov/api/enhanced/date/YYYY-MM-DD` |
| All available dates | `https://epic.gsfc.nasa.gov/api/natural/all` |
| PNG image | `https://epic.gsfc.nasa.gov/archive/natural/YYYY/MM/DD/png/{image}.png` |
| Enhanced PNG | `https://epic.gsfc.nasa.gov/archive/enhanced/YYYY/MM/DD/png/{image}.png` |

### Exoplanet Archive (no key, no rate limit)

```
https://exoplanetarchive.ipac.caltech.edu/TAP/sync?query=<ADQL>&format=json&maxrec=<N>
```

## Gotchas

- **DEMO_KEY limit is effectively 10/hour per IP, not 30.** When the daily budget (~50 req) is exhausted, `retry-after` is set to ~22h. Register a personal key for 1,000/hour.

- **All `api.nasa.gov` paths share one rate-limit pool** — APOD, NEO, Mars Rover all draw from the same DEMO_KEY bucket.

- **EPIC and Exoplanet Archive are fully free** — no rate-limit headers, not throttled.

- **NEO date range max is 7 days** — Requests spanning more than 7 days return HTTP 400. Paginate with 7-day windows.

- **APOD earliest date is 1995-06-16** — Requesting `date` before this returns HTTP 400.

- **APOD `hdurl` is absent for video entries** — When `media_type` is `video`, the response has `url` but no `hdurl`.

- **Mars Rover `sol` vs `earth_date`** — Both valid filter params. Cannot mix in one request.

- **Mars Rover pagination defaults to 25 photos/page** — Use `&page=2`, `&page=3`, etc. No total count in response.

- **EPIC image name encodes type in the prefix** — Natural images use `epic_1b_`; enhanced use `epic_RGB_`. The API returns the correct filename in `img.image`.

- **EPIC `/api/natural/all` returns newest-first** — The list starts from today and goes back to 2015-06-13. Not all days have images.

- **Exoplanet `ps` table has multiple rows per planet** — Use `pscomppars` for one-row-per-planet composite parameters.

- **Exoplanet null values come back as `null` in JSON** — Many fields like `pl_masse` are null for planets without mass measurements. Guard with `if (row.pl_masse != null)`.
