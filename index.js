process.on("uncaughtException", (err) => console.error("UNCAUGHT:", err));
process.on("unhandledRejection", (err) => console.error("UNHANDLED:", err));

const crypto = require("crypto");
const { addonBuilder, serveHTTP } = require("stremio-addon-sdk");

const fetchFn = global.fetch?.bind(global);
if (!fetchFn) {
  console.error("No global fetch available. Use Node 18+ runtime.");
  process.exit(1);
}

const PLAYLIST_URL = (process.env.PLAYLIST_URL || "").trim();
const TMDB_KEY = (process.env.TMDB_KEY || "").trim();
const PORT = process.env.PORT || 7000;

const PLAYLIST_REFRESH_SEC = parseInt(process.env.PLAYLIST_REFRESH_SEC || "300", 10); // default 5 min
const TMDB_PAR_MOVIES = parseInt(process.env.TMDB_PAR_MOVIES || "6", 10);
const TMDB_PAR_SERIES = parseInt(process.env.TMDB_PAR_SERIES || "4", 10);

// Play mode:
// - PLAY_NOW=1: vracíme jen 1 stream (autoplay)
// - PLAY_NOW=0: vracíme 2 streamy (menu)
const PLAY_NOW = (process.env.PLAY_NOW || "0").trim() === "1";

// Validace streamu (volitelné):
// - VALIDATE_STREAM=1: zkusí HEAD (a fallback GET Range) s timeoutem, když fail -> nevrátí stream
const VALIDATE_STREAM = (process.env.VALIDATE_STREAM || "0").trim() === "1";
const STREAM_CHECK_TIMEOUT_MS = parseInt(process.env.STREAM_CHECK_TIMEOUT_MS || "2000", 10);

// ------------------------------------------------------------
// helpers
// ------------------------------------------------------------
function makeM3uId(type, title, extra = "") {
  const base = `${type}|${(title || "").trim()}|${extra}`.toLowerCase();
  const h = crypto.createHash("sha1").update(base).digest("hex").slice(0, 16);
  return `m3u:${type}:${h}`;
}

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

function hasStarGenre(genres) {
  return (genres || []).some(g => g.trim().startsWith("★"));
}

// ★ žánry až na konec dropdownu katalogů
const genreSort = (a, b) => {
  const aStar = a.trim().startsWith("★");
  const bStar = b.trim().startsWith("★");
  if (aStar && !bStar) return 1;
  if (!aStar && bStar) return -1;
  return a.localeCompare(b, "cs");
};

// playlist order, ale ★ položky až na konec (pořadí uvnitř zachováno)
function sortByPlaylistThenStarLast(a, b) {
  const aStar = hasStarGenre(a.genres);
  const bStar = hasStarGenre(b.genres);
  if (aStar && !bStar) return 1;
  if (!aStar && bStar) return -1;
  return (a.order ?? 999999999) - (b.order ?? 999999999);
}

function isHttpsUrl(u) {
  return typeof u === "string" && /^https:\/\//i.test(u.trim());
}

function yearFromTitle(text) {
  const m = (text || "").match(/\((19|20)\d{2}\)/);
  return m ? m[0].replace(/[()]/g, "") : "";
}

