# Spotify — Data Extraction

Field-tested against open.spotify.com on 2026-04-18.
No authentication required for any approach documented here.

---

## Approach 1 (Fastest): oEmbed API — No Auth, No Browser

`https://open.spotify.com/oembed?url=<resource_url>`

Returns JSON in ~0.25s. Works for tracks, albums, playlists, and artists. Does **not** work for episodes/shows.

```js
async function spotifyOembed(resourceType, resourceId) {
    /* Fetch oEmbed metadata for a Spotify resource.

       resourceType: 'track', 'album', 'playlist', or 'artist'
       resourceId:   Spotify ID (22-char alphanumeric)
    */
    const resourceUrl = `https://open.spotify.com/${resourceType}/${resourceId}`;
    const url = `https://open.spotify.com/oembed?url=${resourceUrl}`;
    const data = JSON.parse(await http_get(url));
    return data;
}

// Example: track
const track = await spotifyOembed("track", "4PTG3Z6ehGkBFwjybzWkR8");
// {
//   title:           "Never Gonna Give You Up",
//   thumbnail_url:   "https://image-cdn-ak.spotifycdn.com/image/ab67616100005174...",
//   thumbnail_width: 320,
//   thumbnail_height: 320,
//   type:            "rich",
//   html:            "<iframe ...src=\"https://open.spotify.com/embed/track/4PTG3Z6...\"...>",
//   iframe_url:      "https://open.spotify.com/embed/track/4PTG3Z6ehGkBFwjybzWkR8?utm_source=oembed",
//   width:           456,
//   height:          152,
//   version:         "1.0",
//   provider_name:   "Spotify",
//   provider_url:    "https://spotify.com"
// }

// Artist (height is 352 — taller widget)
const artist = await spotifyOembed("artist", "0gxyHStUsqpMadRV0Di1Qt");
// title="Rick Astley", thumbnail_url=<artist photo URL>

// Album
const album = await spotifyOembed("album", "4LH4d3cOWNNsVw41Gqt2kv");
// title="The Dark Side of the Moon", thumbnail_url=<album art URL>

// Playlist
const pl = await spotifyOembed("playlist", "37i9dQZF1DXcBWIGoYBM5M");
// title="Today's Top Hits", thumbnail_url=<playlist cover URL>
```

### Bulk fetching (concurrent with Promise.all)

```js
const trackIds = [
    "4PTG3Z6ehGkBFwjybzWkR8",
    "7qiZfU4dY1lWllzX7mPBI3",
    "0VjIjW4GlUZAMYd2vXMi3b",
];

async function fetchOembed(tid) {
    const url = `https://open.spotify.com/oembed?url=https://open.spotify.com/track/${tid}`;
    try {
        return JSON.parse(await http_get(url));
    } catch (e) {
        return { error: String(e), id: tid };
    }
}

async function pMap(items, limit, fn) {
    const out = []; let i = 0;
    const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
        while (i < items.length) { const idx = i++; out[idx] = await fn(items[idx]); }
    });
    await Promise.all(workers); return out;
}

