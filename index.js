// index.js — Catalog-only (Cinemeta for descriptions) + group-title filter + refresh
process.on("uncaughtException", (err) => console.error("UNCAUGHT:", err));
process.on("unhandledRejection", (err) => console.error("UNHANDLED:", err));

const { addonBuilder, serveHTTP } = require("stremio-addon-sdk");

const fetchFn = global.fetch?.bind(global);
if (!fetchFn) {
  console.error("No global fetch available. Use Node 18+ runtime.");
  process.exit(1);
}

const PLAYLIST_URL = (process.env.PLAYLIST_URL || "").trim();
const TMDB_KEY = (process.env.TMDB_KEY || "").trim();
const PORT = process.env.PORT || 7000;

// jak často se může stáhnout playlist znovu (sekundy)
const PLAYLIST_REFRESH_SEC = parseInt(process.env.PLAYLIST_REFRESH_SEC || "120", 10); // default 2 min

const manifest = {
  id: "com.veronika.m3u.library",
  version: "0.5.0",
  name: "M3U Library (IMDb + group filter)",
  description: "Knihovna z M3U: tvg-id=TMDb -> IMDb. Popisy nechává na Cinemeta. Filtr podle group-title + refresh.",
  resources: ["catalog"],                 // <- DŮLEŽITÉ: žádné meta (ať popisy dává Cinemeta)
  types: ["movie", "series"],
  catalogs: [
    {
      type: "movie",
      id: "m3u-movies",
      name: "Moje filmy (M3U)",
      extra: [
        { name: "group", isRequired: false },                 // filtr group-title (text)
        { name: "refresh", isRequired: false, options: ["0","1"] } // 1 = vynutí reload
      ]
    },
    {
      type: "series",
      id: "m3u-series",
      name: "Moje seriály (M3U)",
      extra: [
        { name: "group", isRequired: false },
        { name: "refresh", isRequired: false, options: ["0","1"] }
      ]
    }
  ]
};

const builder = new addonBuilder(manifest);

// ---------- TMDb -> IMDb cache (RAM) ----------
const tmdbToImdbMem = new Map(); // key: movie:ID / tv:ID -> imdbId|null

async function tmdbJson(url) {
  const res = await fetchFn(url, { redirect: "follow" });
  const text = await res.text();
  if (!res.ok) throw new Error(`TMDb HTTP ${res.status}: ${text.slice(0, 200)}`);
  return JSON.parse(text);
}

async function tmdbMovieToImdb(tmdbId) {
  const key = `movie:${tmdbId}`;
  if (tmdbToImdbMem.has(key)) return tmdbToImdbMem.get(key);

  const url = `https://api.themoviedb.org/3/movie/${tmdbId}?api_key=${TMDB_KEY}`;
  const data = await tmdbJson(url);
  const imdbId = data.imdb_id || null;

  tmdbToImdbMem.set(key, imdbId);
  return imdbId;
}

async function tmdbTvToImdb(tmdbId) {
  const key = `tv:${tmdbId}`;
  if (tmdbToImdbMem.has(key)) return tmdbToImdbMem.get(key);

  const url = `https://api.themoviedb.org/3/tv/${tmdbId}/external_ids?api_key=${TMDB_KEY}`;
  const data = await tmdbJson(url);
  const imdbId = data.imdb_id || null;

  tmdbToImdbMem.set(key, imdbId);
  return imdbId;
}

// ---------- M3U parsing ----------
function getAttr(line, key) {
  let m = line.match(new RegExp(`${key}="([^"]*)"`, "i"));
  if (m) return m[1];
  m = line.match(new RegExp(`${key}=([^\\s,]+)`, "i"));
  return m ? m[1] : "";
}

function parseSxxEyy(str) {
  const m = (str || "").match(/S(\d{1,2})E(\d{1,2})/i);
  if (!m) return null;
  return { s: parseInt(m[1], 10), e: parseInt(m[2], 10) };
}

async function fetchText(url) {
  const res = await fetchFn(url, {
    redirect: "follow",
    headers: { "User-Agent": "Mozilla/5.0 (StremioM3UAddon)" }
  });
  const text = await res.text();

  console.log("PLAYLIST HTTP:", res.status, res.headers.get("content-type"));
  console.log("PLAYLIST HEAD:", JSON.stringify(text.slice(0, 120)));

  if (!res.ok) throw new Error(`PLAYLIST HTTP ${res.status}`);
  return text;
}

