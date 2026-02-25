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

// jak často je OK stáhnout playlist znovu (sekundy)
const PLAYLIST_REFRESH_SEC = parseInt(process.env.PLAYLIST_REFRESH_SEC || "300", 10); // default 5 min

// kolik paralelních requestů na TMDb (ať nedostaneš 429)
const TMDB_PAR_MOVIES = parseInt(process.env.TMDB_PAR_MOVIES || "6", 10);
const TMDB_PAR_SERIES = parseInt(process.env.TMDB_PAR_SERIES || "4", 10);

// ------------------------------------------------------------
// helpers
// ------------------------------------------------------------
function slugify(s) {
  return (s || "")
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9\-_/]+/g, "")
    .replace(/[\/_]+/g, "-")
    .replace(/\-+/g, "-")
    .slice(0, 60) || "neznamy";
}

function parseSxxEyy(str) {
  const m = (str || "").match(/S(\d{1,2})E(\d{1,2})/i);
  if (!m) return null;
  return { s: parseInt(m[1], 10), e: parseInt(m[2], 10) };
}

function getAttr(line, key) {
  let m = line.match(new RegExp(`${key}="([^"]*)"`, "i"));
  if (m) return m[1];
  m = line.match(new RegExp(`${key}=([^\\s,]+)`, "i"));
  return m ? m[1] : "";
}

function splitGenres(groupTitle) {
  // "Drama/Krimi/Thriller" -> ["Drama","Krimi","Thriller"]
  const raw = (groupTitle || "")
    .split(/[\/|,]+/g)
    .map(s => s.trim())
    .filter(Boolean);

  const seen = new Set();
  const out = [];
  for (const g of raw) {
    const k = g.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(g);
  }
  return out;
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

    const tvgId = getAttr(line, "tvg-id") || ""; // TMDb id (tvůj standard)
    const tvgName = getAttr(line, "tvg-name") || "";
    const tvgType = (getAttr(line, "tvg-type") || "").toLowerCase().trim(); // movie / tv
    const logo = getAttr(line, "tvg-logo") || "";
    const groupTitle = getAttr(line, "group-title") || "";
    const titlePart = line.includes(",") ? line.split(",").slice(1).join(",").trim() : tvgName;

    items.push({ tvgId, tvgName, tvgType, logo, groupTitle, titlePart });
  }

  console.log("PARSE items:", items.length);
  console.log("PARSE types:", [...new Set(items.map(i => i.tvgType))].slice(0, 20));
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

// ------------------------------------------------------------
// TMDb helpers (IMDb + cs-CZ meta)
// ------------------------------------------------------------
const tmdbToImdbMem = new Map(); // movie:ID / tv:ID -> tt...|null
const tmdbCzMetaMem = new Map(); // movie:ID / tv:ID -> { overview, poster_path, title/name, release_date/first_air_date, runtime, vote_average }

async function tmdbJson(url) {
  const res = await fetchFn(url, { redirect: "follow" });
  const text = await res.text();
  if (!res.ok) throw new Error(`TMDb HTTP ${res.status}: ${text.slice(0, 200)}`);
  return JSON.parse(text);
}

async function tmdbMovieToImdb(tmdbId) {
  const key = `movie:${tmdbId}`;
  if (tmdbToImdbMem.has(key)) return tmdbToImdbMem.get(key);

  const data = await tmdbJson(`https://api.themoviedb.org/3/movie/${tmdbId}?api_key=${TMDB_KEY}`);
  const imdbId = data.imdb_id || null;

  tmdbToImdbMem.set(key, imdbId);
  return imdbId;
}

async function tmdbTvToImdb(tmdbId) {
  const key = `tv:${tmdbId}`;
  if (tmdbToImdbMem.has(key)) return tmdbToImdbMem.get(key);

  const data = await tmdbJson(`https://api.themoviedb.org/3/tv/${tmdbId}/external_ids?api_key=${TMDB_KEY}`);
  const imdbId = data.imdb_id || null;

  tmdbToImdbMem.set(key, imdbId);
  return imdbId;
}

