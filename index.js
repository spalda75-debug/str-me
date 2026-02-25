// index.js (no-TMDb version)
process.on("uncaughtException", (err) => console.error("UNCAUGHT:", err));
process.on("unhandledRejection", (err) => console.error("UNHANDLED:", err));

const { addonBuilder, serveHTTP } = require("stremio-addon-sdk");

const fetchFn = global.fetch ? global.fetch.bind(global) : null;

const PLAYLIST_URL = process.env.PLAYLIST_URL; // Dropbox link (ideálně ...&dl=1)
const PORT = process.env.PORT || 7000;

if (!fetchFn) {
  console.error("This Node runtime has no global fetch. Use Node 18+ or add a fetch polyfill.");
  process.exit(1);
}

const manifest = {
  id: "com.veronika.m3u.library",
  version: "0.3.0",
  name: "M3U Library (no TMDb)",
  description: "Knihovna z M3U. Bez TMDb/IMDb. (Volitelně umí přehrát přímo URL z playlistu.)",
  resources: ["catalog", "meta", "stream"],
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
  movies: [],          // metas for catalog
  series: [],          // metas for catalog
  byId: new Map(),     // id -> meta
  streamsById: new Map() // id -> [{ url, name }]
};

async function fetchText(url) {
  const res = await fetchFn(url, { redirect: "follow" });
  const text = await res.text();

  console.log("PLAYLIST HTTP:", res.status, res.headers.get("content-type"));
  console.log("PLAYLIST HEAD:", JSON.stringify(text.slice(0, 200)));

  if (!res.ok) throw new Error(`PLAYLIST HTTP ${res.status}`);
  return text;
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

function parseM3U(m3uText) {
  const lines = m3uText.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const entries = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.toUpperCase().startsWith("#EXTINF")) continue;

    const tvgId = getAttr(line, "tvg-id") || "";
    const tvgName = getAttr(line, "tvg-name") || "";
    const tvgType = (getAttr(line, "tvg-type") || "").toLowerCase().trim(); // movie / tv / series
    const logo = getAttr(line, "tvg-logo") || "";
    const groupTitle = getAttr(line, "group-title") || "";

    const titlePart = line.includes(",") ? line.split(",").slice(1).join(",").trim() : tvgName;

    // URL bývá na dalším řádku
    const next = lines[i + 1] || "";
    const url = next.startsWith("http") ? next : "";

    entries.push({ tvgId, tvgName, tvgType, logo, groupTitle, titlePart, url });
  }

  console.log("PARSE entries:", entries.length);
  console.log("PARSE type sample:", entries.slice(0, 10).map(e => e.tvgType));

  return entries;
}

