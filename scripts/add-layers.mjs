#!/usr/bin/env node
// Adds two more data layers to data/<city>.js, sampled at exactly the same
// points as the terrain heights (every ~100 m along each segment):
//
//   pop    people per hectare, from GHSL GHS-POP 2025 (3 arc-second grid,
//          ~100 m), averaged over the 3x3 cells around the sample.
//   green  percent of land within ~150 m that is vegetated, from ESA WorldCover
//          2021 (10 m): tree cover, shrubland, grassland, cropland, wetland,
//          mangroves.
//
//   node scripts/add-layers.mjs              # every city in data/
//   node scripts/add-layers.mjs tokyo seoul  # just these
//
// Run it after fetch-city.mjs. GHSL tiles (50-150 MB each) are downloaded to
// .cache/ghsl/ and can be deleted afterwards; WorldCover is read remotely.

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { fromFile, fromUrl } from 'geotiff';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const GHSL_DIR = join(ROOT, '.cache', 'ghsl');
const GHSL = 'GHS_POP_E2025_GLOBE_R2023A_4326_3ss';
const GHSL_URL = `https://jeodpp.jrc.ec.europa.eu/ftp/jrc-opendata/GHSL/GHS_POP_GLOBE_R2023A/${GHSL}/V1-0/tiles`;
const WORLDCOVER_URL = 'https://esa-worldcover.s3.eu-central-1.amazonaws.com/v200/2021/map';
const GREEN_CLASSES = new Set([10, 20, 30, 40, 90, 95]);
const GREEN_RADIUS_PX = 15; // 150 m

const LAYERS = {
  pop: 'GHSL GHS-POP 2025 (~100 m)',
  green: 'ESA WorldCover 2021 (10 m)',
};

function loadCity(id) {
  const ctx = { window: {} };
  vm.runInNewContext(readFileSync(join(ROOT, 'data', `${id}.js`), 'utf8'), ctx);
  return ctx.window.SONGLINES_CITIES[id];
}

function saveCity(city) {
  writeFileSync(join(ROOT, 'data', `${city.id}.js`),
    `(window.SONGLINES_CITIES = window.SONGLINES_CITIES || {})[${JSON.stringify(city.id)}] = ${JSON.stringify(city)};\n`);
}

// The same points fetch-city.mjs asked the elevation service about.
function samplePoints(city) {
  const pts = [];
  for (const ed of city.edges) {
    const A = city.stations[ed.a], B = city.stations[ed.b];
    const n = ed.elev.length - 1;
    for (let k = 0; k <= n; k++) {
      pts.push({ lat: A.lat + (B.lat - A.lat) * k / n, lon: A.lon + (B.lon - A.lon) * k / n });
    }
  }
  return pts;
}

function groupBy(pts, keyOf) {
  const groups = new Map();
  pts.forEach((p, i) => {
    const key = keyOf(p);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(i);
  });
  return groups;
}

// Read one window covering all the given points (plus a margin) and return a
// pixel accessor.
async function readAround(image, pts, idx, margin) {
  const [west, , , north] = image.getBoundingBox();
  const [rx, ry] = image.getResolution();
  const col = (p) => Math.floor((p.lon - west) / rx), row = (p) => Math.floor((north - p.lat) / -ry);
  const cols = idx.map((i) => col(pts[i])), rows = idx.map((i) => row(pts[i]));
  const x0 = Math.max(0, Math.min(...cols) - margin), y0 = Math.max(0, Math.min(...rows) - margin);
  const x1 = Math.min(image.getWidth(), Math.max(...cols) + margin + 1);
  const y1 = Math.min(image.getHeight(), Math.max(...rows) + margin + 1);
  const [data] = await image.readRasters({ window: [x0, y0, x1, y1] });
  const w = x1 - x0, h = y1 - y0;
  return {
    col, row,
    at: (x, y) => (x < x0 || y < y0 || x >= x1 || y >= y1 ? null : data[(y - y0) * w + (x - x0)]),
    size: `${w}x${h}`,
  };
}

// ---------- population ----------

// GHSL's WGS84 tiles are 10 degrees square, counted from 180°W and ~89.1°N.
const ghslTile = (p) =>
  `R${Math.floor((89.0996 - p.lat) / 10) + 1}_C${Math.floor((p.lon + 180.0079) / 10) + 1}`;

