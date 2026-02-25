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
const PLAYLIST_REFRESH_SEC = parseInt(process.env.PLAYLIST_REFRESH_SEC || "120", 10); // 2 min

// --- helpers
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

    const tvgId = getAttr(line, "tvg-id") || "";                // TMDb id
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

// --- TMDb helpers (IMDb + CZ overview)
const tmdbToImdbMem = new Map();   // movie:ID / tv:ID -> tt...|null
const tmdbCzMetaMem = new Map();   // movie:ID / tv:ID -> { overview, poster_path, name/title } (cs-CZ)

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
    overview: data.overview || "",
    poster_path: data.poster_path || "",
    title: data.title || data.original_title || ""
  };
  tmdbCzMetaMem.set(key, out);
  return out;
}

async function tmdbCzTvMeta(tmdbId) {
  const key = `tv:${tmdbId}`;
  if (tmdbCzMetaMem.has(key)) return tmdbCzMetaMem.get(key);

  const data = await tmdbJson(`https://api.themoviedb.org/3/tv/${tmdbId}?api_key=${TMDB_KEY}&language=cs-CZ`);
  const out = {
    overview: data.overview || "",
    poster_path: data.poster_path || "",
    title: data.name || data.original_name || ""
  };
  tmdbCzMetaMem.set(key, out);
  return out;
}

// --- cache
let cache = {
  loadedAt: 0,
  movies: [], // { tmdbId, imdbId, name, poster, groupTitle }
  series: [], // { tmdbId, imdbId, name, poster, groupTitle, episodes:Set }
  byImdb: new Map(), // tt.. -> { type, tmdbId, fallbackPoster, fallbackName, groupTitle }
  movieGroups: [],   // list of group names
  seriesGroups: []
};

function splitGenres(groupTitle) {
  // rozdělí "Drama/Krimi/Thriller" -> ["Drama","Krimi","Thriller"]
  // tolerantní i na další oddělovače
  const raw = (groupTitle || "")
    .split(/[\/|,]+/g)
    .map(s => s.trim())
    .filter(Boolean);

  // odduplikuj při zachování pořadí
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
  const movieGroupsSet = new Set();
  const seriesGroupsSet = new Set();

  for (const it of items) {
    const t = (it.tvgType || "").toLowerCase();

    if (t === "movie") {
      if (it.tvgId) moviesMap.set(it.tvgId, it);
      for (const g of splitGenres(it.groupTitle)) movieGroupsSet.add(g);
      continue;
    }

    if (t === "tv" || t === "series" || t === "tvshow" || t === "show") {
      const se = parseSxxEyy(it.tvgName) || parseSxxEyy(it.titlePart);
      if (!se) continue;
      if (!it.tvgId) continue;

      if (!seriesMap.has(it.tvgId)) seriesMap.set(it.tvgId, { item: it, episodes: new Set() });
      seriesMap.get(it.tvgId).episodes.add(`${se.s}-${se.e}`);

      for (const g of splitGenres(it.groupTitle)) seriesGroupsSet.add(g);
    }
  }

  const movieEntries = [...moviesMap.entries()];
  const movieResolved = await mapLimit(movieEntries, 6, async ([tmdbId, it]) => {
    const imdbId = await tmdbMovieToImdb(tmdbId);
    if (!imdbId) return null;
    return {
	  tmdbId,
	  imdbId,
	  name: it.titlePart || it.tvgName,
	  poster: it.logo || undefined,
	  genres: splitGenres(it.groupTitle)
	};
  });

  const seriesEntries = [...seriesMap.entries()];
  const seriesResolved = await mapLimit(seriesEntries, 4, async ([tmdbId, obj]) => {
    const imdbId = await tmdbTvToImdb(tmdbId);
    if (!imdbId) return null;

    const rawName = obj.item.titlePart || obj.item.tvgName || "";
    const cleanName = rawName.replace(/\sS\d{1,2}E\d{1,2}.*/i, "").trim();

    return {
	  tmdbId,
	  imdbId,
	  name: cleanName || rawName,
	  poster: obj.item.logo || undefined,
	  genres: splitGenres(obj.item.groupTitle),
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
	  genres: m.genres,
	  groupTitle: (m.genres || []).join("/") // nebo m.groupTitle pokud ho máš zvlášť
	});
  }
  for (const s of series) {
    byImdb.set(s.imdbId, {
	  type: "series",
	  tmdbId: s.tmdbId,
	  fallbackPoster: s.poster,
	  fallbackName: s.name,
	  genres: s.genres,
	  groupTitle: (s.genres || []).join("/")
	});
  }

  cache = {
    loadedAt: now,
    movies,
    series,
    byImdb,
    movieGroups: [...movieGroupsSet].sort((a,b)=>a.localeCompare(b, "cs")),
    seriesGroups: [...seriesGroupsSet].sort((a,b)=>a.localeCompare(b, "cs"))
  };

  console.log("MOVIES:", movies.length, "SERIES:", series.length);
}

