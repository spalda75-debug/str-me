// index.js
process.on("uncaughtException", (err) => console.error("UNCAUGHT:", err));
process.on("unhandledRejection", (err) => console.error("UNHANDLED:", err));

const fetchFn = global.fetch ? global.fetch.bind(global) : require("node-fetch");
const { addonBuilder, serveHTTP } = require("stremio-addon-sdk");

const PLAYLIST_URL = process.env.PLAYLIST_URL; // Dropbox link (doporučuji ...&dl=1)
const TMDB_KEY = process.env.TMDB_KEY;         // TMDb API key
const PORT = process.env.PORT || 7000;

const manifest = {
  id: "com.veronika.m3u.library",
  version: "0.2.0",
  name: "M3U Library (Movies+Series)",
  description: "Knihovna z M3U (bez vlastních streamů). Streamy poskytují jiné addony.",
  resources: ["catalog", "meta"],
  types: ["movie", "series"],
  catalogs: [
    { type: "movie", id: "m3u-movies", name: "Moje filmy (M3U)" },
    { type: "series", id: "m3u-series", name: "Moje seriály (M3U)" }
  ]
};

const builder = new addonBuilder(manifest);

// ---------------- Cache ----------------
let cache = {
  loadedAt: 0,
  movies: [],          // [{ tmdbId, imdbId, name, poster }]
  series: [],          // [{ tmdbId, imdbId, name, poster, episodes:[{s,e}] }]
  byImdb: new Map(),   // imdbId -> meta
};

// ---------------- Helpers ----------------
async function fetchText(url) {
  const res = await fetchFn(url, {
    redirect: "follow",
    headers: { "User-Agent": "Mozilla/5.0 (StremioM3UAddon)" }
  });

  const text = await res.text();

  console.log("PLAYLIST HTTP:", res.status, res.headers.get("content-type"));
  console.log("PLAYLIST HEAD:", JSON.stringify(text.slice(0, 200)));

  if (!res.ok) {
    throw new Error(`PLAYLIST HTTP ${res.status}`);
  }
  return text;
}

async function tmdbJson(url) {
  const res = await fetchFn(url, { redirect: "follow" });
  const text = await res.text();

  if (!res.ok) {
    throw new Error(`TMDb HTTP ${res.status}: ${text.slice(0, 200)}`);
  }

  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`TMDb invalid JSON: ${text.slice(0, 200)}`);
  }
}

async function tmdbMovieToImdb(tmdbId) {
  const url = `https://api.themoviedb.org/3/movie/${tmdbId}?api_key=${TMDB_KEY}`;
  const data = await tmdbJson(url);
  return data.imdb_id || null;
}

async function tmdbShowToImdb(tmdbId) {
  const url = `https://api.themoviedb.org/3/tv/${tmdbId}/external_ids?api_key=${TMDB_KEY}`;
  const data = await tmdbJson(url);
  return data.imdb_id || null;
}

function parseSxxEyy(str) {
  const m = (str || "").match(/S(\d{1,2})E(\d{1,2})/i);
  if (!m) return null;
  return { s: parseInt(m[1], 10), e: parseInt(m[2], 10) };
}

// tolerantní getAttr: key="value" i key=value
function getAttr(line, key) {
  let m = line.match(new RegExp(`${key}="([^"]*)"`, "i"));
  if (m) return m[1];

  m = line.match(new RegExp(`${key}=([^\\s,]+)`, "i"));
  return m ? m[1] : "";
}

// Parser: bere jen #EXTINF řádky, title bere za čárkou
function parseM3U(m3uText) {
  const lines = m3uText.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const items = [];

  for (const line of lines) {
    if (!line.toUpperCase().startsWith("#EXTINF")) continue;

    const tvgId = getAttr(line, "tvg-id");
    const tvgName = getAttr(line, "tvg-name");
    const tvgType = (getAttr(line, "tvg-type") || "").toLowerCase().trim();
    const logo = getAttr(line, "tvg-logo");

    const titlePart = line.includes(",") ? line.split(",").slice(1).join(",").trim() : "";

    items.push({ tvgId, tvgName, tvgType, logo, titlePart });
  }

  console.log("PARSE items:", items.length);
  console.log("PARSE tvgType sample:", items.slice(0, 10).map(x => x.tvgType));

  return items;
}

// limit paralelních requestů (aby to neshodilo timeouts)
async function mapLimit(arr, limit, fn) {
  const ret = [];
  const executing = [];
  for (const item of arr) {
    const p = Promise.resolve().then(() => fn(item));
    ret.push(p);

    const e = p.then(() => executing.splice(executing.indexOf(e), 1));
    executing.push(e);

    if (executing.length >= limit) {
      await Promise.race(executing);
    }
  }
  return Promise.all(ret);
}