async function ghslImage(tile) {
  const name = `${GHSL}_V1_0_${tile}`;
  const tif = join(GHSL_DIR, `${name}.tif`);
  if (!existsSync(tif)) {
    mkdirSync(GHSL_DIR, { recursive: true });
    console.log(`  downloading population tile ${tile}…`);
    const zip = join(GHSL_DIR, `${name}.zip`);
    execFileSync('curl', ['-sS', '-f', '--retry', '3', '-o', zip, `${GHSL_URL}/${name}.zip`], { stdio: 'inherit' });
    execFileSync('unzip', ['-o', '-q', zip, `${name}.tif`, '-d', GHSL_DIR]);
    execFileSync('rm', [zip]);
  }
  return (await fromFile(tif)).getImage();
}

async function population(pts) {
  const out = new Array(pts.length).fill(0);
  for (const [tile, idx] of groupBy(pts, ghslTile)) {
    const image = await ghslImage(tile);
    const [rx, ry] = image.getResolution();
    const win = await readAround(image, pts, idx, 1);
    for (const i of idx) {
      const p = pts[i], cx = win.col(p), cy = win.row(p);
      let sum = 0, n = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const v = win.at(cx + dx, cy + dy);
        if (v != null && v >= 0) { sum += v; n++; }
      }
      // People per cell -> people per hectare.
      const cellHa = rx * -ry * 111.32 * 111.32 * Math.cos(p.lat * Math.PI / 180) * 100;
      out[i] = n ? Math.round(sum / n / cellHa) : 0;
    }
  }
  return out;
}

// ---------- green space ----------

// WorldCover tiles are 3 degrees square, named by their south-west corner.
function worldcoverTile(p) {
  const lat = Math.floor(p.lat / 3) * 3, lon = Math.floor(p.lon / 3) * 3;
  return `${lat < 0 ? 'S' : 'N'}${String(Math.abs(lat)).padStart(2, '0')}` +
    `${lon < 0 ? 'W' : 'E'}${String(Math.abs(lon)).padStart(3, '0')}`;
}

async function green(pts) {
  const out = new Array(pts.length).fill(0);
  for (const [tile, idx] of groupBy(pts, worldcoverTile)) {
    const tiff = await fromUrl(`${WORLDCOVER_URL}/ESA_WorldCover_10m_2021_v200_${tile}_Map.tif`);
    const image = await tiff.getImage();
    const R = GREEN_RADIUS_PX;
    const win = await readAround(image, pts, idx, R);
    console.log(`  land cover ${tile}: ${win.size} px`);
    for (const i of idx) {
      const cx = win.col(pts[i]), cy = win.row(pts[i]);
      let greenPx = 0, land = 0;
      for (let dy = -R; dy <= R; dy++) for (let dx = -R; dx <= R; dx++) {
        if (dx * dx + dy * dy > R * R) continue;
        const v = win.at(cx + dx, cy + dy);
        if (v == null || v === 0) continue;
        land++;
        if (GREEN_CLASSES.has(v)) greenPx++;
      }
      out[i] = land ? Math.round(100 * greenPx / land) : 0;
    }
  }
  return out;
}

// ---------- main ----------

const wanted = process.argv.slice(2);
const ids = readdirSync(join(ROOT, 'data'))
  .filter((f) => f.endsWith('.js') && f !== 'index.js').map((f) => f.replace(/\.js$/, ''))
  .filter((id) => !wanted.length || wanted.includes(id));

for (const id of ids) {
  const city = loadCity(id);
  console.log(`${city.name}: ${city.edges.length} segments`);
  const pts = samplePoints(city);
  const pop = await population(pts);
  const grn = await green(pts);
  let at = 0;
  for (const ed of city.edges) {
    ed.pop = pop.slice(at, at + ed.elev.length);
    ed.green = grn.slice(at, at + ed.elev.length);
    at += ed.elev.length;
  }
  city.layers = LAYERS;
  saveCity(city);
  const mean = (a) => Math.round(a.reduce((s, v) => s + v, 0) / a.length);
  console.log(`  population ${Math.min(...pop)}–${Math.max(...pop)} /ha (mean ${mean(pop)}), ` +
    `green ${Math.min(...grn)}–${Math.max(...grn)} % (mean ${mean(grn)})`);
}
