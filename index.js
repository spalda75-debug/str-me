// index.js
process.on("uncaughtException", (err) => console.error("UNCAUGHT:", err));
process.on("unhandledRejection", (err) => console.error("UNHANDLED:", err));

const { addonBuilder, serveHTTP } = require("stremio-addon-sdk");

const fetchFn = global.fetch?.bind(global);
if (!fetchFn) {
  console.error("No global fetch available. Use Node 18+ runtime.");
  process.exit(1);
}

const PLAYLIST_URL = process.env.PLAYLIST_URL || "";
const TMDB_KEY = process.env.TMDB_KEY || "";
const PORT = process.env.PORT || 7000;

// --- manifest
const manifest = {
  id: "com.veronika.m3u.library",
  version: "0.4.0",
  name: "M3U Library (IMDb + poster fallback)",
  description: "Knihovna z M3U. tvg-id = TMDb ID. Převod na IMDb pro vyhledávání zdrojů + fallback poster z tvg-logo.",
  resources: ["catalog", "meta"],
  types: ["movie", "series"],
  catalogs: [
    { type: "movie", id: "m3u-movies", name: "Moje filmy (M3U)" },
    { type: "series", id: "m3u-series", name: "Moje seriály (M3U)" }
  ]
};

const builder = new addonBuilder(manifest);

// ---------------- cache ----------------
let cache = {
  loadedAt: 0,
  moviesMetas: [],     // catalog metas (id=tt..., poster fallback)
  seriesMetas: [],
  byImdb: new Map(),   // imdbId -> meta (fallback meta)
};

// tmdbId -> imdbId cache (persistuje jen v RAM; na Renderu to stačí)
const tmdbToImdbMem = new Map(); // key: `movie:123` / `tv:456` -> imdbId|null

// ---------------- helpers ----------------
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

// stáhni text (Dropbox)
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

// parse M3U: bere jen EXTINF řádky (+ URL na dalším řádku ignorujeme, nejsou potřeba)
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
  console.log("PARSE types:", [...new Set(items.map(i => i.tvgType))].slice(0, 10));

  return items;
}

// jednoduchý paralelní limit (TMDb má limity)
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

async function tmdbJson(url) {
  const res = await fetchFn(url, { redirect: "follow" });
  const text = await res.text();
  if (!res.ok) throw new Error(`TMDb HTTP ${res.status}: ${text.slice(0, 200)}`);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`TMDb invalid JSON: ${text.slice(0, 200)}`);
  }
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

