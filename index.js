// index.js
const { addonBuilder, serveHTTP } = require("stremio-addon-sdk");

const PLAYLIST_URL = process.env.PLAYLIST_URL;   // Dropbox raw link
const TMDB_KEY = process.env.TMDB_KEY;           // tvůj TMDb key

// --------- 1) Manifest ----------
const manifest = {
  id: "com.veronika.m3u.library",
  version: "0.1.0",
  name: "M3U Library (Movies+Series)",
  description: "Knihovna ze soukromého M3U (bez vlastních streamů). Streamy poskytují jiné addony.",
  resources: ["catalog", "meta"],
  types: ["movie", "series"],
  catalogs: [
    { type: "movie", id: "m3u-movies", name: "Moje filmy (M3U)" },
    { type: "series", id: "m3u-series", name: "Moje seriály (M3U)" }
  ]
};

const builder = new addonBuilder(manifest);

// --------- jednoduchá cache ----------
let cache = {
  loadedAt: 0,
  movies: [], // [{ tmdbId, imdbId, name, poster }]
  series: [], // [{ tmdbId, imdbId, name, poster, episodes: [{s,e}] }]
  byImdb: new Map(), // imdbId -> meta
};

async function fetchText(url) {
  const res = await fetchFn(url, { redirect: "follow" });
  const text = await res.text();

  console.log("PLAYLIST HEAD:", text.slice(0, 200));

  if (!text.includes("#EXTINF")) {
    throw new Error("Playlist is not M3U (#EXTINF missing) – Dropbox likely returned HTML");
  }
  return text;
}
async function mapLimit(arr, limit, fn) {
  const ret = [];
  const executing = [];
  for (const item of arr) {
    const p = Promise.resolve().then(() => fn(item));
    ret.push(p);

    if (limit <= arr.length) {
      const e = p.then(() => executing.splice(executing.indexOf(e), 1));
      executing.push(e);
      if (executing.length >= limit) await Promise.race(executing);
    }
  }
  return Promise.all(ret);
}
function parseSxxEyy(str) {
  const m = str.match(/S(\d{1,2})E(\d{1,2})/i);
  if (!m) return null;
  return { s: parseInt(m[1], 10), e: parseInt(m[2], 10) };
}

// Tady jen hrubý parser pro tvoje řádky (EXTINF + atributy)
function parseM3U(m3uText) {
  const lines = m3uText.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const items = [];

  for (const line of lines) {
    if (!line.startsWith("#EXTINF:")) continue;

    // vytáhni tvg-id, tvg-name, tvg-type, tvg-logo
    const getAttr = (key) => {
      const m = line.match(new RegExp(`${key}="([^"]*)"`, "i"));
      return m ? m[1] : "";
    };

    const tvgId = getAttr("tvg-id");      // "6687" / "1409"
    const tvgName = getAttr("tvg-name");  // "Zákon gangu S01E01"
    const tvgType = getAttr("tvg-type");  // "movie" / "tv"
    const logo = getAttr("tvg-logo");
    const titlePart = line.split(",").slice(1).join(",").trim(); // text za čárkou

    items.push({ tvgId, tvgName, tvgType, logo, titlePart });
  }
  return items;
}

// TMDb -> IMDb (film)
async function tmdbMovieToImdb(tmdbId) {
  const url = `https://api.themoviedb.org/3/movie/${tmdbId}?api_key=${TMDB_KEY}`;
  const data = await (await fetch(url)).json();
  return data.imdb_id || null;
}

// TMDb -> IMDb (seriál)
async function tmdbShowToImdb(tmdbId) {
  const url = `https://api.themoviedb.org/3/tv/${tmdbId}/external_ids?api_key=${TMDB_KEY}`;
  const data = await (await fetch(url)).json();
  return data.imdb_id || null;
}

async function ensureCache() {
  const now = Date.now();
  if (now - cache.loadedAt < 15 * 60 * 1000 && cache.movies.length) return; // 15 min

  const m3u = await fetchText(PLAYLIST_URL);
  const items = parseM3U(m3u);

  const moviesMap = new Map(); // tmdbId -> item
  const seriesMap = new Map(); // tmdbId -> { episodes: Set("s-e") ... }

  for (const it of items) {
    if (it.tvgType === "movie") {
      moviesMap.set(it.tvgId, it);
    } else if (it.tvgType === "tv") {
      const se = parseSxxEyy(it.tvgName) || parseSxxEyy(it.titlePart);
      if (!se) continue;
      if (!seriesMap.has(it.tvgId)) seriesMap.set(it.tvgId, { item: it, episodes: new Set() });
      seriesMap.get(it.tvgId).episodes.add(`${se.s}-${se.e}`);
    }
  }

  const movies = [];
  for (const [tmdbId, it] of moviesMap) {
    const imdbId = await tmdbMovieToImdb(tmdbId);
    if (!imdbId) continue;
    movies.push({ tmdbId, imdbId, name: it.titlePart || it.tvgName, poster: it.logo });
  }

  const series = [];
  for (const [tmdbId, obj] of seriesMap) {
    const imdbId = await tmdbShowToImdb(tmdbId);
    if (!imdbId) continue;
    const episodes = [...obj.episodes].map(x => {
      const [s,e] = x.split("-").map(n => parseInt(n, 10));
      return { s, e };
    }).sort((a,b)=> a.s-b.s || a.e-b.e);

    series.push({ tmdbId, imdbId, name: obj.item.titlePart || obj.item.tvgName, poster: obj.item.logo, episodes });
  }

  // postav byImdb meta
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
    byImdb.set(s.imdbId, {
      id: s.imdbId,
      type: "series",
      name: s.name.replace(/\sS\d{1,2}E\d{1,2}.*/i, "").trim(),
      poster: s.poster,
      videos: s.episodes.map(ep => ({
        id: `${s.imdbId}:${ep.s}:${ep.e}`,
        title: `S${String(ep.s).padStart(2,"0")}E${String(ep.e).padStart(2,"0")}`,
        season: ep.s,
        episode: ep.e
      }))
    });
  }

  cache = { loadedAt: now, movies, series, byImdb };
}

// --------- 2) Catalog ----------
builder.defineCatalogHandler(async ({ type, id }) => {
  try {
    await ensureCache();

    if (type === "movie" && id === "m3u-movies") {
      return { metas: cache.movies.map(m => ({
        id: m.imdbId,
        type: "movie",
        name: m.name,
        poster: m.poster
      })) };
    }

    if (type === "series" && id === "m3u-series") {
      return { metas: cache.series.map(s => ({
        id: s.imdbId,
        type: "series",
        name: s.name,
        poster: s.poster
      })) };
    }

    return { metas: [] };
  } catch (e) {
    console.error("CATALOG ERROR:", e);
    return { metas: [] };
  }
});

// --------- server ----------
serveHTTP(builder.getInterface(), { port: process.env.PORT || 7000 });
