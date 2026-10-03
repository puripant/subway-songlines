#!/usr/bin/env node
// Builds data/<city>.js: subway lines + stations from OpenStreetMap (Overpass)
// and terrain heights sampled along every station-to-station segment.
//
//   node scripts/fetch-city.mjs                  # all cities below
//   node scripts/fetch-city.mjs lisbon tokyo     # just these
//   node scripts/fetch-city.mjs --dem=srtm lisbon
//                       # SRTM 90 m via Open Topo Data (default is Copernicus
//                       # GLO-90 via Open-Meteo, which has a tighter quota)
//   node scripts/fetch-city.mjs --dry tokyo      # parse only, print what it found
//
// Raw OpenStreetMap responses are cached in .cache/ so re-runs are cheap.
// To add a city, add an entry to CITIES; data/index.js is regenerated.

import { writeFileSync, readFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// bbox: south, west, north, east. Stops outside it are dropped, which trims
// through-services that run far out of town.
// network / ref: only keep route relations whose tags match.
// romanize: also look up English names from the city's station nodes, because
// stop positions often carry only the local-script name.
// sameStation: same-named stops on different lines within this many metres are
// one station (stops of one line only need to be within SAME_LINE_M).
const CITIES = {
  bangkok: { name: 'Bangkok', bbox: [13.5, 100.3, 14.0, 100.8], route: 'subway|monorail' },
  hongkong: { name: 'Hong Kong', bbox: [22.15, 113.83, 22.52, 114.45], network: /MTR|港鐵/i },
  lisbon: { name: 'Lisbon', bbox: [38.69, -9.25, 38.8, -9.08] },
  newyork: {
    name: 'New York', bbox: [40.49, -74.27, 40.92, -73.68], network: /^NYC Subway$/, ref: /^[A-Z0-9]+$/,
    // Manhattan repeats street names on every avenue; those are not interchanges.
    sameStation: 120,
    lineName: (t) => `${t.ref} train`,
  },
  london: { name: 'London', bbox: [51.28, -0.62, 51.71, 0.26], network: /^London Underground$/ },
  tokyo: {
    name: 'Tokyo', bbox: [35.52, 139.55, 35.84, 139.96], romanize: true,
    network: /^(都営地下鉄|東京メトロ)$/, ref: /^[A-Z]$/,
    lineName: (t) => stripDirection(t['name:en'] || t.name).replace(/ Local$/, ''),
  },
  seoul: { name: 'Seoul', bbox: [37.40, 126.75, 37.72, 127.2], romanize: true },
  shanghai: { name: 'Shanghai', bbox: [30.9, 121.1, 31.45, 121.95], network: /^上海地铁$/, romanize: true },
  beijing: { name: 'Beijing', bbox: [39.65, 116.0, 40.25, 116.8], romanize: true },
};

const SAMPLE_M = 100; // spacing of terrain samples along a segment
const SAME_STATION_M = 600;
const SAME_LINE_M = 400;
const WALK_TRANSFER_M = 450; // stations on different lines this close are linked
const UA = 'SubwaySonglines/0.1 (prototype)';

const flags = process.argv.slice(2).filter((a) => a.startsWith('--'));
const wanted = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const DRY = flags.includes('--dry');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function haversine(a, b) {
  const R = 6371000, rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad, dLon = (b.lon - a.lon) * rad;
  const s = Math.sin(dLat / 2) ** 2 +
    Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

async function overpass(id, query) {
  const cache = join(ROOT, '.cache', `${id}.json`);
  if (existsSync(cache)) return JSON.parse(readFileSync(cache, 'utf8'));
  await sleep(3000); // be polite between uncached queries
  const endpoints = [
    'https://overpass-api.de/api/interpreter',
    'https://overpass.kumi.systems/api/interpreter',
  ];
  let lastErr;
  for (let attempt = 0; attempt < 6; attempt++) {
    const url = endpoints[attempt % endpoints.length];
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'User-Agent': UA, Accept: 'application/json',
          'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'data=' + encodeURIComponent(query),
        signal: AbortSignal.timeout(150000),
      });
      if (res.ok) {
        const json = await res.json();
        mkdirSync(dirname(cache), { recursive: true });
        writeFileSync(cache, JSON.stringify(json));
        return json;
      }
      lastErr = new Error(`Overpass ${res.status} from ${url}`);
    } catch (e) { lastErr = e; }
    await sleep(5000 * (attempt + 1));
  }
  throw lastErr;
}