async function ensureCache() {
  if (!PLAYLIST_URL) throw new Error("Missing env PLAYLIST_URL");

  const now = Date.now();
  if (now - cache.loadedAt < 15 * 60 * 1000 && (cache.movies.length || cache.series.length)) return;

  const m3u = await fetchText(PLAYLIST_URL);

  const extinfCount = (m3u.match(/#EXTINF/gi) || []).length;
  console.log("PLAYLIST #EXTINF count:", extinfCount);
  if (extinfCount === 0) throw new Error("No #EXTINF found in downloaded playlist.");

  const entries = parseM3U(m3u);

  // ---- build movie/series maps ----
  const moviesByTvg = new Map(); // key -> {meta, streams[]}
  const seriesByTvg = new Map(); // tvgId -> { name, poster, episodes:Set("s-e"), streamsByEpisodeKey: Map("s-e"->url) }

  for (const e of entries) {
    const t = (e.tvgType || "").toLowerCase();

    if (t === "movie") {
      // fallback ID, když tvg-id chybí
      const key = e.tvgId || e.titlePart || e.tvgName;
      if (!key) continue;

      if (!moviesByTvg.has(key)) moviesByTvg.set(key, { entry: e, streams: [] });
      if (e.url) moviesByTvg.get(key).streams.push({ url: e.url, name: "M3U" });
      continue;
    }

    if (t === "tv" || t === "series" || t === "tvshow" || t === "show") {
      const se = parseSxxEyy(e.tvgName) || parseSxxEyy(e.titlePart);
      if (!se) continue;

      const key = e.tvgId || (e.titlePart || e.tvgName);
      if (!key) continue;

      if (!seriesByTvg.has(key)) {
        seriesByTvg.set(key, {
          entry: e,
          episodes: new Set(),
          streamsByEpisode: new Map()
        });
      }

      const epKey = `${se.s}-${se.e}`;
      seriesByTvg.get(key).episodes.add(epKey);
      if (e.url) seriesByTvg.get(key).streamsByEpisode.set(epKey, e.url);
    }
  }

  console.log("MOVIES found:", moviesByTvg.size);
  console.log("SERIES found:", seriesByTvg.size);

  // ---- build Stremio metas ----
  const movies = [];
  const series = [];
  const byId = new Map();
  const streamsById = new Map();

  for (const [key, obj] of moviesByTvg.entries()) {
    const e = obj.entry;

    const id = `m3u:movie:${encodeURIComponent(String(key))}`;
    const meta = {
      id,
      type: "movie",
      name: e.titlePart || e.tvgName || "Movie",
      poster: e.logo || undefined,
      description: e.groupTitle ? `Skupina: ${e.groupTitle}` : undefined
    };

    movies.push(meta);
    byId.set(id, meta);
    streamsById.set(id, obj.streams);
  }

  for (const [key, obj] of seriesByTvg.entries()) {
    const e = obj.entry;
    const baseName = (e.titlePart || e.tvgName || "Series").replace(/\sS\d{1,2}E\d{1,2}.*/i, "").trim();
    const id = `m3u:series:${encodeURIComponent(String(key))}`;

    const episodes = [...obj.episodes]
      .map(x => {
        const [s, ep] = x.split("-").map(n => parseInt(n, 10));
        return { s, ep, k: x };
      })
      .sort((a, b) => a.s - b.s || a.ep - b.ep);

    const meta = {
      id,
      type: "series",
      name: baseName || e.titlePart || e.tvgName,
      poster: e.logo || undefined,
      description: e.groupTitle ? `Skupina: ${e.groupTitle}` : undefined,
      videos: episodes.map(v => ({
        id: `${id}:${v.s}:${v.ep}`, // episode id
        title: `S${String(v.s).padStart(2, "0")}E${String(v.ep).padStart(2, "0")}`,
        season: v.s,
        episode: v.ep
      }))
    };

    series.push(meta);
    byId.set(id, meta);

    // streams pro epizody
    for (const v of episodes) {
      const epId = `${id}:${v.s}:${v.ep}`;
      const url = obj.streamsByEpisode.get(v.k);
      if (url) streamsById.set(epId, [{ url, name: "M3U" }]);
    }
  }

  cache = { loadedAt: now, movies, series, byId, streamsById };
}

// ---------------- handlers ----------------
builder.defineCatalogHandler(async ({ type, id }) => {
  try {
    console.log("CATALOG request:", type, id);
    await ensureCache();

    if (type === "movie" && id === "m3u-movies") return { metas: cache.movies };
    if (type === "series" && id === "m3u-series") return { metas: cache.series };

    return { metas: [] };
  } catch (e) {
    console.error("CATALOG ERROR:", e && (e.stack || e.message || e));
    return { metas: [] };
  }
});

builder.defineMetaHandler(async ({ type, id }) => {
  try {
    console.log("META request:", type, id);
    await ensureCache();

    const meta = cache.byId.get(id) || null;
    if (!meta || meta.type !== type) return { meta: null };

    return { meta };
  } catch (e) {
    console.error("META ERROR:", e && (e.stack || e.message || e));
    return { meta: null };
  }
});

builder.defineStreamHandler(async ({ type, id }) => {
  try {
    console.log("STREAM request:", type, id);
    await ensureCache();

    const streams = cache.streamsById.get(id) || [];
    // Stremio očekává { streams: [{ url, title? , name? }] }
    return {
      streams: streams.map(s => ({
        url: s.url,
        name: s.name || "M3U"
      }))
    };
  } catch (e) {
    console.error("STREAM ERROR:", e && (e.stack || e.message || e));
    return { streams: [] };
  }
});

// ---------------- server ----------------
serveHTTP(builder.getInterface(), { port: PORT });
console.log("Addon running on port:", PORT);.log("Manifest:", `http://localhost:${PORT}/manifest.json`);
