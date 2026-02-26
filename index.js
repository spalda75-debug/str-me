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

const PLAYLIST_REFRESH_SEC = parseInt(process.env.PLAYLIST_REFRESH_SEC || "300", 10);
const TMDB_PAR_MOVIES = parseInt(process.env.TMDB_PAR_MOVIES || "6", 10);
const TMDB_PAR_SERIES = parseInt(process.env.TMDB_PAR_SERIES || "4", 10);

// Play mode:
// - PLAY_NOW=1: vracíme jen 1 stream (autoplay)
// - PLAY_NOW=0: vracíme 2 streamy (menu)
const PLAY_NOW = (process.env.PLAY_NOW || "0").trim() === "1";

// Validace streamu:
// - VALIDATE_STREAM=1: zkusí HEAD s timeoutem (když fail -> nevrátí náš stream)
const VALIDATE_STREAM = (process.env.VALIDATE_STREAM || "0").trim() === "1";
const STREAM_CHECK_TIMEOUT_MS = parseInt(process.env.STREAM_CHECK_TIMEOUT_MS || "2000", 10);

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

// playlist order, ale ★ až na konec (pořadí uvnitř zachováno)
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

// Parse M3U: čteme EXTINF + hned následující URL řádek
function parseM3U(m3uText) {
  const lines = m3uText.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const items = [];
  let order = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.toUpperCase().startsWith("#EXTINF")) continue;

    // najdi URL na nejbližším dalším řádku, který není comment
    let url = "";
    for (let j = i + 1; j < lines.length; j++) {
      const nxt = lines[j];
      if (!nxt) continue;
      if (nxt.startsWith("#")) continue;
      url = nxt;
      break;
    }

    const tvgId = getAttr(line, "tvg-id") || ""; // TMDb id
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
// TMDb helpers (IMDb + cs-CZ meta)
// ------------------------------------------------------------
const tmdbToImdbMem = new Map();
const tmdbCzMetaMem = new Map();

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

    // některé CDN HEAD nepovolí → fallback na GET s Range
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
  } catch (e) {
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

  movies: [],  // { imdbId, ... , url, order }
  series: [],  // { imdbId, ... , episodes:Set, order }

  // stream maps:
  movieUrlByImdb: new Map(),            // imdbId -> https url
  episodeUrlByImdb: new Map(),          // imdbId -> Map("s-e" -> https url)

  byImdb: new Map(),                    // imdbId -> { type, tmdbId }

  movieGenres: [],
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

  const moviesMap = new Map(); // tmdbId -> first item
  const seriesMap = new Map(); // tmdbId -> { item(first), episodes:Set, epUrl:Map }
  const movieGenresSet = new Set();
  const seriesGenresSet = new Set();

  // build URL maps from playlist order
  for (const it of items) {
    const t = (it.tvgType || "").toLowerCase();

    if (t === "movie") {
      if (it.tvgId && !moviesMap.has(it.tvgId)) moviesMap.set(it.tvgId, it);
      for (const g of splitGenres(it.groupTitle)) movieGenresSet.add(g);
      continue;
    }

    if (t === "tv" || t === "series" || t === "tvshow" || t === "show") {
      const se = parseSxxEyy(it.tvgName) || parseSxxEyy(it.titlePart);
      if (!se) continue;
      if (!it.tvgId) continue;

      if (!seriesMap.has(it.tvgId)) {
        seriesMap.set(it.tvgId, { item: it, episodes: new Set(), epUrl: new Map() });
      }
      const obj = seriesMap.get(it.tvgId);
      obj.episodes.add(`${se.s}-${se.e}`);
      if (isHttpsUrl(it.url)) obj.epUrl.set(`${se.s}-${se.e}`, it.url);

      for (const g of splitGenres(it.groupTitle)) seriesGenresSet.add(g);
    }
  }

  console.log("MOVIES candidates:", moviesMap.size);
  console.log("SERIES candidates:", seriesMap.size);

  // --- resolve movies (tmdb -> imdb + cz meta) ---
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
      imdbRating,
      order: it.order,
      url: isHttpsUrl(it.url) ? it.url : ""
    };
  });

  // --- resolve series (tmdb -> imdb + cz meta) ---
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
      episodes: obj.episodes,
      order: obj.item.order,
      epUrl: obj.epUrl // Map("s-e" -> url)
    };
  });

  const movies = movieResolved.filter(Boolean);
  const series = seriesResolved.filter(Boolean);

  const byImdb = new Map();
  const movieUrlByImdb = new Map();
  const episodeUrlByImdb = new Map();

  for (const m of movies) {
    byImdb.set(m.imdbId, { type: "movie", tmdbId: m.tmdbId });
    if (isHttpsUrl(m.url)) movieUrlByImdb.set(m.imdbId, m.url);
  }

  for (const s of series) {
    byImdb.set(s.imdbId, { type: "series", tmdbId: s.tmdbId });
    episodeUrlByImdb.set(s.imdbId, s.epUrl || new Map());
  }

  cache = {
    loadedAt: now,
    movies,
    series,
    byImdb,
    movieUrlByImdb,
    episodeUrlByImdb,
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
    { type: "movie", id: "m3u-movies", name: "CINEMA CITY", extra: [{ name: "refresh", options: ["0","1"] }] },
    { type: "series", id: "m3u-series", name: "CINEMA CITY", extra: [{ name: "refresh", options: ["0","1"] }] }
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
    version: "0.9.3",
    name: "M3U Library (CZ + genres + playlist order)",
    description: "Řazení v Moje filmy/seriály podle pořadí v playlistu (★ až na konec, ale pořadí zachováno).",
    logo: "https://www.dropbox.com/scl/fi/yzuy7sncr5gn5zm82yk36/icon.png?rlkey=pw0hfdjmh2p6b3vncwzn1b7e3&st=14riba9f&dl=1",
    // background: "https://www.dropbox.com/scl/fi/TVUJ_ID/bg.png?rlkey=TVUJ_KEY&dl=1",
    resources: ["catalog", "meta", "stream"],
    types: ["movie", "series"],
    catalogs
  };
}

