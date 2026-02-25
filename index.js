const http = require("http");
const { addonBuilder } = require("stremio-addon-sdk");

const fetchFn = global.fetch?.bind(global);
if (!fetchFn) {
  console.error("No global fetch available. Use Node 18+.");
  process.exit(1);
}

const PLAYLIST_URL = process.env.PLAYLIST_URL || "";
const PORT = process.env.PORT || 7000;

const manifest = {
  id: "com.veronika.m3u.debug2",
  version: "0.1.0",
  name: "M3U DEBUG2",
  description: "Debug addon: /debug ukáže co server opravdu stáhne",
  resources: ["catalog"],
  types: ["movie"],
  catalogs: [{ type: "movie", id: "all", name: "Vše (debug)" }]
};

const builder = new addonBuilder(manifest);

let last = { at: 0, status: null, ctype: null, head: "", extinf: 0, metas: [] };

async function loadOnce() {
  if (!PLAYLIST_URL) throw new Error("Missing env PLAYLIST_URL");

  // refresh max 60s
  const now = Date.now();
  if (now - last.at < 60 * 1000 && last.at !== 0) return;

  const res = await fetchFn(PLAYLIST_URL, { redirect: "follow" });
  const text = await res.text();

  const extinf = (text.match(/#EXTINF/gi) || []).length;
  const head = text.slice(0, 200);

  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);

  const metas = [];
  let idx = 0;
  for (const line of lines) {
    if (!line.toUpperCase().startsWith("#EXTINF")) continue;
    const name = line.includes(",") ? line.split(",").slice(1).join(",").trim() : `Item ${idx + 1}`;
    metas.push({ id: `dbg:${idx}`, type: "movie", name: name || `Item ${idx + 1}` });
    idx++;
    if (metas.length >= 200) break;
  }

  last = {
    at: now,
    status: res.status,
    ctype: res.headers.get("content-type"),
    head,
    extinf,
    metas
  };
}

builder.defineCatalogHandler(async () => {
  try {
    await loadOnce();
    return { metas: last.metas };
  } catch (e) {
    console.error("CATALOG ERROR:", e?.stack || e?.message || e);
    return { metas: [] };
  }
});

const { serveHTTP } = require("stremio-addon-sdk");
serveHTTP(builder.getInterface(), { port: PORT });
console.log("Addon running on port:", PORT);