const results = await pMap(trackIds, 5, fetchOembed);
// 5 tracks: ~1.3s total, ~0.26s per track
```

---

## Approach 2: Static HTML — Rich Metadata via http_get

Every open.spotify.com page (track, album, playlist, artist) serves full HTML with no JS requirement. The HTML contains JSON-LD and Open Graph tags that provide structured data.

### Track page — all extractable fields

```js
async function scrapeTrack(trackId) {
    const url = `https://open.spotify.com/track/${trackId}`;
    const html = await http_get(url);

    // ---- JSON-LD (most structured) ----
    const ldRaw = html.match(/<script type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/);
    const ld = ldRaw ? JSON.parse(ldRaw[1]) : {};

    // ---- Open Graph / music: meta tags ----
    const metas = {};
    for (const m of html.matchAll(/<meta\s+(?:property|name)="([^"]+)"\s+content="([^"]*)"/g)) {
        const key = m[1], val = m[2];
        if (!(key in metas)) {
            metas[key] = val;
        }
    }

    const musicianUrls = [...html.matchAll(/<meta\s+(?:property|name)="music:musician"\s+content="([^"]*)"/g)].map(m => m[1]);
    const allowedCountries = [...html.matchAll(/<meta\s+property="og:restrictions:country:allowed"\s+content="([^"]*)"/g)].map(m => m[1]);

    return {
        title:            metas["og:title"],
        artist:           metas["music:musician_description"],
        artist_urls:      musicianUrls,               // spotify artist page URLs
        album_url:        metas["music:album"],       // spotify album page URL
        track_number:     metas["music:album:track"],
        duration_s:       parseInt(metas["music:duration"] ?? "0", 10),
        release_date:     metas["music:release_date"],  // YYYY-MM-DD
        cover_art:        metas["og:image"],          // 640px JPG
        audio_preview:    metas["og:audio"],          // 30s MP3 (may be undefined)
        spotify_url:      metas["og:url"],
        description:      metas["og:description"],
        eligible_regions: allowedCountries,
        ld_name:          ld.name,
        ld_date:          ld.datePublished,
    };
}

// Tested on track/4PTG3Z6ehGkBFwjybzWkR8 (Never Gonna Give You Up):
// {
//   title:         "Never Gonna Give You Up",
//   artist:        "Rick Astley",
//   artist_urls:   ["https://open.spotify.com/artist/0gxyHStUsqpMadRV0Di1Qt"],
//   album_url:     "https://open.spotify.com/album/6eUW0wxWtzkFdaEFsTJto6",
//   track_number:  "1",
//   duration_s:    214,
//   release_date:  "1987-11-12",
//   cover_art:     "https://i.scdn.co/image/ab67616d0000b27315ebbedaacef61af244262a8",
//   audio_preview: "https://p.scdn.co/mp3-preview/b4c682084c3fd05538726d0a126b7e14b6e92c83",
//   spotify_url:   "https://open.spotify.com/track/4PTG3Z6ehGkBFwjybzWkR8",
//   eligible_regions: [185 country codes],
// }
```

### Artist page — fields available

```js
async function scrapeArtist(artistId) {
    const url = `https://open.spotify.com/artist/${artistId}`;
    const html = await http_get(url);

    const ldRaw = html.match(/<script type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/);
    const ld = ldRaw ? JSON.parse(ldRaw[1]) : {};

    const metas = {};
    for (const m of html.matchAll(/<meta\s+(?:property|name)="([^"]+)"\s+content="([^"]*)"/g)) {
        if (!(m[1] in metas)) {
            metas[m[1]] = m[2];
        }
    }

    return {
        name:              metas["og:title"],
        monthly_listeners: metas["og:description"],  // "Artist · 6.7M monthly listeners."
        image:             metas["og:image"],        // full-size artist photo
        spotify_url:       metas["og:url"],
        description:       ld.description,
    };
}

// Tested on Rick Astley (artist/0gxyHStUsqpMadRV0Di1Qt):
// {
//   name:              "Rick Astley",
//   monthly_listeners: "Artist · 6.7M monthly listeners.",
//   image:             "https://i.scdn.co/image/ab6761610000e5ebe834a63a0cfa3c0f57a9a434",
// }
```

---

## Approach 3: Embed Page — Structured JSON with Track Lists

`https://open.spotify.com/embed/{type}/{id}` returns a small Next.js SSR page. Its `__NEXT_DATA__` script tag contains a fully-parsed entity object. This is the only no-auth route that returns track listings for albums, playlists, and artists.

```js
async function scrapeEmbed(resourceType, resourceId) {
    /*
       resourceType: 'track', 'album', 'playlist', or 'artist'
       Returns the entity object from __NEXT_DATA__.
    */
    const url = `https://open.spotify.com/embed/${resourceType}/${resourceId}`;
    const html = await http_get(url);
    const m = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
    const data = JSON.parse(m[1]);
    return data.props.pageProps.state.data.entity;
}