// ---------------- dynamic catalogs by group-title (built at startup + refresh cache)
function buildManifestWithGroups(movieGroups, seriesGroups) {
  const catalogs = [
    { type: "movie", id: "m3u-movies", name: "Moje filmy (M3U)", extra: [{ name: "refresh", options: ["0","1"] }] },
    { type: "series", id: "m3u-series", name: "Moje seriály (M3U)", extra: [{ name: "refresh", options: ["0","1"] }] }
  ];

  for (const g of movieGroups) {
    catalogs.push({
      type: "movie",
      id: `m3u-movies-g-${slugify(g)}`,
      name: `Filmy – ${g}`,
      extra: [{ name: "refresh", options: ["0","1"] }]
    });
  }

  for (const g of seriesGroups) {
    catalogs.push({
      type: "series",
      id: `m3u-series-g-${slugify(g)}`,
      name: `Seriály – ${g}`,
      extra: [{ name: "refresh", options: ["0","1"] }]
    });
  }

  return {
    id: "com.veronika.m3u.library",
    version: "0.6.0",
    name: "M3U Library (Genres + CZ TMDb plot)",
    description: "Katalogy podle group-title + české popisy z TMDb. ID = IMDb pro vyhledávání zdrojů.",
    resources: ["catalog", "meta"],
    types: ["movie", "series"],
    catalogs
  };
}

// 1) načti cache jednou na start, a podle toho postav manifest
(async () => {
  try {
    await ensureCache(true);
  } catch (e) {
    console.error("Startup cache load failed:", e?.message || e);
  }

  const manifest = buildManifestWithGroups(cache.movieGroups, cache.seriesGroups);
  const builder = new addonBuilder(manifest);

  // --- catalog handler (all + by group)
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
            poster: x.poster
          }))
        };
      }

      // group catalogs
      const prefix = isMovie ? "m3u-movies-g-" : "m3u-series-g-";
      if (id.startsWith(prefix)) {
        const slug = id.slice(prefix.length);
        const filtered = arr.filter(x => (x.genres || []).some(g => slugify(g) === slug));

        return {
          metas: filtered.map(x => ({
            id: x.imdbId,
            type,
            name: x.name,
            poster: x.poster
          }))
        };
      }

      return { metas: [] };
    } catch (e) {
      console.error("CATALOG ERROR:", e?.stack || e?.message || e);
      return { metas: [] };
    }
  });

  // --- meta handler: český popis z TMDb (cs-CZ)
  builder.defineMetaHandler(async ({ type, id }) => {
    try {
      await ensureCache(false);

      const ref = cache.byImdb.get(id);
      if (!ref || ref.type !== type) return { meta: null };

      let cz = null;
      try {
        cz = type === "movie" ? await tmdbCzMovieMeta(ref.tmdbId) : await tmdbCzTvMeta(ref.tmdbId);
      } catch (e) {
        console.error("TMDb CZ meta error:", ref.tmdbId, e?.message || e);
      }

      const posterFromTmdb = cz?.poster_path ? `https://image.tmdb.org/t/p/w500${cz.poster_path}` : null;

      const meta = {
        id,
        type,
        name: ref.fallbackName, // necháváme tvůj název z playlistu
        poster: posterFromTmdb || ref.fallbackPoster,
        description: (cz?.overview || "").trim() || (ref.groupTitle ? `Skupina: ${ref.groupTitle}` : undefined)
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
