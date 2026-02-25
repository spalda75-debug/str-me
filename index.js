process.on("uncaughtException", (err) => console.error("UNCAUGHT:", err));
process.on("unhandledRejection", (err) => console.error("UNHANDLED:", err));

const { addonBuilder, serveHTTP } = require("stremio-addon-sdk");

const fetchFn = global.fetch?.bind(global);
if (!fetchFn) {
  console.error("No global fetch available. Use Node 18+.");
  process.exit(1);
}

const PLAYLIST_URL = process.env.PLAYLIST_URL;
const PORT = process.env.PORT || 7000;

const manifest = {
  id: "com.veronika.m3u.library",
  version: "0.3.1",
  name: "M3U Library (no TMDb)",
  description: "Knihovna z M3U bez TMDb/IMDb.",
  resources: ["catalog"],
  types: ["movie", "series"],
  catalogs: [
    { type: "movie", id: "m3u-movies", name: "Moje filmy (M3U)" },
    { type: "series", id: "m3u-series", name: "Moje seriály (M3U)" }
  ]
};

const builder = new addonBuilder(manifest);

let cache = { loadedAt: 0, movies: [], series: [] };

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

async function ensureCache() {
  if (!PLAYLIST_URL) throw new Error("Missing env PLAYLIST_URL");

  const now = Date.now();
  if (now - cache.loadedAt < 15 * 60 * 1000 && (cache.movies.length || cache.series.length)) return;

  const res = await fetchFn(PLAYLIST_URL, { redirect: "follow" });
  const text = await res.text();

  console.log("PLAYLIST HTTP:", res.status, res.headers.get("content-type"));
  console.log("PLAYLIST HEAD:", JSON.stringify(text.slice(0, 200)));

  if (!res.ok) throw new Error(`PLAYLIST HTTP ${res.status}`);

  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);

  const movies = [];
  const seriesMap = new Map(); // key -> { name, poster, episodes:Set("s-e") }

  for (const line of lines) {
    if (!line.toUpperCase().startsWith("#EXTINF")) continue;

    const tvgType = (getAttr(line, "tvg-type") || "").toLowerCase().trim();
    const tvgId = getAttr(line, "tvg-id") || "";
    const tvgName = getAttr(line, "tvg-name") || "";
    const poster = getAttr(line, "tvg-logo") || "";
    const title = line.includes(",") ? line.split(",").slice(1).join(",").trim() : tvgName;

    if (tvgType === "movie") {
      const key = tvgId || title || tvgName;
      if (!key) continue;
      movies.push({
        id: `m3u:movie:${encodeURIComponent(String(key))}`,
        type: "movie",
        name: title || tvgName || "Movie",
        poster: poster || undefined
      });
    } else if (tvgType === "tv" || tvgType === "series" || tvgType === "tvshow" || tvgType === "show") {
      const se = parseSxxEyy(tvgName) || parseSxxEyy(title);
      if (!se) continue;
      const key = tvgId || (title || tvgName);
      if (!key) continue;

      if (!seriesMap.has(key)) {
        const baseName = (title || tvgName).replace(/\sS\d{1,2}E\d{1,2}.*/i, "").trim();
        seriesMap.set(key, { name: baseName || title || tvgName, poster, episodes: new Set() });
      }
      seriesMap.get(key).episodes.add(`${se.s}-${se.e}`);
    }
  }

  const series = [];
  for (const [key, obj] of seriesMap.entries()) {
    series.push({
      id: `m3u:series:${encodeURIComponent(String(key))}`,
      type: "series",
      name: obj.name,
      poster: obj.poster || undefined
    });
  }

  console.log("MOVIES:", movies.length, "SERIES:", series.length);
  cache = { loadedAt: now, movies, series };
}

builder.defineCatalogHandler(async ({ type, id }) => {
  try {
    await ensureCache();
    if (type === "movie" && id === "m3u-movies") return { metas: cache.movies };
    if (type === "series" && id === "m3u-series") return { metas: cache.series };
    return { metas: [] };
  } catch (e) {
    console.error("CATALOG ERROR:", e && (e.stack || e.message || e));
    return { metas: [] };
  }
});

serveHTTP(builder.getInterface(), { port: PORT });
console.log("Addon running on port:", PORT);