// ---- TRACK ----
let entity = await scrapeEmbed("track", "4PTG3Z6ehGkBFwjybzWkR8");
// entity keys: type, name, uri, id, title, artists, releaseDate, duration,
//              isPlayable, isExplicit, audioPreview, hasVideo, visualIdentity
// {
//   name:     "Never Gonna Give You Up",
//   uri:      "spotify:track:4PTG3Z6ehGkBFwjybzWkR8",
//   artists:  [{name: "Rick Astley", uri: "spotify:artist:0gxyHStUsqpMadRV0Di1Qt"}],
//   duration: 213573,   // milliseconds
//   releaseDate: {isoString: "1987-11-12T00:00:00Z"},
//   isPlayable: true,
//   isExplicit: false,
//   audioPreview: {url: "https://p.scdn.co/mp3-preview/b4c682..."},
//   visualIdentity: {
//     image: [
//       {url: "https://image-cdn-fa.spotifycdn.com/image/ab67616d00001e02...", maxWidth: 300, maxHeight: 300},
//       {url: "https://image-cdn-fa.spotifycdn.com/image/ab67616d000048...", maxWidth: 64,  maxHeight: 64},
//       {url: "https://image-cdn-fa.spotifycdn.com/image/ab67616d0000b27...", maxWidth: 640, maxHeight: 640},
//     ]
//   }
// }

// ---- ALBUM (includes full track list) ----
entity = await scrapeEmbed("album", "6fu8fvc7O4p8Gb8KMTBTUW");
// entity.trackList — list of all album tracks, e.g. 12 items:
// [{
//   uri:          "spotify:track:4e1zdmsDwNBNe9rk7HHC0i",
//   title:        "Prelude for Piano No. 1 in E-Flat Major",
//   subtitle:     "Eduard Abramyan,\u00a0Sona Shaboyan",
//   duration:     107426,
//   isPlayable:   true,
//   audioPreview: {url: "https://p.scdn.co/mp3-preview/d03c37..."},
//   entityType:   "track"
// }, ...]

// ---- PLAYLIST (includes up to 50 tracks) ----
entity = await scrapeEmbed("playlist", "37i9dQZF1DXcBWIGoYBM5M");
// entity.trackList — 50 items
// entity.subtitle  — "Spotify"
// entity.authors   — [{name: "Spotify"}]

// ---- ARTIST (includes top 10 tracks) ----
entity = await scrapeEmbed("artist", "0gxyHStUsqpMadRV0Di1Qt");
// entity.trackList — 10 top tracks, same shape as album trackList
// entity.subtitle  — "Top tracks"
```

### Bonus: Anonymous access token (embedded in every embed page)

The embed page SSR data includes a short-lived anonymous Spotify Web Player access token. The token is valid (~1 hour) but **anonymous tokens are severely rate-limited for api.spotify.com/v1 calls** (observed `Retry-After: 79561` seconds on the tracks endpoint after a few requests).

```js
async function getEmbedToken(resourceType = "track", resourceId = "4PTG3Z6ehGkBFwjybzWkR8") {
    /* Extract the anonymous access token from an embed page. */
    const url = `https://open.spotify.com/embed/${resourceType}/${resourceId}`;
    const html = await http_get(url);
    const m = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
    const data = JSON.parse(m[1]);
    const session = data.props.pageProps.state.settings.session;
    return {
        access_token:  session.accessToken,
        expires_ms:    session.accessTokenExpirationTimestampMs,
        is_anonymous:  session.isAnonymous,          // always true
        client_id:     data.props.pageProps.config.clientId,
    };
}

// Returned fields (verified 2026-04-18):
// access_token: "BQBfxv..." (a standard Spotify Bearer token, ~160 chars)
// expires_ms:   1776512455031 (~1 hour TTL)
// is_anonymous: true
// client_id:    "ab9ad0d96a624805a7d51e8868df1f97"

