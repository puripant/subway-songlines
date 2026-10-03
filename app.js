(function () {
  const { compose, Player, STYLES, STEPS } = window.Songlines;
  const Songlines = window.Songlines;
  const CITIES = window.SONGLINES_CITIES = window.SONGLINES_CITIES || {};
  const INDEX = window.SONGLINES_INDEX || [];
  const SVG = 'http://www.w3.org/2000/svg';
  const $ = (id) => document.getElementById(id);
  const el = (name, attrs = {}, parent) => {
    const node = document.createElementNS(SVG, name);
    for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
    if (parent) parent.appendChild(node);
    return node;
  };

  const CHANGE_COST = 800; // metres-equivalent penalty for changing lines
  const WALK_FACTOR = 3;

  const ui = {
    city: $('city'), from: $('from'), to: $('to'), style: $('style'), pace: $('pace'),
    tempo: $('tempo'), tempoOut: $('tempoOut'), play: $('play'), prev: $('prev'), next: $('next'),
    summary: $('summary'), legend: $('legend'), map: $('map'), profile: $('profile'),
    sources: [...document.querySelectorAll('input[name="source"]')],
    nowStation: $('nowStation'), nowElev: $('nowElev'), nowChord: $('nowChord'), nowTime: $('nowTime'),
  };
  const player = new Player();
  const state = { city: null, graph: null, from: null, to: null, route: null, score: null,
    view: null, home: null, hover: null, pos: null };

  // ---------- routing ----------

  function buildGraph(city) {
    const nodes = [], id = new Map(), linesAt = city.stations.map(() => []);
    const node = (s, l) => {
      const key = s + ':' + l;
      if (!id.has(key)) { id.set(key, nodes.length); nodes.push({ s, l, adj: [] }); linesAt[s].push(l); }
      return id.get(key);
    };
    for (const e of city.edges) {
      const a = node(e.a, e.line), b = node(e.b, e.line);
      nodes[a].adj.push({ to: b, w: e.dist, edge: e });
      nodes[b].adj.push({ to: a, w: e.dist, edge: e });
    }
    linesAt.forEach((ls, s) => {
      for (const l of ls) for (const m of ls) {
        if (l !== m) nodes[id.get(s + ':' + l)].adj.push({ to: id.get(s + ':' + m), w: CHANGE_COST });
      }
    });
    for (const t of city.transfers) {
      for (const [a, b] of [[t.a, t.b], [t.b, t.a]]) {
        for (const l of linesAt[a]) for (const m of linesAt[b]) {
          nodes[id.get(a + ':' + l)].adj.push(
            { to: id.get(b + ':' + m), w: t.dist * WALK_FACTOR + CHANGE_COST, walk: t });
        }
      }
    }
    return { nodes, id, linesAt };
  }

  function findRoute(from, to) {
    const { nodes, id, linesAt } = state.graph;
    const dist = new Float64Array(nodes.length).fill(Infinity);
    const prev = new Array(nodes.length).fill(null);
    const done = new Uint8Array(nodes.length);
    for (const l of linesAt[from]) dist[id.get(from + ':' + l)] = 0;
    let goal = -1;
    for (;;) {
      let u = -1;
      for (let i = 0; i < nodes.length; i++) if (!done[i] && (u < 0 || dist[i] < dist[u])) u = i;
      if (u < 0 || dist[u] === Infinity) break;
      if (nodes[u].s === to) { goal = u; break; }
      done[u] = 1;
      for (const a of nodes[u].adj) {
        if (dist[u] + a.w < dist[a.to]) { dist[a.to] = dist[u] + a.w; prev[a.to] = { u, a }; }
      }
    }
    if (goal < 0) return null;
    const hops = [];
    for (let v = goal; prev[v]; v = prev[v].u) hops.unshift({ from: prev[v].u, to: v, a: prev[v].a });
    const legs = [];
    for (const h of hops) {
      const a = nodes[h.from], b = nodes[h.to];
      let leg;
      if (h.a.edge) {
        const e = h.a.edge;
        const along = (arr) => arr && (e.a === a.s ? arr : [...arr].reverse());
        leg = { from: a.s, to: b.s, line: e.line, dist: e.dist,
          elev: along(e.elev), pop: along(e.pop), green: along(e.green) };
      } else if (h.a.walk) {
        leg = { from: a.s, to: b.s, walk: true, dist: h.a.walk.dist };
      } else continue; // same-station line change
      legs.push(leg);
    }
    // A walk at either end is not part of the ride.
    while (legs.length && legs[0].walk) legs.shift();
    while (legs.length && legs[legs.length - 1].walk) legs.pop();
    if (!legs.length) return null;
    let d0 = 0;
    for (const leg of legs) { leg.d0 = d0; d0 += leg.dist; }
    smooth(legs, 'elev', 3);
    smooth(legs, 'pop', 2);
    smooth(legs, 'green', 1);
    return { legs, dist: d0 };
  }

  // The DEM is in whole metres and partly a surface model, so rooftops and
  // rounding show up as jitter; population comes in ~100 m blocks. Smooth along
  // the whole journey (terrain ~±300 m) so the music follows the lie of the
  // land; raw samples are kept for the drawing.
  function smooth(legs, key, R) {
    const rail = legs.filter((l) => !l.walk && l[key]);
    const all = rail.flatMap((l) => l[key]);
    const out = all.map((_, i) => {
      let sum = 0, wsum = 0;
      for (let k = -R; k <= R; k++) {
        const v = all[i + k];
        if (v === undefined) continue;
        const w = R + 1 - Math.abs(k);
        sum += v * w; wsum += w;
      }
      return sum / wsum;
    });
    let at = 0;
    for (const leg of rail) {
      leg[key + 'Raw'] = leg[key];
      leg[key] = out.slice(at, at + leg[key].length);
      at += leg[key].length;
    }
  }

  // Official line colours, nudged so they stay visible on the page background
  // (London's Northern line is pure black; Bangkok's Yellow Line is, well, yellow).
  const darkScheme = matchMedia('(prefers-color-scheme: dark)');
  function ink(hex) {
    const m = /^#?([0-9a-f]{6})$/i.exec(hex) || /^#?([0-9a-f])([0-9a-f])([0-9a-f])$/i.exec(hex);
    if (!m) return hex;
    const full = m.length === 2 ? m[1] : m[1] + m[1] + m[2] + m[2] + m[3] + m[3];
    let rgb = [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16));
    const lum = (0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2]) / 255;
    if (darkScheme.matches && lum < 0.3) rgb = rgb.map((v) => v + (255 - v) * (0.3 - lum) * 2);
    if (!darkScheme.matches && lum > 0.75) rgb = rgb.map((v) => v * (1 - (lum - 0.75) * 1.6));
    return `rgb(${rgb.map(Math.round).join(',')})`;
  }

  function paint() {
    for (const l of state.city.lines) l.ink = ink(l.color);
    ui.legend.replaceChildren(...state.city.lines.map((l) => {
      const li = document.createElement('li'), sw = document.createElement('i');
      sw.style.background = l.ink;
      li.append(sw, l.name);
      return li;
    }));
  }

  // ---------- map ----------

  let layers = {};

  function project(city) {
    const lat0 = city.stations.reduce((s, x) => s + x.lat, 0) / city.stations.length;
    const kx = Math.cos(lat0 * Math.PI / 180);
    const xs = city.stations.map((s) => s.lon * kx), ys = city.stations.map((s) => -s.lat);
    const minX = Math.min(...xs), minY = Math.min(...ys);
    const span = Math.max(Math.max(...xs) - minX, Math.max(...ys) - minY) || 1;
    city.xy = city.stations.map((_, i) => [(xs[i] - minX) / span * 1000, (ys[i] - minY) / span * 1000]);
    const w = Math.max(...city.xy.map((p) => p[0])), h = Math.max(...city.xy.map((p) => p[1]));
    const pad = 70;
    state.home = { x: -pad, y: -pad, w: w + pad * 2, h: h + pad * 2 };
  }

  const pts = (ids) => ids.map((i) => state.city.xy[i].join(',')).join(' ');

  function drawMap() {
    const city = state.city;
    ui.map.replaceChildren();
    layers = {};
    for (const name of ['lines', 'route', 'stations', 'labels']) layers[name] = el('g', {}, ui.map);
    for (const t of city.transfers) el('polyline', { class: 'walk', points: pts([t.a, t.b]) }, layers.lines);
    // One path per line, built from its segments so branches come out right.
    const paths = city.lines.map(() => []);
    for (const e of city.edges) {
      paths[e.line].push(`M${city.xy[e.a].join(',')}L${city.xy[e.b].join(',')}`);
    }
    city.lines.forEach((line, li) => {
      el('path', { class: 'line', d: paths[li].join(''), stroke: line.ink }, layers.lines);
    });
    layers.dots = city.stations.map((st, i) => {
      const c = el('circle', { class: 'station', cx: city.xy[i][0], cy: city.xy[i][1], 'data-i': i },
        layers.stations);
      el('title', {}, c).textContent = st.local ? `${st.name} · ${st.local}` : st.name;
      return c;
    });
    layers.train = el('circle', { class: 'train', visibility: 'hidden' }, ui.map);
    setView({ ...state.home });
  }

  function unit() {
    const r = ui.map.getBoundingClientRect();
    return Math.max(state.view.w / (r.width || 1), state.view.h / (r.height || 1));
  }

  function setView(v) {
    const home = state.home;
    v.w = Math.max(25, Math.min(v.w, home.w * 1.5));
    v.h = v.w * home.h / home.w;
    state.view = v;
    ui.map.setAttribute('viewBox', `${v.x} ${v.y} ${v.w} ${v.h}`);
    restyleMap();
  }

  // Dots and labels keep a constant size on screen whatever the zoom.
  function restyleMap() {
    if (!state.view || !layers.dots) return;
    const u = unit();
    const onRoute = new Set(state.route ? state.route.legs.flatMap((l) => [l.from, l.to]) : []);
    // Big networks get smaller dots until you zoom in.
    const small = Math.min(3, Math.max(1.4, 900 / state.view.w));
    layers.dots.forEach((c, i) => {
      const end = i === state.from || i === state.to;
      c.setAttribute('r', (end ? 6 : onRoute.has(i) ? 4 : small) * u);
      c.classList.toggle('end', end);
      c.classList.toggle('on-route', onRoute.has(i));
    });
    layers.train.setAttribute('r', 7 * u);
    layers.labels.replaceChildren();
    const label = (i, cls) => {
      if (i == null) return;
      const [x, y] = state.city.xy[i];
      const t = el('text', { x: x + 10 * u, y: y + 4 * u, 'font-size': 12.5 * u,
        'stroke-width': 3.5 * u, class: cls }, layers.labels);
      t.textContent = state.city.stations[i].name;
    };
    if (state.hover !== state.from && state.hover !== state.to) label(state.hover, 'hover');
    label(state.from, ''); label(state.to, '');
  }

  function drawRoute() {
    layers.route.replaceChildren();
    ui.map.classList.toggle('has-route', !!state.route);
    if (state.route) {
      for (const leg of state.route.legs) {
        el('polyline', {
          class: 'route' + (leg.walk ? ' walk-leg' : ''), points: pts([leg.from, leg.to]),
          stroke: leg.walk ? '' : state.city.lines[leg.line].ink,
        }, layers.route);
      }
    }
    layers.train.setAttribute('visibility', 'hidden');
    restyleMap();
  }

  // Frame the chosen route, with some context around it.
  function fitRoute() {
    if (!state.route) return;
    const ids = state.route.legs.flatMap((l) => [l.from, l.to]);
    const xs = ids.map((i) => state.city.xy[i][0]), ys = ids.map((i) => state.city.xy[i][1]);
    const cx = (Math.min(...xs) + Math.max(...xs)) / 2, cy = (Math.min(...ys) + Math.max(...ys)) / 2;
    const home = state.home;
    const w = Math.max((Math.max(...xs) - Math.min(...xs)) * 1.6,
      (Math.max(...ys) - Math.min(...ys)) * 1.6 * home.w / home.h, 120);
    const vw = Math.min(w, home.w);
    setView({ x: cx - vw / 2, y: cy - vw * home.h / home.w / 2, w: vw });
  }

  function svgPoint(evt) {
    const m = ui.map.getScreenCTM().inverse();
    return new DOMPoint(evt.clientX, evt.clientY).matrixTransform(m);
  }

  function zoomBy(f, cx, cy) {
    const v = state.view;
    cx ??= v.x + v.w / 2; cy ??= v.y + v.h / 2;
    const w = Math.max(25, Math.min(v.w * f, state.home.w * 1.5));
    f = w / v.w;
    setView({ x: cx - (cx - v.x) * f, y: cy - (cy - v.y) * f, w, h: v.h * f });
  }

  function bindMap() {
    let down = null;
    ui.map.addEventListener('pointerdown', (e) => {
      down = { x: e.clientX, y: e.clientY, view: { ...state.view }, target: e.target, moved: false };
    });
    ui.map.addEventListener('pointermove', (e) => {
      if (!down) return;
      const dx = e.clientX - down.x, dy = e.clientY - down.y;
      if (!down.moved && Math.hypot(dx, dy) < 5) return;
      if (!down.moved) { down.moved = true; ui.map.setPointerCapture(e.pointerId); ui.map.classList.add('dragging'); }
      const u = unit();
      setView({ ...down.view, x: down.view.x - dx * u, y: down.view.y - dy * u });
    });
    const up = () => {
      if (down && !down.moved && down.target.dataset?.i != null) pick(+down.target.dataset.i);
      down = null;
      ui.map.classList.remove('dragging');
    };
    ui.map.addEventListener('pointerup', up);
    ui.map.addEventListener('pointercancel', () => { down = null; });
    ui.map.addEventListener('wheel', (e) => {
      e.preventDefault();
      const p = svgPoint(e);
      zoomBy(Math.exp(e.deltaY * 0.0015), p.x, p.y);
    }, { passive: false });
    ui.map.addEventListener('pointerover', (e) => {
      const i = e.target.dataset?.i;
      const hover = i != null ? +i : null;
      if (hover === state.hover) return;
      state.hover = hover;
      restyleMap();
    });
    $('zoomIn').onclick = () => zoomBy(0.6);
    $('zoomOut').onclick = () => zoomBy(1 / 0.6);
    $('zoomFit').onclick = () => setView({ ...state.home });
    new ResizeObserver(() => { restyleMap(); drawProfile(); }).observe(ui.map);
  }

  // ---------- terrain profile ----------

  let prof = null;

  // How each data source is drawn and written. Population is stored per
  // hectare and shown per km².
  const fmtPop = (perHa) => (Math.round(perHa) * 100).toLocaleString('en');
  const SHOW = {
    elev: { label: 'ground', axis: (v) => `${Math.round(v)} m`, now: (v) => `${v.toFixed(0)} m`,
      range: (lo, hi) => `ground ${Math.round(lo)}–${Math.round(hi)} m` },
    pop: { label: 'people / km²', zero: true, axis: fmtPop, now: (v) => `${fmtPop(v)} people/km²`,
      range: (lo, hi) => `${fmtPop(lo)}–${fmtPop(hi)} people/km²` },
    green: { label: 'green space', zero: true, axis: (v) => `${Math.round(v)}%`, now: (v) => `${v.toFixed(0)}% green`,
      range: (lo, hi) => `${Math.round(lo)}–${Math.round(hi)}% green` },
  };

  function drawProfile() {
    const svg = ui.profile;
    svg.replaceChildren();
    prof = null;
    const route = state.route, score = state.score;
    if (!route || !score) return;
    const key = score.source, show = SHOW[key];
    const rail = route.legs.filter((l) => !l.walk);
    const W = svg.clientWidth || 600, H = svg.clientHeight || 150;
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    const m = { l: 46, r: 12, t: 14, b: 24 };
    const join = (p) => p.map((q) => q.join(',')).join(' ');
    const shown = rail.flatMap((l) => l[key + 'Raw'] || l[key]);
    const pad = Math.max(1, score.relief * 0.08);
    const lo = show.zero ? 0 : Math.min(...shown) - pad;
    const hi = (show.zero ? Math.max(score.hi, 1) : Math.max(...shown)) + pad;
    const base = H - m.b;
    const x = (d) => m.l + d / route.dist * (W - m.l - m.r);
    const y = (v) => base - (v - lo) / (hi - lo) * (base - m.t);

    el('line', { class: 'axis', x1: m.l, x2: W - m.r, y1: base, y2: base }, svg);
    for (const v of score.relief < 0.5 ? [score.lo] : [score.lo, score.hi]) {
      el('line', { class: 'tick', x1: m.l, x2: W - m.r, y1: y(v), y2: y(v), 'stroke-dasharray': '1 4' }, svg);
      el('text', { x: m.l - 6, y: y(v) + 3, 'text-anchor': 'end' }, svg).textContent = show.axis(v);
    }
    el('text', { class: 'rowlabel', x: W - m.r, y: m.t - 5, 'text-anchor': 'end' }, svg).textContent = show.label;

    let lastY = null;
    route.legs.forEach((leg, li) => {
      if (leg.walk) {
        const next = route.legs[li + 1];
        const y0 = lastY ?? y(next[key][0]), y1 = next ? y(next[key][0]) : y0;
        el('line', { class: 'seg walk-leg', x1: x(leg.d0), x2: x(leg.d0 + leg.dist), y1: y0, y2: y1 }, svg);
        return;
      }
      const color = state.city.lines[leg.line].ink;
      const xy = (arr) => arr.map((e, k) => [x(leg.d0 + leg.dist * k / (arr.length - 1)), y(e)]);
      const p = xy(leg[key]);
      // The unsmoothed samples, faintly, behind the curve the music follows.
      el('polyline', { class: 'seg raw', stroke: color, points: join(xy(leg[key + 'Raw'])) }, svg);
      el('polygon', { class: 'fill', fill: color,
        points: join([...p, [p[p.length - 1][0], base], [p[0][0], base]]) }, svg);
      el('polyline', { class: 'seg', stroke: color, points: join(p) }, svg);
      lastY = p[p.length - 1][1];
    });

    // Station marks along the baseline.
    const stops = [route.legs[0].from, ...route.legs.map((l) => l.to)];
    const ds = [route.legs[0].d0, ...route.legs.map((l) => l.d0 + l.dist)];
    stops.forEach((st, i) => {
      el('circle', { class: 'stop', cx: x(ds[i]), cy: base, r: i === 0 || i === stops.length - 1 ? 3.5 : 2.2 }, svg);
    });
    const names = state.city.stations;
    el('text', { x: m.l, y: H - 6 }, svg).textContent = names[stops[0]].name;
    el('text', { x: W - m.r, y: H - 6, 'text-anchor': 'end' }, svg).textContent = names[stops[stops.length - 1]].name;

    const head = el('line', { class: 'playhead', y1: m.t - 4, y2: base, visibility: 'hidden' }, svg);
    const dot = el('circle', { class: 'dot', r: 4, visibility: 'hidden' }, svg);
    prof = { x, y, head, dot };
    if (state.pos) showPosition(state.pos);
  }

  // ---------- playback position ----------

  const fmtTime = (s) => {
    s = Math.round(s);
    const h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), ss = String(s % 60).padStart(2, '0');
    return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
  };

  function positionAt(step) {
    const score = state.score;
    const bar = score.bars[Math.min(Math.floor(step / STEPS), score.bars.length - 1)];
    const leg = state.route.legs[bar.leg];
    const t = bar.t0 + (bar.t1 - bar.t0) * (step % STEPS) / STEPS;
    const at = (arr) => {
      if (!arr) return null;
      const f = t * (arr.length - 1), i = Math.min(Math.floor(f), arr.length - 2);
      return arr[i] + (arr[i + 1] - arr[i]) * (f - i);
    };
    return { step, bar, leg, t, value: at(leg[score.source]), d: leg.d0 + t * leg.dist };
  }

  function showPosition(pos) {
    state.pos = pos;
    const { leg, t, bar } = pos;
    const [ax, ay] = state.city.xy[leg.from], [bx, by] = state.city.xy[leg.to];
    layers.train.setAttribute('cx', ax + (bx - ax) * t);
    layers.train.setAttribute('cy', ay + (by - ay) * t);
    layers.train.setAttribute('visibility', 'visible');
    const name = (i) => state.city.stations[i].name;
    ui.nowStation.textContent =
      bar.type === 'final' ? `${name(leg.to)} · arrived`
      : bar.type === 'dwell' ? `${name(leg.from)} · doors open`
      : bar.type === 'change' ? `${name(leg.from)} · change to ${state.city.lines[leg.line].name}`
      : bar.type === 'walk' ? (bar.waiting ? `${name(leg.to)} · waiting` : `walk to ${name(leg.to)}`)
      : `${name(leg.from)} → ${name(leg.to)}`;
    ui.nowElev.textContent = pos.value == null ? '' : SHOW[state.score.source].now(pos.value);
    ui.nowChord.textContent = bar.chord || '';
    const eighth = 30 / state.score.bpm;
    ui.nowTime.textContent = `${fmtTime(pos.step * eighth)} / ${fmtTime(state.score.seconds)}`;
    if (prof) {
      prof.head.setAttribute('visibility', 'visible');
      prof.dot.setAttribute('visibility', pos.value == null ? 'hidden' : 'visible');
      prof.head.setAttribute('x1', prof.x(pos.d)); prof.head.setAttribute('x2', prof.x(pos.d));
      if (pos.value != null) { prof.dot.setAttribute('cx', prof.x(pos.d)); prof.dot.setAttribute('cy', prof.y(pos.value)); }
    }
  }

  function clearPosition() {
    state.pos = null;
    layers.train?.setAttribute('visibility', 'hidden');
    ui.nowStation.textContent = state.route ? 'Press play as the doors close' : '—';
    ui.nowElev.textContent = ''; ui.nowChord.textContent = '';
    ui.nowTime.textContent = state.score ? `0:00 / ${fmtTime(state.score.seconds)}` : '';
    if (prof) for (const n of [prof.head, prof.dot]) n.setAttribute('visibility', 'hidden');
  }

  // ---------- controls ----------

  function summarise() {
    const { route, score, city } = state;
    if (state.from == null || state.to == null) {
      ui.summary.textContent = 'Choose a start and a destination.';
      return;
    }
    if (!route) {
      ui.summary.textContent = state.from === state.to
        ? 'Start and destination are the same station.'
        : 'No rail route between these two stations.';
      return;
    }
    const rail = route.legs.filter((l) => !l.walk);
    const changes = rail.filter((l, i) => i && l.line !== rail[i - 1].line).length;
    const mins = Math.max(1, Math.round(score.rideSeconds / 60));
    const parts = [
      `${rail.length} stop${rail.length > 1 ? 's' : ''}`,
      `${(route.dist / 1000).toFixed(1)} km`,
      changes ? `${changes} change${changes > 1 ? 's' : ''}` : null,
      SHOW[score.source].range(score.lo, score.hi),
      `ride ≈ ${mins} min`,
      score.pace > 1 ? `plays in ${fmtTime(score.seconds)}` : null,
    ].filter(Boolean);
    const strong = (t) => { const s = document.createElement('strong'); s.textContent = t; return s; };
    ui.summary.replaceChildren(strong(city.stations[state.from].name), ' → ',
      strong(city.stations[state.to].name), document.createElement('br'), parts.join(' · '));
  }

  const source = () => ui.sources.find((r) => r.checked && !r.disabled)?.value || 'elev';
  const options = () => ({ bpm: +ui.tempo.value, pace: +ui.pace.value, source: source() });

  // Remember the choices in this browser, so the same ride is ready next time.
  // (localStorage, not a cookie: nothing is sent to any server.)
  const STORE = 'subway-songlines';
  function save() {
    if (!state.city) return;
    const station = (i) => (i == null ? null : { i, name: state.city.stations[i].name });
    try {
      localStorage.setItem(STORE, JSON.stringify({
        city: state.city.id, from: station(state.from), to: station(state.to),
        source: source(), style: ui.style.value, pace: ui.pace.value, tempo: ui.tempo.value,
      }));
    } catch { /* private mode or storage disabled: carry on without */ }
  }
  function saved() {
    try { return JSON.parse(localStorage.getItem(STORE)) || {}; } catch { return {}; }
  }
  // Station numbers shift when a city's data is rebuilt, so trust the name.
  function findStation(city, ref) {
    if (!ref) return null;
    if (city.stations[ref.i]?.name === ref.name) return ref.i;
    const i = city.stations.findIndex((st) => st.name === ref.name);
    return i < 0 ? null : i;
  }

  // New route: start over.
  function recompute() {
    player.stop();
    releaseWake();
    ui.play.textContent = 'Play';
    state.route = state.from != null && state.to != null && state.from !== state.to
      ? findRoute(state.from, state.to) : null;
    state.score = state.route ? compose(state.route, ui.style.value, options()) : null;
    player.load(state.score);
    for (const b of [ui.play, ui.prev, ui.next]) b.disabled = !state.score;
    ui.from.value = state.from ?? '';
    ui.to.value = state.to ?? '';
    drawRoute();
    drawProfile();
    clearPosition();
    summarise();
    save();
    announce();
  }

  // Same route, different style / tempo / pace: keep the place in the journey.
  function restyle() {
    if (!state.route) return;
    const old = state.score, step = player.step;
    const bar = old.bars[Math.min(Math.floor(step / STEPS), old.bars.length - 1)];
    const seg = old.segs[bar.seg];
    const frac = (step / STEPS - seg.startBar) / seg.bars;
    state.score = compose(state.route, ui.style.value, options());
    const now = state.score.segs[bar.seg];
    const at = step === 0 ? 0 : Math.round((now.startBar + frac * now.bars) * STEPS);
    player.load(state.score, at);
    if (state.pos) showPosition(positionAt(player.step)); else clearPosition();
    summarise();
    save();
    announce();
  }

  // Jump to the previous / next departure or arrival, to re-sync with the train.
  function skip(dir) {
    const score = state.score;
    if (!score) return;
    const marks = score.segs.map((s) => s.startBar * STEPS);
    const here = player.step;
    const target = dir > 0
      ? marks.find((m) => m > here)
      // Back: to the start of this segment, or the one before if we just got here.
      : [...marks].reverse().find((m) => m < here - STEPS * 2) ?? 0;
    if (target == null) return;
    player.seek(target);
    showPosition(positionAt(target));
  }

  function pick(i) {
    if (state.from == null || state.to != null) { state.from = i; state.to = null; }
    else if (i !== state.from) state.to = i;
    recompute();
  }

  async function play() {
    if (!state.score) return;
    await player.play();
    holdWake();
    ui.play.textContent = 'Pause';
    announce();
  }

  function pause() {
    player.pause();
    releaseWake();
    ui.play.textContent = 'Resume';
    announce();
  }

  // Lock-screen and headphone controls: what is playing, play/pause, and the
  // skip buttons for re-syncing with the train.
  const media = navigator.mediaSession;
  function announce() {
    if (!media || !state.route) return;
    const name = (i) => state.city.stations[i].name;
    media.metadata = new MediaMetadata({
      title: `${name(state.from)} → ${name(state.to)}`,
      artist: `${state.city.name} · ${Songlines.SOURCES[state.score.source].label.toLowerCase()}`,
      album: 'Subway Songlines',
      artwork: [{ src: 'apple-touch-icon.png', sizes: '180x180', type: 'image/png' }],
    });
    media.playbackState = player.playing ? 'playing' : 'paused';
    announcePosition(player.step);
  }
  function announcePosition(step) {
    if (!media?.setPositionState || !state.score) return;
    const duration = state.score.seconds;
    try {
      media.setPositionState({ duration, position: Math.min(duration, step * 30 / state.score.bpm), playbackRate: 1 });
    } catch { /* some browsers reject position state for live streams */ }
  }
  function bindMediaKeys() {
    if (!media) return;
    const on = (action, fn) => { try { media.setActionHandler(action, fn); } catch { /* unsupported action */ } };
    on('play', play);
    on('pause', pause);
    on('previoustrack', () => skip(-1));
    on('nexttrack', () => skip(1));
  }

  // Keep the screen on during a ride as well, so the map stays visible.
  let wake = null;
  async function holdWake() {
    try { wake = await navigator.wakeLock?.request('screen'); } catch { wake = null; }
  }
  function releaseWake() { wake?.release().catch(() => {}); wake = null; }
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible' || !player.playing) return;
    holdWake();
    player.wake();
    showPosition(positionAt(Math.max(0, player.step - 1)));
  });

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = src; s.onload = resolve; s.onerror = () => reject(new Error(`Could not load ${src}`));
      document.head.appendChild(s);
    });
  }

  async function loadCity(id, restore) {
    if (!CITIES[id]) {
      ui.summary.textContent = 'Loading…';
      try { await loadScript(`data/${id}.js`); } catch (e) { ui.summary.textContent = e.message; return; }
    }
    const city = CITIES[id];
    state.city = city;
    state.graph = buildGraph(city);
    state.hover = state.from = state.to = state.route = state.score = null;
    player.stop();
    $('dem').textContent = city.dem || 'digital elevation model';
    $('sources').textContent = city.layers
      ? ` Population: ${city.layers.pop}. Green space: ${city.layers.green}.` : '';
    // Cities built before add-layers.mjs was run only have terrain.
    for (const r of ui.sources) r.disabled = !city.edges[0][r.value];
    project(city);
    // Same name, different station (New York has five "23rd Street"s): say
    // which lines call there.
    const count = new Map();
    for (const st of city.stations) count.set(st.name, (count.get(st.name) || 0) + 1);
    const short = (l) => city.lines[l].name.replace(/ train$| line$|^Line /i, '');
    const names = city.stations
      .map((st, i) => [count.get(st.name) > 1
        ? `${st.name} (${state.graph.linesAt[i].map(short).join(', ')})` : st.name, i])
      .sort((a, b) => a[0].localeCompare(b[0], undefined, { numeric: true }));
    for (const sel of [ui.from, ui.to]) {
      sel.replaceChildren(new Option('—', ''), ...names.map(([n, i]) => new Option(n, i)));
    }
    paint();
    drawMap();
    state.from = findStation(city, restore?.from);
    state.to = findStation(city, restore?.to);
    if (state.from == null) {
      // A ride of eight stops or so through the middle of the first line.
      const stops = city.lines[0].stops, mid = Math.floor(stops.length / 2);
      state.from = stops[Math.max(0, mid - 4)];
      state.to = stops[Math.min(stops.length - 1, mid + 4)];
    }
    recompute();
    if (restore) fitRoute();
  }

  darkScheme.addEventListener('change', () => {
    if (!state.city) return;
    const view = state.view;
    paint(); drawMap(); setView(view); drawRoute(); drawProfile();
  });

  function init() {
    if (!INDEX.length) { ui.summary.textContent = 'No city data found — run scripts/fetch-city.mjs.'; return; }
    ui.city.replaceChildren(...INDEX.map((c) => new Option(c.name, c.id)));
    ui.style.replaceChildren(...Object.entries(STYLES).map(([k, s]) => new Option(s.label, k)));
    bindMap();

    const showTempo = () => { ui.tempoOut.textContent = `${ui.tempo.value} bpm`; };
    ui.city.onchange = () => loadCity(ui.city.value);
    ui.from.onchange = () => { state.from = ui.from.value === '' ? null : +ui.from.value; recompute(); fitRoute(); };
    ui.to.onchange = () => { state.to = ui.to.value === '' ? null : +ui.to.value; recompute(); fitRoute(); };
    $('swap').onclick = () => { [state.from, state.to] = [state.to, state.from]; recompute(); };
    ui.style.onchange = () => { ui.tempo.value = STYLES[ui.style.value].bpm; showTempo(); restyle(); };
    ui.pace.onchange = restyle;
    for (const r of ui.sources) r.onchange = () => { restyle(); drawProfile(); if (!state.pos) clearPosition(); };
    ui.tempo.oninput = showTempo;
    ui.tempo.onchange = restyle;
    $('random').onclick = () => {
      const n = state.city.stations.length;
      for (let tries = 0; tries < 30; tries++) {
        const a = Math.floor(Math.random() * n), b = Math.floor(Math.random() * n);
        const r = a !== b && findRoute(a, b);
        if (r && r.legs.length >= 5 && r.legs.length <= 22) { state.from = a; state.to = b; break; }
      }
      recompute();
      fitRoute();
    };
    ui.play.onclick = () => (player.playing ? pause() : play());
    bindMediaKeys();
    ui.prev.onclick = () => skip(-1);
    ui.next.onclick = () => skip(1);
    player.onStep = (step) => {
      // Nobody is looking while the page is hidden; just keep the lock screen's clock right.
      if (document.visibilityState === 'visible') showPosition(positionAt(step));
      if (step % (STEPS * 4) === 0) announcePosition(step);
    };
    player.onEnd = () => { ui.play.textContent = 'Play'; releaseWake(); clearPosition(); announce(); };

    // Pick up where the last visit left off.
    const last = saved();
    if (STYLES[last.style]) ui.style.value = last.style;
    if ([...ui.pace.options].some((o) => o.value === last.pace)) ui.pace.value = last.pace;
    const radio = ui.sources.find((r) => r.value === last.source);
    if (radio) radio.checked = true;
    ui.tempo.value = +last.tempo || STYLES[ui.style.value].bpm;
    showTempo();
    const known = INDEX.some((c) => c.id === last.city);
    ui.city.value = known ? last.city : INDEX[0].id;
    loadCity(ui.city.value, known ? last : null);
  }

  init();
})();