function parseM3U(m3uText) {
  const lines = m3uText.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const items = [];

  for (const line of lines) {
    if (!line.toUpperCase().startsWith("#EXTINF")) continue;

    const tvgId = getAttr(line, "tvg-id") || "";
    const tvgName = getAttr(line, "tvg-name") || "";
    const tvgType = (getAttr(line, "tvg-type") || "").toLowerCase().trim(); // movie / tv
    const logo = getAttr(line, "tvg-logo") || "";
    const groupTitle = getAttr(line, "group-title") || "";
    const titlePart = line.includes(",") ? line.split(",").slice(1).join(",").trim() : tvgName;

    items.push({ tvgId, tvgName, tvgType, logo, groupTitle, titlePart });
  }

  console.log("PARSE items:", items.length);
  return items;
}

async function mapLimit(arr, limit, fn) {
  const ret = [];
  const executing = [];
  for (const item of arr) {
    const p = Promise.resolve().then(() => fn(item));
    ret.push(p);

    const e = p.then(() => executing.splice(executing.indexOf(e), 1));
    executing.push(e);

    if (executing.length >= limit) await Promise.race(executing);
  }
  return Promise.all(ret);
}

// ---------- Catalog cache (rychlá) ----------
let cache = {
  loadedAt: 0,
  movies: [], // { imdbId, name, poster, groupTitle }
  series: []  // { imdbId, name, poster, groupTitle }
};

function normalizeStr(s) {
  return (s || "").toLowerCase();
}

async function ensureCache(forceReload = false) {
  if (!PLAYLIST_URL) throw new Error("Missing env PLAYLIST_URL");
  if (!TMDB_KEY) throw new Error("Missing env TMDB_KEY");

  const now = Date.now();
  const ttlMs = Math.max(10, PLAYLIST_REFRESH_SEC) * 1000;

  if (!forceReload && now - cache.loadedAt < ttlMs && (cache.movies.length || cache.series.length)) return;

  const m3u = await fetchText(PLAYLIST_URL);
  const extinfCount = (m3u.match(/#EXTINF/gi) || []).length;
  console.log("PLAYLIST #EXTINF count:", extinfCount);
  if (extinfCount === 0) throw new Error("No #EXTINF found in playlist (wrong link / HTML).");

  const items = parseM3U(m3u);

  const moviesMap = new Map(); // tmdbId -> item
  const seriesMap = new Map(); // tmdbId -> { item, episodes:Set }
  for (const it of items) {
    const t = (it.tvgType || "").toLowerCase();

    if (t === "movie") {
      if (it.tvgId) moviesMap.set(it.tvgId, it);
      continue;
    }

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

  const movieEntries = [...moviesMap.entries()];
  const movieResolved = await mapLimit(movieEntries, 6, async ([tmdbId, it]) => {
    const imdbId = await tmdbMovieToImdb(tmdbId);
    if (!imdbId) return null;
    return {
      imdbId,
      name: it.titlePart || it.tvgName,
      poster: it.logo || undefined,        // fallback; Cinemeta dá typicky lepší
      groupTitle: it.groupTitle || ""
    };
  });

  const seriesEntries = [...seriesMap.entries()];
  const seriesResolved = await mapLimit(seriesEntries, 4, async ([tmdbId, obj]) => {
    const imdbId = await tmdbTvToImdb(tmdbId);
    if (!imdbId) return null;

    const rawName = obj.item.titlePart || obj.item.tvgName || "";
    const cleanName = rawName.replace(/\sS\d{1,2}E\d{1,2}.*/i, "").trim();

    return {
      imdbId,
      name: cleanName || rawName,
      poster: obj.item.logo || undefined,
      groupTitle: obj.item.groupTitle || ""
    };
  });

  cache = {
    loadedAt: now,
    movies: movieResolved.filter(Boolean),
    series: seriesResolved.filter(Boolean)
  };

  console.log("MOVIES mapped:", cache.movies.length, "SERIES mapped:", cache.series.length);
}

// ---------- handler ----------
builder.defineCatalogHandler(async ({ type, id, extra }) => {
  try {
    const force = extra?.refresh === "1";
    await ensureCache(force);

    const groupFilter = (extra?.group || "").trim();
    const gf = normalizeStr(groupFilter);

    const filterByGroup = (arr) => {
      if (!gf) return arr;
      return arr.filter(x => normalizeStr(x.groupTitle).includes(gf));
    };

    if (type === "movie" && id === "m3u-movies") {
      const arr = filterByGroup(cache.movies);
      return {
        metas: arr.map(m => ({
          id: m.imdbId,
          type: "movie",
          name: m.name,
          poster: m.poster
        }))
      };
    }

    if (type === "series" && id === "m3u-series") {
      const arr = filterByGroup(cache.series);
      return {
        metas: arr.map(s => ({
          id: s.imdbId,
          type: "series",
          name: s.name,
          poster: s.poster
        }))
      };
    }

    return { metas: [] };
  } catch (e) {
    console.error("CATALOG ERROR:", e?.stack || e?.message || e);
    return { metas: [] };
  }
});

serveHTTP(builder.getInterface(), { port: PORT });
console.log("Addon running on port:", PORT);