// Epizodní ID může mít v base části dvojtečky (m3u:series:xxxx)
// => vezmeme poslední 2 segmenty jako season/episode
function parseEpisodeId(id) {
  const parts = String(id || "").split(":");
  if (parts.length < 3) return null;
  const epStr = parts[parts.length - 1];
  const seStr = parts[parts.length - 2];
  const base = parts.slice(0, parts.length - 2).join(":");

  const s = parseInt(seStr, 10);
  const e = parseInt(epStr, 10);
  if (!base || !Number.isFinite(s) || !Number.isFinite(e)) return null;
  return { baseId: base, s, e, key: `${s}-${e}` };
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

// Parse M3U: EXTINF + následující URL řádek
function parseM3U(m3uText) {
  const lines = m3uText.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const items = [];
  let order = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.toUpperCase().startsWith("#EXTINF")) continue;

    let url = "";
    for (let j = i + 1; j < lines.length; j++) {
      const nxt = lines[j];
      if (!nxt) continue;
      if (nxt.startsWith("#")) continue;
      url = nxt;
      break;
    }

    const tvgId = getAttr(line, "tvg-id") || ""; // TMDb id (nebo prázdné)
    const tvgName = getAttr(line, "tvg-name") || "";
    const tvgType = (getAttr(line, "tvg-type") || "").toLowerCase().trim(); // movie / tv
    const logo = getAttr(line, "tvg-logo") || "";
    const groupTitle = getAttr(line, "group-title") || "";
    const titlePart = line.includes(",") ? line.split(",").slice(1).join(",").trim() : tvgName;

    items.push({ tvgId, tvgName, tvgType, logo, groupTitle, titlePart, url, order: order++ });
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
// TMDb helpers (volitelné)
// ------------------------------------------------------------
const tmdbToImdbMem = new Map();   // movie:ID / tv:ID -> tt...|null
const tmdbCzMetaMem = new Map();   // movie:ID / tv:ID -> cached cs-CZ meta

function haveTmdb() {
  return Boolean(TMDB_KEY);
}
function isNumericId(x) {
  return /^\d+$/.test(String(x || "").trim());
}

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
  if (typeof voteAverage !== "number") return null;
  const r = Math.round(voteAverage * 1000) / 1000;
  if (!isFinite(r) || r <= 0) return null;
  return r;
}

// ------------------------------------------------------------
// stream validity check (optional)
// ------------------------------------------------------------
async function isStreamProbablyOk(url) {
  if (!VALIDATE_STREAM) return true;
  if (!isHttpsUrl(url)) return false;

  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), STREAM_CHECK_TIMEOUT_MS);

  try {
    const res = await fetchFn(url, {
      method: "HEAD",
      redirect: "follow",
      signal: ctrl.signal,
      headers: { "User-Agent": "Mozilla/5.0 (StremioM3UAddon)" }
    });
    if (res.ok) return true;

    const ctrl2 = new AbortController();
    const t2 = setTimeout(() => ctrl2.abort(), STREAM_CHECK_TIMEOUT_MS);
    try {
      const res2 = await fetchFn(url, {
        method: "GET",
        redirect: "follow",
        signal: ctrl2.signal,
        headers: {
          "User-Agent": "Mozilla/5.0 (StremioM3UAddon)",
          "Range": "bytes=0-0"
        }
      });
      return res2.ok;
    } finally {
      clearTimeout(t2);
    }
  } catch {
    return false;
  } finally {
    clearTimeout(t);
  }
}

// ------------------------------------------------------------
// cache
// ------------------------------------------------------------
let cache = {
  loadedAt: 0,

  // items:
  // movie: { id, imdbId?, tmdbId?, name, poster, genres[], description, releaseInfo, runtime, imdbRating, order, url }
  // series:{ id, imdbId?, tmdbId?, name, poster, genres[], description, releaseInfo, runtime, imdbRating, episodes:Set, order, epUrl:Map }
  movies: [],
  series: [],

  // stream maps:
  movieUrlById: new Map(),         // id -> https url
  episodeUrlById: new Map(),       // baseId -> Map("s-e" -> https url)

  // for meta lookup:
  byId: new Map(),                 // id -> { type, tmdbId?, imdbId? }

  movieGenres: [],
  seriesGenres: []
};