// WARNING: Do NOT use this token to hammer api.spotify.com/v1 — anonymous tokens
// share a global rate-limit bucket. One call can trigger a 22-hour ban window.
// Use the embed page __NEXT_DATA__ directly instead (Approach 3 above).
```

---

## What Requires a Browser

The following are **not accessible** via http_get and require the CDP browser:

- Lyrics (login-gated; JSON-LD confirms: `isAccessibleForFree: false`)
- Search (`/search?q=...`) — loads client-side only, no meaningful HTML on first response
- User library / listening history — requires OAuth
- Full audio playback — requires OAuth + Widevine DRM
- Podcast episodes — oEmbed returns 404; embed page `__NEXT_DATA__` lacks `state.data.entity`
- Track recommendations beyond the top-10 artist view
- Artist discography / full album list

If browser access is needed for search:

```js
await goto("https://open.spotify.com/search");
await wait_for_load();
await wait(2);
// Type into the search box
await js("document.querySelector('input[data-testid=\"search-input\"]').focus()");
await type_text("never gonna give you up");
await wait(1);
// Results appear in [data-testid="top-results-card"] or similar dynamic selectors
```

---

## URL Patterns

| Resource  | URL pattern                                    | ID format         |
|-----------|------------------------------------------------|-------------------|
| Track     | `https://open.spotify.com/track/{id}`          | 22-char alphanum  |
| Album     | `https://open.spotify.com/album/{id}`          | 22-char alphanum  |
| Artist    | `https://open.spotify.com/artist/{id}`         | 22-char alphanum  |
| Playlist  | `https://open.spotify.com/playlist/{id}`       | 22-char alphanum  |
| oEmbed    | `https://open.spotify.com/oembed?url={resource_url}` | any of above |
| Embed     | `https://open.spotify.com/embed/{type}/{id}`   | same ID           |

Extract Spotify ID from any URL:

```js
function spotifyId(url) {
    const m = url.match(/spotify\.com\/(?:embed\/)?(?:track|album|artist|playlist)\/([A-Za-z0-9]{22})/);
    return m ? m[1] : null;
}
```

---

## Gotchas

- **oEmbed 404 for valid IDs**: A 404 from oEmbed can mean the resource is region-locked or not available for embedding, not necessarily that the ID is wrong. Verified: track `3n3Ppam7vgaVa1iaRUIOKE` returns 404 on oEmbed despite existing on Spotify.
- **oEmbed 404 for artists**: Only works with valid, existing artist IDs. The artist ID `4gzpq5DumSF1a1LpGLBBl5` returns 404 — verify IDs from canonical Spotify URLs before using.
- **oEmbed does not support episodes**: `open.spotify.com/episode/{id}` always returns 404 from the oEmbed endpoint.
- **Embed page for episodes**: The embed page SSR for episodes does not include `state.data.entity` in the expected structure — parse defensively.
- **Anonymous token rate limiting**: The access token from embed pages is valid but severely rate-limited for `api.spotify.com/v1`. Observed `Retry-After: 79561` (~22 hours) after 2-3 rapid API calls. Use embed `__NEXT_DATA__` data instead of the API.
- **`get_access_token` endpoint blocked**: `https://open.spotify.com/get_access_token?reason=transport&productType=web_player` returns HTTP 403 from plain http_get regardless of headers. Token must be sourced from the embed page HTML.
- **`music:musician` meta tag dedup**: `matchAll` on `music:musician` returns all artist URLs. A dict-style dedup would only keep the last one — always use `matchAll` for multi-value tags.
- **Cover art CDN differences**: oEmbed thumbnail uses `image-cdn-ak.spotifycdn.com`; track page `og:image` uses `i.scdn.co`. Both are publicly accessible. The embed `visualIdentity.image` array provides three sizes (64, 300, 640).
- **No `__NEXT_DATA__` on main open.spotify.com pages**: The SSR `__NEXT_DATA__` pattern only works on `open.spotify.com/embed/*`, not on main track/album/artist pages. Those pages use JSON-LD and Open Graph tags instead.
- **Track duration units differ**: `music:duration` meta tag is in **seconds** (integer). Embed `__NEXT_DATA__` `entity.duration` is in **milliseconds**.
- **Rate limits for http_get pages**: No rate limit observed on oEmbed or static HTML pages in testing (10 concurrent requests succeeded; ~0.25s avg per oEmbed call).