async function tmdbCzMovieMeta(tmdbId) {
  const key = `movie:${tmdbId}`;
  if (tmdbCzMetaMem.has(key)) return tmdbCzMetaMem.get(key);

  const data = await tmdbJson(`https://api.themoviedb.org/3/movie/${tmdbId}?api_key=${TMDB_KEY}&language=cs-CZ`);
  const out = {
    overview: (data.overview || "").trim(),
    poster_path: data.poster_path || "",
    title: data.title || data.original_title || "",
    release_date: data.release_date || "",
    runtime: typeof data.runtime === "number" ? data.runtime : null,
    vote_average: typeof data.vote_average === "number" ? data.vote_average : null
  };
  tmdbCzMetaMem.set(key, out);
  return out;
}

async function tmdbCzTvMeta(tmdbId) {
  const key = `tv:${tmdbId}`;
  if (tmdbCzMetaMem.has(key)) return tmdbCzMetaMem.get(key);

  const data = await tmdbJson(`https://api.themoviedb.org/3/tv/${tmdbId}?api_key=${TMDB_KEY}&language=cs-CZ`);
  const out = {
    overview: (data.overview || "").trim(),
    poster_path: data.poster_path || "",
    title: data.name || data.original_name || "",
    first_air_date: data.first_air_date || "",
    episode_run_time: Array.isArray(data.episode_run_time) && data.episode_run_time.length ? data.episode_run_time[0] : null,
    vote_average: typeof data.vote_average === "number" ? data.vote_average : null
  };
  tmdbCzMetaMem.set(key, out);
  return out;
}

function tmdbPosterUrl(path) {
  return path ? `https://image.tmdb.org/t/p/w500${path}` : null;
}

function yearFromDate(dateStr) {
  const m = (dateStr || "").match(/^(\d{4})/);
  return m ? m[1] : "";
}

function imdbRatingFromTmdb(voteAverage) {
  // vote_average je 0..10, v UI ukazuje jako "IMDb" badge jen když pošleme imdbRating
  if (typeof voteAverage !== "number") return null;
  const r = Math.round(voteAverage * 1000) / 1000; // 3 desetiny
  if (!isFinite(r) || r <= 0) return null;
  return r;
}

// ------------------------------------------------------------
// cache (playlist + mapped items)
// ------------------------------------------------------------
let cache = {
  loadedAt: 0,

  movies: [], // { tmdbId, imdbId, name, poster, genres[], description, releaseInfo, runtime, imdbRating }
  series: [], // { tmdbId, imdbId, name, poster, genres[], description, releaseInfo, runtime, imdbRating, episodes:Set }

  byImdb: new Map(), // tt.. -> { type, tmdbId, fallbackPoster, fallbackName, genres[] }

  movieGenres: [], // uniq list of all genres
  seriesGenres: []
};

