const { addonBuilder, serveHTTP } = require("stremio-addon-sdk");

const fetchFn = global.fetch?.bind(global);
const PLAYLIST_URL = process.env.PLAYLIST_URL;
const PORT = process.env.PORT || 7000;

const manifest = {
  id: "com.veronika.m3u.debug",
  version: "0.1.0",
  name: "M3U DEBUG (show all EXTINF)",
  description: "Debug: ukáže všechny #EXTINF jako movie (bez filtrů).",
  resources: ["catalog"],
  types: ["movie"],
  catalogs: [{ type: "movie", id: "all", name: "Vše z M3U" }]
};

const builder = new addonBuilder(manifest);

let cache = { loadedAt: 0, metas: [] };

async function ensure() {
  if (!PLAYLIST_URL) throw new Error("Missing PLAYLIST_URL");
  const now = Date.now();
  if (now - cache.loadedAt < 60 * 1000 && cache.metas.length) return; // 1 min

  const res = await fetchFn(PLAYLIST_URL, { redirect: "follow" });
  const text = await res.text();

  console.log("HTTP:", res.status, res.headers.get("content-type"));
  console.log("HEAD:", JSON.stringify(text.slice(0, 200)));

  const extinf = (text.match(/#EXTINF/gi) || []).length;
  console.log("EXTINF count:", extinf);

  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);

  const metas = [];
  let idx = 0;

  for (const line of lines) {
    if (!line.toUpperCase().startsWith("#EXTINF")) continue;
    const name = line.includes(",") ? line.split(",").slice(1).join(",").trim() : `Item ${idx + 1}`;
    metas.push({
      id: `dbg:${idx}`,
      type: "movie",
      name: name || `Item ${idx + 1}`
    });
    idx++;
    if (metas.length >= 200) break; // ať to není obří
  }

  console.log("METAS built:", metas.length);
  cache = { loadedAt: now, metas };
}

builder.defineCatalogHandler(async ({ type, id }) => {
  try {
    await ensure();
    return { metas: cache.metas };
  } catch (e) {
    console.error("CATALOG ERROR:", e && (e.stack || e.message || e));
    return { metas: [] };
  }
});

serveHTTP(builder.getInterface(), { port: PORT });
console.log("RUNNING on", PORT);