// ---------------- Core ----------------
async function ensureCache() {
  if (!PLAYLIST_URL) throw new Error("Missing env PLAYLIST_URL");
  if (!TMDB_KEY) throw new Error("Missing env TMDB_KEY");

  const now = Date.now();
  if (now - cache.loadedAt < 15 * 60 * 1000 && (cache.movies.length || cache.series.length)) {
    return;
  }

  const m3u = await fetchText(PLAYLIST_URL);

  console.log("PLAYLIST has #EXTINF:", m3u.includes("#EXTINF"));
  console.log("PLAYLIST #EXTINF count:", (m3u.match(/#EXTINF/gi) || []).length);

  if (!m3u.includes("#EXTINF")) {
    throw new Error("Downloaded playlist, but no #EXTINF found (likely HTML/wrong link).");
  }

  const items = parseM3U(m3u);

  // rozdělení movie/series
  const moviesMap = new Map(); // tmdbId -> item
  const seriesMap = new Map(); // tmdbId -> { item, episodes:Set("s-e") }

  for (const it of items) {
    const t = (it.tvgType || "").toLowerCase();

    if (t === "movie") {
      if (it.tvgId) moviesMap.set(it.tvgId, it);
      continue;
    }

    // seriály: tv / series / tvshow
    if (t === "tv" || t === "series" || t === "tvshow" || t === "show") {
      const se = parseSxxEyy(it.tvgName) || parseSxxEyy(it.titlePart);
      if (!se) continue;
      if (!it.tvgId) continue;

      if (!seriesMap.has(it.tvgId)) seriesMap.set(it.tvgId, { item: it, episodes: new Set() });
      seriesMap.get(it.tvgId).episodes.add(`${se.s}-${se.e}`);
    }
  }

  console.log("MOVIES candidates:", moviesMap.size);
  console.log("SERIES candidates:", seriesMap.size);

  // TMDb -> IMDb (paralelně s limitem)
  const movieEntries = [...moviesMap.entries()];
  const moviesResolved = await mapLimit(movieEntries, 6, async ([tmdbId, it]) => {
    const imdbId = await tmdbMovieToImdb(tmdbId);
    if (!imdbId) return null;
    return { tmdbId, imdbId, name: it.titlePart || it.tvgName, poster: it.logo };
  });
  const movies = moviesResolved.filter(Boolean);

  const seriesEntries = [...seriesMap.entries()];
  const seriesResolved = await mapLimit(seriesEntries, 4, async ([tmdbId, obj]) => {
    const imdbId = await tmdbShowToImdb(tmdbId);
    if (!imdbId) return null;

    const episodes = [...obj.episodes]
      .map(x => {
        const [s, e] = x.split("-").map(n => parseInt(n, 10));
        return { s, e };
      })
      .sort((a, b) => a.s - b.s || a.e - b.e);

    return {
      tmdbId,
      imdbId,
      name: (obj.item.titlePart || obj.item.tvgName),
      poster: obj.item.logo,
      episodes
    };
  });
  const series = seriesResolved.filter(Boolean);

  console.log("MOVIES mapped (IMDb ok):", movies.length);
  console.log("SERIES mapped (IMDb ok):", series.length);

  // build meta map (imdbId -> meta)
  const byImdb = new Map();

  for (const m of movies) {
    byImdb.set(m.imdbId, {
      id: m.imdbId,
      type: "movie",
      name: m.name,
      poster: m.poster
    });
  }

  for (const s of series) {
    const cleanName = (s.name || "").replace(/\sS\d{1,2}E\d{1,2}.*/i, "").trim();

    byImdb.set(s.imdbId, {
      id: s.imdbId,
      type: "series",
      name: cleanName || s.name,
      poster: s.poster,
      videos: s.episodes.map(ep => ({
        id: `${s.imdbId}:${ep.s}:${ep.e}`,
        title: `S${String(ep.s).padStart(2, "0")}E${String(ep.e).padStart(2, "0")}`,
        season: ep.s,
        episode: ep.e
      }))
    });
  }

  cache = { loadedAt: now, movies, series, byImdb };
}

// ---------------- Handlers ----------------
builder.defineCatalogHandler(async ({ type, id }) => {
  try {
    console.log("CATALOG request:", type, id);
    await ensureCache();

    if (type === "movie" && id === "m3u-movies") {
      return {
        metas: cache.movies.map(m => ({
          id: m.imdbId,
          type: "movie",
          name: m.name,
          poster: m.poster
        }))
      };
    }

    if (type === "series" && id === "m3u-series") {
      return {
        metas: cache.series.map(s => ({
          id: s.imdbId,
          type: "series",
          name: (s.name || "").replace(/\sS\d{1,2}E\d{1,2}.*/i, "").trim() || s.name,
          poster: s.poster
        }))
      };
    }

    return { metas: [] };
  } catch (e) {
    console.error("CATALOG HANDLER ERROR:", e && (e.stack || e.message || e));
    return { metas: [] };
  }
});

builder.defineMetaHandler(async ({ type, id }) => {
  try {
    console.log("META request:", type, id);
    await ensureCache();

    const meta = cache.byImdb.get(id);

    if (!meta || meta.type !== type) {
      return { meta: null };
    }

    return { meta };
  } catch (e) {
    console.error("META HANDLER ERROR:", e && (e.stack || e.message || e));
    return { meta: null };
  }
});

// ---------------- Server ----------------
serveHTTP(builder.getInterface(), { port: PORT });

console.log("Addon running on port:", PORT);
console.log("Manifest:", `http://localhost:${PORT}/manifest.json`);.getInterface(), { port: process.env.PORT || 7000 });