function metaFromItem(type, x) {
  return {
    id: x.imdbId,
    type,
    name: x.name,
    poster: x.poster,
    description: x.description || (x.genres?.length ? `Žánry: ${x.genres.join(", ")}` : undefined),
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

      if ((isMovie && id === "m3u-movies") || (!isMovie && id === "m3u-series")) {
        const sorted = [...baseArr].sort(sortByPlaylistThenStarLast);
        return { metas: sorted.map(x => metaFromItem(type, x)) };
      }

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

  builder.defineMetaHandler(async ({ type, id }) => {
  try {
    await ensureCache(false);

    if (type === "movie") {
      const item = cache.movies.find(x => x.imdbId === id);
      if (!item) return { meta: null };
      return { meta: metaFromItem("movie", item) };
    }

    if (type === "series") {
      const item = cache.series.find(x => x.imdbId === id);
      if (!item) return { meta: null };

      const videos = [];

      for (const key of item.episodes) {
        const [s, e] = key.split("-").map(n => parseInt(n, 10));

        videos.push({
          id: `${id}:${s}:${e}`,
          title: `S${String(s).padStart(2,"0")}E${String(e).padStart(2,"0")}`,
          season: s,
          episode: e
        });
      }

      return {
        meta: {
          ...metaFromItem("series", item),
          videos
        }
      };
    }

    return { meta: null };

  } catch (e) {
    console.error("META ERROR:", e);
    return { meta: null };
  }
});

  // STREAM handler
  builder.defineStreamHandler(async ({ type, id }) => {
    try {
      await ensureCache(false);

      // MOVIE: id = tt....
      if (type === "movie") {
        const url = cache.movieUrlByImdb.get(id);
        if (!isHttpsUrl(url)) return { streams: [] };

        const ok = await isStreamProbablyOk(url);
        if (!ok) return { streams: [] };

        if (PLAY_NOW) {
          return { streams: [{ name: "▶ Přehrát můj stream", url }] };
        }
        return {
          streams: [
            { name: "▶ Přehrát můj stream", url },
          ]
        };
      }

      // SERIES: id může být "tt1234567:1:5" (season/episode)
      if (type === "series") {
        const m = String(id).match(/^(tt\d+):(\d+):(\d+)$/i);
        if (!m) {
          // pokud Stremio požádá o stream pro show-level (bez epizody), nic nevracíme
          return { streams: [] };
        }
        const baseImdb = m[1];
        const s = parseInt(m[2], 10);
        const e = parseInt(m[3], 10);
        const key = `${s}-${e}`;

        const epMap = cache.episodeUrlByImdb.get(baseImdb);
        const url = epMap ? epMap.get(key) : "";

        if (!isHttpsUrl(url)) return { streams: [] };

        const ok = await isStreamProbablyOk(url);
        if (!ok) return { streams: [] };

        const label = `S${String(s).padStart(2, "0")}E${String(e).padStart(2, "0")}`;

        if (PLAY_NOW) {
          return { streams: [{ title: `▶ Můj stream (${label})`, url }] };
        }
        return {
          streams: [
            { title: `▶ Přehrát můj stream (${label})`, url },
            { title: "📌 (Tip) Pokud nechceš můj stream, vyber jiný addon ve zdrojích", url }
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
  console.log("Addon running on port:", PORT, "| PLAY_NOW:", PLAY_NOW, "| VALIDATE_STREAM:", VALIDATE_STREAM);
})();