// ---------------- core build ----------------
async function ensureCache() {
  if (!PLAYLIST_URL) throw new Error("Missing env PLAYLIST_URL");
  if (!TMDB_KEY) throw new Error("Missing env TMDB_KEY");

  const now = Date.now();
  // 15 min cache
  if (now - cache.loadedAt < 15 * 60 * 1000 && (cache.moviesMetas.length || cache.seriesMetas.length)) return;

  const m3u = await fetchText(PLAYLIST_URL);
  const extinfCount = (m3u.match(/#EXTINF/gi) || []).length;
  console.log("PLAYLIST #EXTINF count:", extinfCount);
  if (extinfCount === 0) throw new Error("No #EXTINF found in playlist (probably HTML / wrong link).");

  const items = parseM3U(m3u);

  // seskupení filmů a seriálů
  const moviesMap = new Map(); // tmdbId -> item
  const seriesMap = new Map(); // tmdbId -> { item, episodes:Set("s-e") }

  for (const it of items) {
    const t = (it.tvgType || "").toLowerCase();

    if (t === "movie") {
      if (it.tvgId) moviesMap.set(it.tvgId, it);
      continue;
    }

    if (t === "tv" || t === "series" || t === "tvshow" || t === "show") {
      // epizodu bereme z tvg-name nebo title za čárkou
      const se = parseSxxEyy(it.tvgName) || parseSxxEyy(it.titlePart);
      if (!se) continue;
      if (!it.tvgId) continue;

      if (!seriesMap.has(it.tvgId)) seriesMap.set(it.tvgId, { item: it, episodes: new Set() });
      seriesMap.get(it.tvgId).episodes.add(`${se.s}-${se.e}`);
    }
  }

  console.log("MOVIES candidates:", moviesMap.size);
  console.log("SERIES candidates:", seriesMap.size);

  // --- TMDb->IMDb (limit parallel)
  const movieEntries = [...moviesMap.entries()];
  const movieResolved = await mapLimit(movieEntries, 6, async ([tmdbId, it]) => {
    let imdbId = null;
    try {
      imdbId = await tmdbMovieToImdb(tmdbId);
    } catch (e) {
      console.error("TMDB movie error", tmdbId, e?.message || e);
      return null;
    }
    if (!imdbId) return null;

    return {
      tmdbId,
      imdbId,
      name: it.titlePart || it.tvgName,
      poster: it.logo || undefined,
      group: it.groupTitle || ""
    };
  });

  const movies = movieResolved.filter(Boolean);

  const seriesEntries = [...seriesMap.entries()];
  const seriesResolved = await mapLimit(seriesEntries, 4, async ([tmdbId, obj]) => {
    let imdbId = null;
    try {
      imdbId = await tmdbTvToImdb(tmdbId);
    } catch (e) {
      console.error("TMDB tv error", tmdbId, e?.message || e);
      return null;
    }
    if (!imdbId) return null;

    const episodes = [...obj.episodes]
      .map(x => {
        const [s, e] = x.split("-").map(n => parseInt(n, 10));
        return { s, e };
      })
      .sort((a, b) => a.s - b.s || a.e - b.e);

    const rawName = obj.item.titlePart || obj.item.tvgName || "";
    const cleanName = rawName.replace(/\sS\d{1,2}E\d{1,2}.*/i, "").trim();

    return {
      tmdbId,
      imdbId,
      name: cleanName || rawName,
      poster: obj.item.logo || undefined,
      group: obj.item.groupTitle || "",
      episodes
    };
  });

  const series = seriesResolved.filter(Boolean);

  console.log("MOVIES mapped (IMDb ok):", movies.length);
  console.log("SERIES mapped (IMDb ok):", series.length);

  // --- build catalog metas + byImdb fallback meta
  const moviesMetas = [];
  const seriesMetas = [];
  const byImdb = new Map();

  for (const m of movies) {
    // catalog meta
    const meta = {
      id: m.imdbId,
      type: "movie",
      name: m.name,
      poster: m.poster, // fallback; Cinemeta si stejně často přepíše
      description: m.group ? `Skupina: ${m.group}` : undefined
    };
    moviesMetas.push(meta);

    // meta fallback
    byImdb.set(m.imdbId, meta);
  }

  for (const s of series) {
    const meta = {
      id: s.imdbId,
      type: "series",
      name: s.name,
      poster: s.poster,
      description: s.group ? `Skupina: ${s.group}` : undefined,
      videos: s.episodes.map(ep => ({
        id: `${s.imdbId}:${ep.s}:${ep.e}`,
        title: `S${String(ep.s).padStart(2, "0")}E${String(ep.e).padStart(2, "0")}`,
        season: ep.s,
        episode: ep.e
      }))
    };
    seriesMetas.push(meta);

    // meta fallback
    byImdb.set(s.imdbId, meta);
  }

  cache = { loadedAt: now, moviesMetas, seriesMetas, byImdb };
}

// ---------------- handlers ----------------
builder.defineCatalogHandler(async ({ type, id }) => {
  try {
    await ensureCache();

    if (type === "movie" && id === "m3u-movies") return { metas: cache.moviesMetas };
    if (type === "series" && id === "m3u-series") return { metas: cache.seriesMetas };

    return { metas: [] };
  } catch (e) {
    console.error("CATALOG ERROR:", e?.stack || e?.message || e);
    return { metas: [] };
  }
});

// Meta handler: vrací fallback meta, kdyby Cinemeta něco neměla hned
builder.defineMetaHandler(async ({ type, id }) => {
  try {
    await ensureCache();

    const meta = cache.byImdb.get(id) || null;
    if (!meta || meta.type !== type) return { meta: null };

    return { meta };
  } catch (e) {
    console.error("META ERROR:", e?.stack || e?.message || e);
    return { meta: null };
  }
});

serveHTTP(builder.getInterface(), { port: PORT });
console.log("Addon running on port:", PORT);