async function ensureCache(forceReload = false) {
  if (!PLAYLIST_URL) throw new Error("Missing env PLAYLIST_URL");
  if (!TMDB_KEY) throw new Error("Missing env TMDB_KEY");

  const now = Date.now();
  const ttlMs = Math.max(10, PLAYLIST_REFRESH_SEC) * 1000;

  if (!forceReload && now - cache.loadedAt < ttlMs && (cache.movies.length || cache.series.length)) return;

  const m3u = await fetchText(PLAYLIST_URL);
  const extinfCount = (m3u.match(/#EXTINF/gi) || []).length;
  console.log("PLAYLIST #EXTINF count:", extinfCount);
  if (extinfCount === 0) throw new Error("No #EXTINF found (wrong link / HTML).");

  const items = parseM3U(m3u);

  const moviesMap = new Map(); // tmdbId -> item
  const seriesMap = new Map(); // tmdbId -> { item, episodes:Set }
  const movieGenresSet = new Set();
  const seriesGenresSet = new Set();

  for (const it of items) {
    const t = (it.tvgType || "").toLowerCase();

    if (t === "movie") {
      if (it.tvgId) moviesMap.set(it.tvgId, it);
      for (const g of splitGenres(it.groupTitle)) movieGenresSet.add(g);
      continue;
    }

    if (t === "tv" || t === "series" || t === "tvshow" || t === "show") {
      const se = parseSxxEyy(it.tvgName) || parseSxxEyy(it.titlePart);
      if (!se) continue;
      if (!it.tvgId) continue;

      if (!seriesMap.has(it.tvgId)) seriesMap.set(it.tvgId, { item: it, episodes: new Set() });
      seriesMap.get(it.tvgId).episodes.add(`${se.s}-${se.e}`);

      for (const g of splitGenres(it.groupTitle)) seriesGenresSet.add(g);
    }
  }

  console.log("MOVIES candidates:", moviesMap.size);
  console.log("SERIES candidates:", seriesMap.size);

  // --- movies resolve (IMDb + CZ text) ---
  const movieEntries = [...moviesMap.entries()];
  const movieResolved = await mapLimit(movieEntries, TMDB_PAR_MOVIES, async ([tmdbId, it]) => {
    let imdbId = null;
    try {
      imdbId = await tmdbMovieToImdb(tmdbId);
    } catch (e) {
      console.error("TMDb movie->IMDb error", tmdbId, e?.message || e);
      return null;
    }
    if (!imdbId) return null;

    let cz = null;
    try {
      cz = await tmdbCzMovieMeta(tmdbId);
    } catch (e) {
      console.error("TMDb CZ movie meta error", tmdbId, e?.message || e);
      cz = null;
    }

    const genres = splitGenres(it.groupTitle);
    const poster = tmdbPosterUrl(cz?.poster_path) || it.logo || undefined;
    const description = (cz?.overview || "").trim();
    const releaseInfo = yearFromDate(cz?.release_date);
    const runtime = (typeof cz?.runtime === "number" && cz.runtime > 0) ? `${cz.runtime} min` : undefined;
    const imdbRating = imdbRatingFromTmdb(cz?.vote_average);

    return {
      tmdbId,
      imdbId,
      name: it.titlePart || it.tvgName,
      poster,
      genres,
      description,
      releaseInfo,
      runtime,
      imdbRating
    };
  });

  // --- series resolve (IMDb + CZ text) ---
  const seriesEntries = [...seriesMap.entries()];
  const seriesResolved = await mapLimit(seriesEntries, TMDB_PAR_SERIES, async ([tmdbId, obj]) => {
    let imdbId = null;
    try {
      imdbId = await tmdbTvToImdb(tmdbId);
    } catch (e) {
      console.error("TMDb tv->IMDb error", tmdbId, e?.message || e);
      return null;
    }
    if (!imdbId) return null;

    const rawName = obj.item.titlePart || obj.item.tvgName || "";
    const cleanName = rawName.replace(/\sS\d{1,2}E\d{1,2}.*/i, "").trim();

    let cz = null;
    try {
      cz = await tmdbCzTvMeta(tmdbId);
    } catch (e) {
      console.error("TMDb CZ tv meta error", tmdbId, e?.message || e);
      cz = null;
    }

    const genres = splitGenres(obj.item.groupTitle);
    const poster = tmdbPosterUrl(cz?.poster_path) || obj.item.logo || undefined;
    const description = (cz?.overview || "").trim();
    const releaseInfo = yearFromDate(cz?.first_air_date);
    const run = (typeof cz?.episode_run_time === "number" && cz.episode_run_time > 0) ? `${cz.episode_run_time} min` : undefined;
    const imdbRating = imdbRatingFromTmdb(cz?.vote_average);

    return {
      tmdbId,
      imdbId,
      name: cleanName || rawName,
      poster,
      genres,
      description,
      releaseInfo,
      runtime: run,
      imdbRating,
      episodes: obj.episodes
    };
  });

  const movies = movieResolved.filter(Boolean);
  const series = seriesResolved.filter(Boolean);

  const byImdb = new Map();
  for (const m of movies) {
    byImdb.set(m.imdbId, {
      type: "movie",
      tmdbId: m.tmdbId,
      fallbackPoster: m.poster,
      fallbackName: m.name,
      genres: m.genres
    });
  }
  for (const s of series) {
    byImdb.set(s.imdbId, {
      type: "series",
      tmdbId: s.tmdbId,
      fallbackPoster: s.poster,
      fallbackName: s.name,
      genres: s.genres
    });
  }

  cache = {
    loadedAt: now,
    movies,
    series,
    byImdb,
    movieGenres: [...movieGenresSet].sort((a, b) => a.localeCompare(b, "cs")),
    seriesGenres: [...seriesGenresSet].sort((a, b) => a.localeCompare(b, "cs"))
  };

  console.log("MOVIES:", movies.length, "SERIES:", series.length);
}

// ------------------------------------------------------------
// Manifest (dynamic genre catalogs)
// ------------------------------------------------------------
function buildManifestWithGenres(movieGenres, seriesGenres) {
  const catalogs = [
    { type: "movie", id: "m3u-movies", name: "Moje filmy (M3U)", extra: [{ name: "refresh", options: ["0","1"] }] },
    { type: "series", id: "m3u-series", name: "Moje seriály (M3U)", extra: [{ name: "refresh", options: ["0","1"] }] }
  ];

  for (const g of movieGenres) {
    catalogs.push({
      type: "movie",
      id: `m3u-movies-g-${slugify(g)}`,
      name: `Filmy – ${g}`,
      extra: [{ name: "refresh", options: ["0","1"] }]
    });
  }

  for (const g of seriesGenres) {
    catalogs.push({
      type: "series",
      id: `m3u-series-g-${slugify(g)}`,
      name: `Seriály – ${g}`,
      extra: [{ name: "refresh", options: ["0","1"] }]
    });
  }

  return {
    id: "com.veronika.m3u.library",
    version: "0.7.0",
    name: "M3U Library (CZ descriptions + genres)",
    description: "Knihovna z M3U: tvg-id=TMDb -> IMDb. Popis v češtině z TMDb a žánry podle group-title (položka může být ve více žánrech).",
    resources: ["catalog", "meta"],
    types: ["movie", "series"],
    catalogs
  };
}

// ------------------------------------------------------------
// Start
// ------------------------------------------------------------
(async () => {
  try {
    await ensureCache(true);
  } catch (e) {
    console.error("Startup cache load failed:", e?.message || e);
    // i když selže, postavíme alespoň minimal manifest
    cache.movieGenres = [];
    cache.seriesGenres = [];
  }

  const manifest = buildManifestWithGenres(cache.movieGenres, cache.seriesGenres);
  const builder = new addonBuilder(manifest);

  builder.defineCatalogHandler(async ({ type, id, extra }) => {
    try {
      const force = extra?.refresh === "1";
      await ensureCache(force);

      const isMovie = type === "movie";
      const arr = isMovie ? cache.movies : cache.series;

      // all
      if ((isMovie && id === "m3u-movies") || (!isMovie && id === "m3u-series")) {
        return {
          metas: arr.map(x => ({
            id: x.imdbId,
            type,
            name: x.name,
            poster: x.poster,
            description: x.description || (x.genres?.length ? `Žánry: ${x.genres.join(", ")}` : undefined),
            genres: x.genres,
            releaseInfo: x.releaseInfo,
            runtime: x.runtime,
            imdbRating: x.imdbRating
          }))
        };
      }

      // genre catalogs
      const prefix = isMovie ? "m3u-movies-g-" : "m3u-series-g-";
      if (id.startsWith(prefix)) {
        const slug = id.slice(prefix.length);
        const filtered = arr.filter(x => (x.genres || []).some(g => slugify(g) === slug));

        return {
          metas: filtered.map(x => ({
            id: x.imdbId,
            type,
            name: x.name,
            poster: x.poster,
            description: x.description || (x.genres?.length ? `Žánry: ${x.genres.join(", ")}` : undefined),
            genres: x.genres,
            releaseInfo: x.releaseInfo,
            runtime: x.runtime,
            imdbRating: x.imdbRating
          }))
        };
      }

      return { metas: [] };
    } catch (e) {
      console.error("CATALOG ERROR:", e?.stack || e?.message || e);
      return { metas: [] };
    }
  });

  // meta handler – pro detail; v listu už máme description, ale necháme i meta (např. kdyby Stremio chtělo víc)
  builder.defineMetaHandler(async ({ type, id }) => {
    try {
      await ensureCache(false);

      const ref = cache.byImdb.get(id);
      if (!ref || ref.type !== type) return { meta: null };

      // najdi položku v cache, a vrať ji jako detail meta
      const item = (type === "movie" ? cache.movies : cache.series).find(x => x.imdbId === id);
      if (!item) {
        return {
          meta: {
            id,
            type,
            name: ref.fallbackName,
            poster: ref.fallbackPoster,
            genres: ref.genres
          }
        };
      }

      const meta = {
        id,
        type,
        name: item.name,
        poster: item.poster,
        description: item.description || undefined,
        genres: item.genres,
        releaseInfo: item.releaseInfo,
        runtime: item.runtime,
        imdbRating: item.imdbRating
      };

      return { meta };
    } catch (e) {
      console.error("META ERROR:", e?.stack || e?.message || e);
      return { meta: null };
    }
  });

  serveHTTP(builder.getInterface(), { port: PORT });
  console.log("Addon running on port:", PORT);
})();