const DEMS = {
  copernicus: {
    label: 'Copernicus GLO-90 surface model via Open-Meteo',
    url: (chunk) => 'https://api.open-meteo.com/v1/elevation?latitude=' +
      chunk.map((p) => p.lat.toFixed(5)).join(',') +
      '&longitude=' + chunk.map((p) => p.lon.toFixed(5)).join(','),
    read: (json) => json.elevation,
  },
  srtm: {
    label: 'SRTM 90 m via Open Topo Data',
    url: (chunk) => 'https://api.opentopodata.org/v1/srtm90m?locations=' +
      chunk.map((p) => `${p.lat.toFixed(5)},${p.lon.toFixed(5)}`).join('|'),
    read: (json) => json.results.map((r) => r.elevation ?? 0),
  },
};
const demArg = flags.find((a) => a.startsWith('--dem='));
const DEM = DEMS[demArg ? demArg.slice(6) : 'copernicus'];

const demName = Object.keys(DEMS).find((k) => DEMS[k] === DEM);
const elevCachePath = join(ROOT, '.cache', `elev-${demName}.json`);
const elevCache = existsSync(elevCachePath) ? JSON.parse(readFileSync(elevCachePath, 'utf8')) : {};
const elevKey = (p) => `${p.lat.toFixed(5)},${p.lon.toFixed(5)}`;

async function elevations(all) {
  // Only ask for points not seen on an earlier run.
  const points = all.filter((p) => !(elevKey(p) in elevCache));
  await fetchElevations(points);
  mkdirSync(dirname(elevCachePath), { recursive: true });
  writeFileSync(elevCachePath, JSON.stringify(elevCache));
  return all.map((p) => elevCache[elevKey(p)]);
}

async function fetchElevations(points) {
  for (let i = 0; i < points.length; i += 100) {
    const chunk = points.slice(i, i + 100);
    const url = DEM.url(chunk);
    let json;
    for (let attempt = 0; ; attempt++) {
      const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(30000) })
        .catch((e) => ({ ok: false, status: e.name, text: async () => String(e) }));
      if (res.ok) { json = await res.json(); break; }
      if (attempt >= 8) throw new Error(`Elevation API ${res.status}: ${await res.text()}`);
      // 429 = per-minute quota; it clears on its own.
      await sleep(res.status === 429 ? 62000 : 3000 * (attempt + 1));
    }
    DEM.read(json).forEach((v, k) => { elevCache[elevKey(chunk[k])] = v; });
    process.stdout.write(`\r  terrain ${Math.min(i + 100, points.length)}/${points.length}`);
    await sleep(1200);
  }
  if (points.length) process.stdout.write('\n');
}