async function ensureCache(forceReload = false) {
  if (!PLAYLIST_URL) throw new Error("Missing env PLAYLIST_URL");

  const now = Date.now();
  const ttlMs = Math.max(10, PLAYLIST_REFRESH_SEC) * 1000;

  if (!forceReload && now - cache.loadedAt < ttlMs && (cache.movies.length || cache.series.length)) return;

  const m3u = await fetchText(PLAYLIST_URL);
  const extinfCount = (m3u.match(/#EXTINF/gi) || []).length;
  console.log("PLAYLIST #EXTINF count:", extinfCount);
  if (extinfCount === 0) throw new Error("No #EXTINF found (wrong link / HTML).");

  const items = parseM3U(m3u);

  // Zachováme pořadí prvního výskytu
  const moviesFirst = new Map(); // key -> first item
  const seriesAgg = new Map();   // key -> { firstItem, episodes:Set, epUrl:Map }
  const movieGenresSet = new Set();
  const seriesGenresSet = new Set();

  for (const it of items) {
    const t = (it.tvgType || "").toLowerCase();

    if (t === "movie") {
      const key = (haveTmdb() && isNumericId(it.tvgId)) ? `tmdb:${it.tvgId}` : `m3u:${it.titlePart || it.tvgName}`;
      if (!moviesFirst.has(key)) moviesFirst.set(key, it);

      for (const g of splitGenres(it.groupTitle)) movieGenresSet.add(g);
      continue;
    }

    if (t === "tv" || t === "series" || t === "tvshow" || t === "show") {
      const se = parseSxxEyy(it.tvgName) || parseSxxEyy(it.titlePart);
      if (!se) continue;

      // klíč seriálu: TMDb pokud jde, jinak podle názvu (bez SxxEyy)
      const rawName = it.titlePart || it.tvgName || "";
      const cleanName = rawName.replace(/\sS\d{1,2}E\d{1,2}.*/i, "").trim();

      const key = (haveTmdb() && isNumericId(it.tvgId)) ? `tmdb:${it.tvgId}` : `m3u:${cleanName || rawName}`;
      if (!seriesAgg.has(key)) seriesAgg.set(key, { firstItem: it, episodes: new Set(), epUrl: new Map(), cleanName });

      const obj = seriesAgg.get(key);
      obj.episodes.add(`${se.s}-${se.e}`);
      if (isHttpsUrl(it.url)) obj.epUrl.set(`${se.s}-${se.e}`, it.url);

      for (const g of splitGenres(it.groupTitle)) seriesGenresSet.add(g);
    }
  }

  console.log("MOVIES candidates:", moviesFirst.size);
  console.log("SERIES candidates:", seriesAgg.size);

  // --- resolve movies ---
  const movieEntries = [...moviesFirst.entries()];
  const movieResolved = await mapLimit(movieEntries, TMDB_PAR_MOVIES, async ([key, it]) => {
    const name = it.titlePart || it.tvgName;
    const genres = splitGenres(it.groupTitle);
    const fallbackId = makeM3uId("movie", name);

    let tmdbId = null;
    let imdbId = null;
    let description = "";
    let releaseInfo = yearFromTitle(name);
    let runtime = undefined;
    let imdbRating = null;
    let poster = it.logo || undefined;

    if (haveTmdb() && isNumericId(it.tvgId)) {
      tmdbId = String(it.tvgId);

      try {
        imdbId = await tmdbMovieToImdb(tmdbId);
      } catch (e) {
        console.error("TMDb movie->IMDb error", tmdbId, e?.message || e);
        imdbId = null;
      }

      try {
        const cz = await tmdbCzMovieMeta(tmdbId);
        if (cz?.overview) description = cz.overview;
        const p = tmdbPosterUrl(cz?.poster_path);
        if (p) poster = p;
        const y = yearFromDate(cz?.release_date);
        if (y) releaseInfo = y;
        if (typeof cz?.runtime === "number" && cz.runtime > 0) runtime = `${cz.runtime} min`;
        imdbRating = imdbRatingFromTmdb(cz?.vote_average);
      } catch (e) {
        console.error("TMDb CZ movie meta error", tmdbId, e?.message || e);
      }
    }

    const id = imdbId || fallbackId;

    return {
      id,
      imdbId: imdbId || undefined,
      tmdbId: tmdbId || undefined,
      name,
      poster,
      genres,
      description,
      releaseInfo,
      runtime,
      imdbRating,
      order: it.order,
      url: isHttpsUrl(it.url) ? it.url : ""
    };
  });

  // --- resolve series ---
  const seriesEntries = [...seriesAgg.entries()];
  const seriesResolved = await mapLimit(seriesEntries, TMDB_PAR_SERIES, async ([key, obj]) => {
    const it = obj.firstItem;
    const rawName = it.titlePart || it.tvgName || "";
    const cleanName = obj.cleanName || rawName.replace(/\sS\d{1,2}E\d{1,2}.*/i, "").trim();
    const genres = splitGenres(it.groupTitle);

    const fallbackId = makeM3uId("series", cleanName || rawName);
    let tmdbId = null;
    let imdbId = null;
    let description = "";
    let releaseInfo = yearFromTitle(cleanName || rawName);
    let runtime = undefined;
    let imdbRating = null;
    let poster = it.logo || undefined;

    if (haveTmdb() && isNumericId(it.tvgId)) {
      tmdbId = String(it.tvgId);

      try {
        imdbId = await tmdbTvToImdb(tmdbId);
      } catch (e) {
        console.error("TMDb tv->IMDb error", tmdbId, e?.message || e);
        imdbId = null;
      }

      try {
        const cz = await tmdbCzTvMeta(tmdbId);
        if (cz?.overview) description = cz.overview;
        const p = tmdbPosterUrl(cz?.poster_path);
        if (p) poster = p;
        const y = yearFromDate(cz?.first_air_date);
        if (y) releaseInfo = y;
        if (typeof cz?.episode_run_time === "number" && cz.episode_run_time > 0) runtime = `${cz.episode_run_time} min`;
        imdbRating = imdbRatingFromTmdb(cz?.vote_average);
      } catch (e) {
        console.error("TMDb CZ tv meta error", tmdbId, e?.message || e);
      }
    }

    const id = imdbId || fallbackId;

    return {
      id,
      imdbId: imdbId || undefined,
      tmdbId: tmdbId || undefined,
      name: cleanName || rawName,
      poster,
      genres,
      description,
      releaseInfo,
      runtime,
      imdbRating,
      episodes: obj.episodes,
      order: it.order,
      epUrl: obj.epUrl
    };
  });

  const movies = movieResolved.filter(Boolean);
  const series = seriesResolved.filter(Boolean);

  // maps for streams + meta lookup
  const movieUrlById = new Map();
  const episodeUrlById = new Map();
  const byId = new Map();

  for (const m of movies) {
    byId.set(m.id, { type: "movie", tmdbId: m.tmdbId, imdbId: m.imdbId });
    if (isHttpsUrl(m.url)) movieUrlById.set(m.id, m.url);
  }
  for (const s of series) {
    byId.set(s.id, { type: "series", tmdbId: s.tmdbId, imdbId: s.imdbId });
    episodeUrlById.set(s.id, s.epUrl || new Map());
  }

  cache = {
    loadedAt: now,
    movies,
    series,
    movieUrlById,
    episodeUrlById,
    byId,
    movieGenres: [...movieGenresSet].sort(genreSort),
    seriesGenres: [...seriesGenresSet].sort(genreSort)
  };

  console.log("MOVIES:", movies.length, "SERIES:", series.length);
}

// ------------------------------------------------------------
// Manifest
// ------------------------------------------------------------
function buildManifestWithGenres(movieGenres, seriesGenres) {
  const catalogs = [
    { type: "movie", id: "m3u-movies", name: "CINEMA CITY filmy", extra: [{ name: "refresh", options: ["0","1"] }] },
    { type: "series", id: "m3u-series", name: "CINEMA CITY seriály", extra: [{ name: "refresh", options: ["0","1"] }] }
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
    version: "1.1.4",
    name: "CINEMA CITY",
    description: "Funguje i bez TMDb ID: použije interní m3u:* ID. Streamy z playlistu. Řazení dle pořadí v playlistu.",
    resources: ["catalog", "meta", "stream"],
    types: ["movie", "series"],
    catalogs
  };
}

function metaFromItem(type, x) {
  return {
    id: x.id,
    type,
    name: x.name,
    poster: x.poster,
    description: (x.description || "").trim() || (x.genres?.length ? `Žánry: ${x.genres.join(", ")}` : undefined),
    genres: x.genres,
    releaseInfo: x.releaseInfo,
    runtime: x.runtime,
    imdbRating: x.imdbRating
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
      const baseArr = isMovie ? cache.movies : cache.series;

      // ALL: playlist order (★ last)
      if ((isMovie && id === "m3u-movies") || (!isMovie && id === "m3u-series")) {
        const sorted = [...baseArr].sort(sortByPlaylistThenStarLast);
        return { metas: sorted.map(x => metaFromItem(type, x)) };
      }

      // GENRE: filtr + playlist order
      const prefix = isMovie ? "m3u-movies-g-" : "m3u-series-g-";
      if (id.startsWith(prefix)) {
        const slug = id.slice(prefix.length);
        const filtered = baseArr
          .filter(x => (x.genres || []).some(g => slugify(g) === slug))
          .sort((a, b) => (a.order ?? 999999999) - (b.order ?? 999999999));

        return { metas: filtered.map(x => metaFromItem(type, x)) };
      }

      return { metas: [] };
    } catch (e) {
      console.error("CATALOG ERROR:", e?.stack || e?.message || e);
      return { metas: [] };
    }
  });

  // META: pro series vracíme videos => epizody se zobrazí
  builder.defineMetaHandler(async ({ type, id }) => {
    try {
      await ensureCache(false);

      if (type === "movie") {
        const item = cache.movies.find(x => x.id === id);
        if (!item) return { meta: null };
        return { meta: metaFromItem("movie", item) };
      }

      if (type === "series") {
        const item = cache.series.find(x => x.id === id);
        if (!item) return { meta: null };

        const videos = [];
        for (const key of item.episodes || []) {
          const [sStr, eStr] = String(key).split("-");
          const s = parseInt(sStr, 10);
          const e = parseInt(eStr, 10);
          if (!Number.isFinite(s) || !Number.isFinite(e)) continue;

          videos.push({
            id: `${item.id}:${s}:${e}`,
            title: `S${String(s).padStart(2, "0")}E${String(e).padStart(2, "0")}`,
            season: s,
            episode: e
          });
        }

        // seřadit epizody (pro jistotu)
        videos.sort((a, b) => (a.season - b.season) || (a.episode - b.episode));

        return {
          meta: {
            ...metaFromItem("series", item),
            videos
          }
        };
      }

      return { meta: null };
    } catch (e) {
      console.error("META ERROR:", e?.stack || e?.message || e);
      return { meta: null };
    }
  });

  // STREAM handler: přehrává vlastní https URL z playlistu
  builder.defineStreamHandler(async ({ type, id }) => {
    try {
      await ensureCache(false);

      if (type === "movie") {
        const url = cache.movieUrlById.get(id);
        if (!isHttpsUrl(url)) return { streams: [] };

        const ok = await isStreamProbablyOk(url);
        if (!ok) return { streams: [] };

        if (PLAY_NOW) return { streams: [{ name: "▶ Přehrát můj stream", url }] };

        return {
          streams: [
            { name: "▶ Přehrát můj stream", url },
          ]
        };
      }

      if (type === "series") {
        const ep = parseEpisodeId(id);
        if (!ep) return { streams: [] };

        const epMap = cache.episodeUrlById.get(ep.baseId);
        const url = epMap ? epMap.get(ep.key) : "";
        if (!isHttpsUrl(url)) return { streams: [] };

        const ok = await isStreamProbablyOk(url);
        if (!ok) return { streams: [] };

        const label = `S${String(ep.s).padStart(2, "0")}E${String(ep.e).padStart(2, "0")}`;

        if (PLAY_NOW) return { streams: [{ name: `▶ Můj stream (${label})`, url }] };

        return {
          streams: [
            { name: `▶ Přehrát můj stream (${label})`, url },
          ]
        };
      }

      return { streams: [] };
    } catch (e) {
      console.error("STREAM ERROR:", e?.stack || e?.message || e);
      return { streams: [] };
    }
  });

  serveHTTP(builder.getInterface(), { port: PORT });
  console.log("Addon running on port:", PORT, "| PLAY_NOW:", PLAY_NOW, "| VALIDATE_STREAM:", VALIDATE_STREAM, "| TMDb:", haveTmdb());
})();