const stripDirection = (name) => name.replace(/\s*[(:（：].*$/, '').replace(/\s*(=>|→|⇒).*$/, '').trim();

function lineLabel(cfg, t) {
  if (cfg.lineName) return cfg.lineName(t);
  if (/^\d+[A-Z]?$/.test(t.ref || '')) return `Line ${t.ref}`;
  const name = stripDirection(t['name:en'] || t.name || t.ref);
  const num = name.match(/(\d+)\s*号线/);
  if (num) return `Line ${num[1]}`;
  // No English name: fall back to the line number/letter if there is one.
  if (/[^\u0000-ɏ]/.test(name) && t.ref && /^[\x20-\x7E]+$/.test(t.ref)) return `Line ${t.ref}`;
  return name;
}

async function buildCity(id, cfg) {
  console.log(`${cfg.name}: fetching lines…`);
  const [s, w, n, e] = cfg.bbox;
  const osm = await overpass(id,
    `[out:json][timeout:120];relation["type"="route"]["route"~"^(${cfg.route || 'subway'})$"](${s},${w},${n},${e});out body;node(r);out body;`);
  const nodes = new Map();
  const relations = [];
  for (const el of osm.elements) {
    if (el.type === 'node') nodes.set(el.id, el);
    else if (el.type === 'relation') relations.push(el);
  }
  // Local-script name -> English name, from every node we can see.
  const english = new Map();
  const learn = (els) => {
    for (const el of els) {
      const t = el.tags || {};
      const en = t['name:en'] || t['name:ko-Latn'] || t['name:zh-Latn-pinyin'] || t['name:ja-Latn'];
      if (el.type === 'node' && t.name && en && !english.has(t.name)) english.set(t.name, en);
    }
  };
  learn(osm.elements.filter((el) => el.tags?.['name:en']));
  if (cfg.romanize) {
    // Nice to have: carry on with local names if this query will not come back.
    const names = await overpass(`${id}-names`,
      `[out:json][timeout:120];node["railway"~"^(station|stop|halt)$"]["name"](${s},${w},${n},${e});out tags;`)
      .catch((err) => { console.log(`  (no name lookup: ${err.message})`); return { elements: [] }; });
    learn(names.elements.filter((el) => el.tags?.['name:en']));
    learn(names.elements);
  }
  learn(osm.elements);
  const nameOf = (nd) => nd.tags['name:en'] || english.get(nd.tags.name) || nd.tags.name;

  const inside = (nd) => nd.lat >= s && nd.lat <= n && nd.lon >= w && nd.lon <= e;

  // OSM has one relation per direction, branch and stopping pattern. Group them
  // into lines; every variant contributes its segments.
  const byLine = new Map();
  for (const rel of relations) {
    const t = rel.tags || {};
    if (cfg.network && !cfg.network.test(t.network || '')) continue;
    if (cfg.ref && !cfg.ref.test(t.ref || '')) continue;
    // Mappers are inconsistent: stops may carry a "stop" role, or no role at
    // all and point at the station node instead. Accept both, skip platforms.
    const members = rel.members.filter((m) => {
      if (m.type !== 'node' || /platform/.test(m.role)) return false;
      if (/^stop/.test(m.role)) return true;
      const nt = nodes.get(m.ref)?.tags || {};
      return /^(stop_position|station)$/.test(nt.public_transport || '') ||
        /^(station|stop|halt)$/.test(nt.railway || '');
    });
    // Split into runs of named stops inside the bbox.
    const runs = [[]];
    for (const m of members) {
      const nd = nodes.get(m.ref);
      if (!nd?.tags?.name) continue;
      if (inside(nd)) runs[runs.length - 1].push(nd);
      else if (runs[runs.length - 1].length) runs.push([]);
    }
    const key = t.ref || stripDirection(t['name:en'] || t.name || String(rel.id));
    for (const stops of runs) {
      if (stops.length < 3) continue;
      if (!byLine.has(key)) byLine.set(key, { tags: t, variants: [] });
      byLine.get(key).variants.push(stops);
    }
  }

  const sameM = cfg.sameStation || SAME_STATION_M;
  const stations = [];
  const stationFor = (nd, lineKey) => {
    const name = nameOf(nd);
    let st = stations.find((x) => x.name === name && (
      x._nodes.some((m) => haversine(m, nd) < sameM) ||
      (x._lines.has(lineKey) && haversine(x, nd) < SAME_LINE_M)));
    if (!st) {
      st = { name, lat: nd.lat, lon: nd.lon, _nodes: [], _lines: new Set() };
      if (nd.tags.name && nd.tags.name !== name) st.local = nd.tags.name;
      stations.push(st);
    }
    if (!st._nodes.includes(nd)) {
      // Interchange: sit at the centroid of its platforms.
      st._nodes.push(nd);
      st.lat = st._nodes.reduce((sum, m) => sum + m.lat, 0) / st._nodes.length;
      st.lon = st._nodes.reduce((sum, m) => sum + m.lon, 0) / st._nodes.length;
    }
    st._lines.add(lineKey);
    return stations.indexOf(st);
  };

  let lines = [];
  for (const [lineKey, { tags, variants }] of byLine) {
    variants.sort((x, y) => y.length - x.length);
    const routes = variants.map((stops) => {
      const ids = [];
      for (const nd of stops) {
        const i = stationFor(nd, lineKey);
        if (ids[ids.length - 1] !== i) ids.push(i);
      }
      return ids;
    });
    if (routes[0].length < 3) continue;
    lines.push({ name: lineLabel(cfg, tags), color: tags.colour || '#888888', stops: routes[0], routes });
  }
  lines.sort((a, b) => b.stops.length - a.stops.length);

  // Rail segments, de-duplicated per line. Variants are taken longest first;
  // a later variant only adds track the line does not already cover, so express
  // and short-turn patterns do not draw shortcuts over the stopping service.
  const edges = [];
  const members = lines.map(() => new Set());
  lines.forEach((line, li) => {
    const adj = new Map();
    const link = (a, b, d) => { if (!adj.has(a)) adj.set(a, []); adj.get(a).push([b, d]); };
    const covered = (a, b, limit) => {
      const best = new Map([[a, 0]]), queue = [a];
      while (queue.length) {
        const u = queue.shift();
        for (const [v, d] of adj.get(u) || []) {
          const nd = best.get(u) + d;
          if (nd <= limit && nd < (best.get(v) ?? Infinity)) { best.set(v, nd); queue.push(v); }
        }
      }
      return best.has(b);
    };
    for (const route of line.routes) {
      for (let i = 0; i < route.length - 1; i++) {
        const a = route[i], b = route[i + 1];
        if (a === b) continue;
        const dist = Math.round(haversine(stations[a], stations[b]));
        if (covered(a, b, dist * 1.4 + 300)) continue;
        link(a, b, dist); link(b, a, dist);
        members[li].add(a); members[li].add(b);
        edges.push({ a, b, line: li, dist });
      }
    }
    delete line.routes;
  });

  // Drop stations that ended up on no line, and renumber.
  const used = new Set(edges.flatMap((ed) => [ed.a, ed.b]));
  const remap = new Map();
  const kept = stations.filter((st, i) => used.has(i) && remap.set(i, remap.size));
  for (const ed of edges) { ed.a = remap.get(ed.a); ed.b = remap.get(ed.b); }
  lines.forEach((l, li) => {
    l.stops = l.stops.filter((i) => remap.has(i)).map((i) => remap.get(i));
    members[li] = new Set([...members[li]].map((i) => remap.get(i)));
  });

  const transfers = [];
  for (let a = 0; a < kept.length; a++) {
    for (let b = a + 1; b < kept.length; b++) {
      if (Math.abs(kept[a].lat - kept[b].lat) > 0.01) continue;
      const d = haversine(kept[a], kept[b]);
      if (d < WALK_TRANSFER_M && !members.some((m) => m.has(a) && m.has(b))) {
        transfers.push({ a, b, dist: Math.round(d) });
      }
    }
  }

  // Terrain samples along each segment, endpoints included.
  const pts = [];
  for (const ed of edges) {
    const A = kept[ed.a], B = kept[ed.b];
    const steps = Math.max(2, Math.round(ed.dist / SAMPLE_M));
    ed._from = pts.length;
    for (let k = 0; k <= steps; k++) {
      const t = k / steps;
      pts.push({ lat: A.lat + (B.lat - A.lat) * t, lon: A.lon + (B.lon - A.lon) * t });
    }
    ed._to = pts.length;
  }

  const km = Math.round(edges.reduce((sum, ed) => sum + ed.dist, 0) / 1000);
  console.log(`  ${lines.length} lines, ${kept.length} stations, ${edges.length} segments (${km} km), ` +
    `${transfers.length} walking transfers, ${pts.length} terrain samples`);
  console.log('  ' + lines.map((l) => `${l.name} (${l.stops.length})`).join(' · '));
  if (DRY) {
    const longest = [...edges].sort((x, y) => y.dist - x.dist).slice(0, 4);
    console.log('  longest: ' + longest.map((ed) => `${kept[ed.a].name}–${kept[ed.b].name} ${ed.dist} m`).join(', '));
    console.log('  sample names: ' + kept.slice(0, 8).map((st) => st.name).join(', '));
    return;
  }

  const elev = await elevations(pts);
  for (const ed of edges) {
    ed.elev = elev.slice(ed._from, ed._to).map((v) => Math.round(v));
    delete ed._from; delete ed._to;
  }
  for (const st of kept) {
    delete st._nodes; delete st._lines;
    st.lat = +st.lat.toFixed(5); st.lon = +st.lon.toFixed(5);
  }
  const city = { id, name: cfg.name, dem: DEM.label, stations: kept, lines, edges, transfers };
  mkdirSync(join(ROOT, 'data'), { recursive: true });
  writeFileSync(join(ROOT, 'data', `${id}.js`),
    `(window.SONGLINES_CITIES = window.SONGLINES_CITIES || {})[${JSON.stringify(id)}] = ${JSON.stringify(city)};\n`);
  const all = edges.flatMap((ed) => ed.elev);
  console.log(`  terrain ${Math.min(...all)}–${Math.max(...all)} m`);
}

for (const [id, cfg] of Object.entries(CITIES)) {
  if (wanted.length && !wanted.includes(id)) continue;
  await buildCity(id, cfg);
}

// The app lazy-loads city files; this is the list it offers.
if (!DRY) {
  const have = new Set(readdirSync(join(ROOT, 'data')).map((f) => f.replace(/\.js$/, '')));
  const index = Object.entries(CITIES).filter(([id]) => have.has(id)).map(([id, c]) => ({ id, name: c.name }));
  writeFileSync(join(ROOT, 'data', 'index.js'), `window.SONGLINES_INDEX = ${JSON.stringify(index)};\n`);
}
