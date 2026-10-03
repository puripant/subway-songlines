// Turns a route (legs with terrain profiles) into a score, and plays it with Tone.js.
//
// The piece lasts as long as the ride: every bar stands for a slice of the
// journey's clock time, so a rider can press play as the doors close and hear
// the ground they are passing over (or under).
//
// One data source plays at a time: terrain height, population density or the
// share of green space. Whichever is chosen drives the same mapping (described
// here in terms of height):
//   value           -> harmony. The route's lowest point is the tonic; climbing
//                      steps the chord root up the scale, descending steps it down.
//   slope           -> figure direction (rising / falling / rocking arpeggio).
//   relief          -> how many chords are in play: a flat route circles two or
//                      three, a hilly one sweeps across two octaves.
//   train speed     -> density. Voices thin out as the train brakes, a single
//                      quiet figure idles at the platform, a chime as doors close.
//   stations        -> a bell on arrival; voices accumulate over the journey.
//   line changes    -> a new key and mode, after a stretch of waiting.

(function () {
  const STEPS = 8; // eighth notes per bar
  const NOTE_NAMES = ['C', 'C♯', 'D', 'E♭', 'E', 'F', 'F♯', 'G', 'A♭', 'A', 'B♭', 'B'];
  const MODES = {
    aeolian: [0, 2, 3, 5, 7, 8, 10],
    dorian: [0, 2, 3, 5, 7, 9, 10],
    lydian: [0, 2, 4, 6, 7, 9, 11],
    mixolydian: [0, 2, 4, 5, 7, 9, 10],
    ionian: [0, 2, 4, 5, 7, 9, 11],
  };
  // One key per line, cycled. Tonics are MIDI notes around A2.
  const KEYS = [
    [45, 'aeolian'], [48, 'dorian'], [41, 'lydian'], [43, 'dorian'],
    [46, 'ionian'], [40, 'aeolian'], [50, 'mixolydian'], [47, 'aeolian'],
  ];

  const SOURCES = {
    elev: { label: 'Terrain height', unit: 3 },
    pop: { label: 'Population density', unit: 15 },
    green: { label: 'Green space', unit: 5 },
  };

  const STYLES = {
    glass: { label: 'Glass — arpeggios', bpm: 138 },
    pulse: { label: 'Reich — pulses', bpm: 152 },
    drift: { label: 'Eno — drift', bpm: 84 },
  };

  // A generic metro, in seconds and metres. Real timetables differ by a
  // minute or two per ride; the skip buttons are there to re-sync.
  const RIDE = {
    dwell: 30, // doors open at an intermediate station
    runBase: 40, // time lost accelerating and braking, per hop
    cruise: 20, // m/s between stations (72 km/h)
    change: 240, // changing lines inside a station: walk + wait
    walkSpeed: 1.2, // m/s between two nearby stations
    wait: 180, // waiting for the next train after a walk
  };

  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const fold = (midi, hi) => { while (midi > hi) midi -= 12; return midi; };
  const ease = (u) => u * u * (3 - 2 * u); // pull away, cruise, brake

  function degree(key, d) {
    const [tonic, mode] = key;
    const m = MODES[mode];
    return tonic + 12 * Math.floor(d / 7) + m[((d % 7) + 7) % 7];
  }

  function chordName(key, d) {
    const r = degree(key, d), third = degree(key, d + 2) - r, fifth = degree(key, d + 4) - r;
    const q = fifth === 6 ? '°' : third === 3 ? 'm' : '';
    return NOTE_NAMES[r % 12] + q;
  }

  // Chord level -> scale degree of the root, skipping the one degree whose
  // triad is diminished (it sounds like a wrong turn in this idiom).
  function rootDegree(key, level) {
    const good = [0, 1, 2, 3, 4, 5, 6].filter((d) => degree(key, d + 4) - degree(key, d) === 7);
    return good[level % good.length] + 7 * Math.floor(level / good.length);
  }

  function sampleProfile(elev, t) {
    const x = clamp(t, 0, 1) * (elev.length - 1);
    const i = Math.min(Math.floor(x), elev.length - 2);
    return elev[i] + (elev[i + 1] - elev[i]) * (x - i);
  }

  // The journey as clock time: run, dwell, change, walk.
  // route.legs: [{ from, to, line, dist, elev: [...], walk }]
  function timeline(route) {
    const segs = [];
    let prevRail = null, afterWalk = false;
    route.legs.forEach((leg, li) => {
      if (leg.walk) {
        segs.push({ type: 'walk', leg: li, sec: leg.dist / RIDE.walkSpeed + RIDE.wait });
        afterWalk = true;
        return;
      }
      if (prevRail && !afterWalk) {
        segs.push(prevRail.line !== leg.line
          ? { type: 'change', leg: li, sec: RIDE.change }
          : { type: 'dwell', leg: li, sec: RIDE.dwell });
      }
      segs.push({ type: 'run', leg: li, sec: RIDE.runBase + leg.dist / RIDE.cruise });
      prevRail = leg; afterWalk = false;
    });
    return { segs, total: segs.reduce((sum, s) => sum + s.sec, 0) };
  }

  const FIGURES = {
    up: [[0, 1, 2, 3, 1, 2, 3, 4], [0, 2, 1, 3, 2, 4, 3, 5]],
    down: [[4, 3, 2, 1, 3, 2, 1, 0], [5, 3, 4, 2, 3, 1, 2, 0]],
    flat: [[0, 2, 1, 2, 0, 2, 1, 2], [0, 1, 2, 1, 0, 1, 2, 1], [2, 1, 0, 1, 2, 1, 0, 1]],
  };

  // pace: 1 = real time, 4 = the ride four times faster.
  // source: which per-leg series to play: 'elev', 'pop' or 'green'.
  function compose(route, style, { bpm, pace = 1, source = 'elev' } = {}) {
    bpm = bpm || STYLES[style].bpm;
    const barSec = STEPS * 30 / bpm;
    const all = route.legs.flatMap((l) => l[source] || []);
    const lo = Math.min(...all), hi = Math.max(...all);
    const relief = hi - lo;
    // How much change counts as one step, per source: 3 m of height, 1,500
    // people/km², 5 points of green share.
    const unit = SOURCES[source].unit;
    // 3 chord levels for a pancake, up to 13 for a mountain railway.
    const levels = clamp(Math.round(2 + 2 * Math.log2(1 + relief / unit)), 3, 13);
    const harmony = (key, elev) => {
      const x = (relief ? (elev - lo) / relief : 0) * (levels - 1);
      const level = Math.round(x);
      const deg = rootDegree(key, level);
      // Where the ground sits between two chord levels picks the inversion,
      // so a gentle rise is audible before the chord itself changes.
      return { level, deg, inv: clamp(Math.floor((x - level + 0.5) * 3), 0, 2), chord: chordName(key, deg) };
    };

    const { segs, total } = timeline(route);
    const railLegs = route.legs.filter((l) => !l.walk).length;
    const bars = [];
    let railIndex = -1;
    segs.forEach((seg, si) => {
      const leg = route.legs[seg.leg];
      const n = Math.max(1, Math.round(seg.sec / pace / barSec));
      seg.startBar = bars.length; seg.bars = n;
      if (seg.type === 'run') railIndex++;
      const key = leg.walk ? null : KEYS[leg.line % KEYS.length];
      // Voices accumulate station by station, then thin out towards the end.
      const base = clamp(Math.min(railIndex + 1, railLegs - railIndex), 1, 2);
      for (let k = 0; k < n; k++) {
        const bar = { seg: si, type: seg.type, leg: seg.leg, first: k === 0, last: k === n - 1, k };
        if (seg.type === 'run') {
          bar.t0 = ease(k / n); bar.t1 = ease((k + 1) / n);
          const e0 = sampleProfile(leg[source], bar.t0), e1 = sampleProfile(leg[source], bar.t1);
          const grade = (e1 - e0) / Math.max(1, leg.dist * (bar.t1 - bar.t0));
          const mid = (k + 0.5) / n;
          Object.assign(bar, harmony(key, (e0 + e1) / 2), {
            elev: (e0 + e1) / 2, key, railIndex,
            dir: Math.abs(grade) < unit * 0.002 ? 0 : Math.sign(grade),
            layer: base + (mid > 0.2 && mid < 0.8 ? 1 : 0),
          });
        } else if (seg.type === 'dwell') {
          bar.t0 = bar.t1 = 0;
          Object.assign(bar, harmony(key, leg[source][0]), { elev: leg[source][0], key, dir: 0, layer: 0, railIndex });
        } else if (seg.type === 'change') {
          bar.t0 = bar.t1 = 0;
        } else { // walk: about a third of it is waiting on the next platform
          const walking = Math.max(1, Math.round(n * (leg.dist / RIDE.walkSpeed) / seg.sec));
          bar.t0 = Math.min(1, k / walking); bar.t1 = Math.min(1, (k + 1) / walking);
          bar.waiting = k >= walking;
        }
        bars.push(bar);
      }
    });
    // Arrival: hold the destination's chord.
    const lastLeg = [...route.legs].reverse().find((l) => !l.walk);
    const lastKey = KEYS[lastLeg.line % KEYS.length];
    const endElev = lastLeg[source][lastLeg[source].length - 1];
    segs.push({ type: 'final', leg: route.legs.lastIndexOf(lastLeg), sec: 0, startBar: bars.length, bars: 2 });
    for (let k = 0; k < 2; k++) {
      bars.push({ seg: segs.length - 1, type: 'final', leg: route.legs.lastIndexOf(lastLeg), t0: 1, t1: 1,
        first: k === 0, last: k === 1, k, ...harmony(lastKey, endElev), elev: endElev, key: lastKey });
    }

    const steps = Array.from({ length: bars.length * STEPS }, () => []);
    let prev = null; // last bar that had a chord
    bars.forEach((bar, b) => {
      const at = (k) => steps[b * STEPS + k];
      if (bar.type === 'change' || bar.type === 'walk') {
        // Between trains: the last chord hangs in the air, footsteps, then quiet.
        if (prev && bar.k % 4 === 0) at(0).push(['pad', degree(prev.key, prev.deg) + 12, STEPS * 3, 0.22]);
        const afoot = bar.type === 'walk' ? !bar.waiting : bar.k < 12;
        if (afoot) for (let k = 0; k < STEPS; k += 2) at(k).push(['tick', 76, 0.5, 0.1]);
        return;
      }
      const root = degree(bar.key, bar.deg);
      // Chord tones stacked over two octaves, relative to the arpeggio register.
      const T = [0, 2, 4, 7, 9, 11].map((d) => degree(bar.key, bar.deg + d) + 12);
      const tone = (i) => T[clamp(i + bar.inv, 0, 5)];
      const bass = fold(root, 50);
      const changed = !prev || prev.chord !== bar.chord || prev.key !== bar.key;

      if (bar.type === 'final') {
        if (bar.first) {
          at(0).push(['bell', fold(root + 36, 96), 6, 0.35], ['bell', fold(root + 43, 96), 6, 0.25]);
          [T[0], T[2], T[4]].forEach((m) => at(0).push(['pad', fold(m, 84), STEPS * 2, 0.4]));
          at(0).push(['bass', bass, STEPS * 2, 0.6]);
        }
        prev = bar;
        return;
      }
      if (bar.type === 'dwell') {
        if (bar.first) at(0).push(['bell', fold(root + 36, 96), 6, 0.35]);
        // Door chime, then away.
        if (bar.last) {
          at(4).push(['bell', fold(root + 31, 91), 2, 0.2]);
          at(6).push(['bell', fold(root + 24, 91), 2, 0.2]);
        }
      }
      // Phrases of four bars cycle through figure variants.
      const phrase = Math.floor(bar.k / 4);

      if (style === 'glass') {
        const set = FIGURES[bar.dir > 0 ? 'up' : bar.dir < 0 ? 'down' : 'flat'];
        const fig = set[phrase % set.length];
        const quiet = bar.type === 'dwell' ? 0.6 : 1;
        for (let k = 0; k < STEPS; k++) {
          at(k).push(['organ', fold(tone(fig[k]), 84), 0.9, (k % 4 === 0 ? 0.5 : 0.36) * quiet]);
          // Three-note cycle against the bar of eight, never resetting.
          if (bar.layer >= 2) {
            const g = [2, 1, 0][(b * STEPS + k) % 3];
            at(k).push(['soft', fold(T[g] + 12, 91), 0.8, 0.22]);
          }
        }
        if (changed || bar.k % 2 === 0) at(0).push(['bass', bass, STEPS, changed ? 0.6 : 0.4]);
        if (bar.layer >= 3) {
          at(0).push(['pad', fold(T[5], 88), 4, 0.25]);
          at(4).push(['pad', fold(T[4], 88), 4, 0.25]);
        }
      } else if (style === 'pulse') {
        const P = [1, 0, 1, 1, 0, 1, 1, 0];
        let hit = 0;
        for (let k = 0; k < STEPS; k++) {
          if (P[k] && (bar.type !== 'dwell' || k === 0 || k === 3)) {
            const i = bar.dir < 0 ? 2 - (hit % 3) : hit % 3;
            at(k).push(['marimba', tone(i), 0.6, k === 0 ? 0.6 : 0.42]);
            hit++;
          }
          // Same pattern, slipped one more eighth every phrase.
          if (bar.layer >= 2 && P[(k + bar.railIndex + phrase) % STEPS]) {
            at(k).push(['marimba', fold(T[(k % 2) + 3], 88), 0.6, 0.28]);
          }
          if (bar.layer >= 3) at(k).push(['soft', fold(T[2] + 12, 88), 0.5, 0.14]);
        }
        at(0).push(['bass', bass, 3, changed ? 0.6 : 0.4]);
        if (bar.type !== 'dwell') at(5).push(['bass', bass + 7, 3, 0.3]);
      } else { // drift
        at(0).push(['bass', bass, STEPS, 0.45]);
        at(0).push(['pad', T[0], STEPS, 0.3]);
        at(2).push(['pad', T[2], STEPS - 2, 0.26]);
        if (bar.layer >= 2) at(4).push(['pad', T[4], STEPS - 4, 0.24]);
        if (bar.type !== 'dwell') {
          // One drop per bar; it lands later and higher the higher the ground.
          const h = relief ? (bar.elev - lo) / relief : 0;
          const k = Math.round(h * (STEPS - 1));
          at(k).push(['bell', fold(T[[3, 5, 4][b % 3]] + 12, 93), 4, 0.14 + 0.12 * h]);
        }
      }
      prev = bar;
    });

    return { source, bars, steps, segs, lo, hi, relief, levels, style, bpm, pace,
      rideSeconds: total, seconds: steps.length * 30 / bpm };
  }

  class Player {
    constructor() {
      this.score = null;
      this.step = 0;
      this.onStep = () => {};
      this.onEnd = () => {};
      this.ready = false;
      this.eventId = null;
    }

    init() {
      if (this.ready) return;
      // Schedule a little further ahead than the default 0.1 s, so a throttled
      // background page still gets its notes in on time.
      Tone.getContext().lookAhead = 0.3;
      const reverb = new Tone.Reverb({ decay: 5, wet: 0.28 });
      const out = new Tone.Limiter(-2);
      reverb.connect(out);
      this.route(out);
      const poly = (voice, opts, vol) => {
        const s = new Tone.PolySynth(voice, opts);
        s.maxPolyphony = 24;
        s.volume.value = vol;
        return s.connect(reverb);
      };
      this.inst = {
        // Reedy, a little like the Farfisa of the early Glass ensemble.
        organ: poly(Tone.Synth, {
          oscillator: { type: 'custom', partials: [1, 0.45, 0.3, 0.05, 0.12] },
          envelope: { attack: 0.006, decay: 0.12, sustain: 0.3, release: 0.12 },
        }, -14),
        soft: poly(Tone.Synth, {
          oscillator: { type: 'sine' },
          envelope: { attack: 0.01, decay: 0.15, sustain: 0.2, release: 0.2 },
        }, -14),
        pad: poly(Tone.Synth, {
          oscillator: { type: 'custom', partials: [1, 0.2, 0.08] },
          envelope: { attack: 0.5, decay: 0.4, sustain: 0.8, release: 2 },
        }, -16),
        bass: poly(Tone.Synth, {
          oscillator: { type: 'custom', partials: [1, 0.5, 0.15] },
          envelope: { attack: 0.03, decay: 0.3, sustain: 0.7, release: 0.8 },
        }, -10),
        marimba: poly(Tone.Synth, {
          oscillator: { type: 'custom', partials: [1, 0, 0, 0.25] },
          envelope: { attack: 0.002, decay: 0.28, sustain: 0, release: 0.25 },
        }, -8),
        bell: poly(Tone.FMSynth, {
          harmonicity: 3.01, modulationIndex: 6,
          envelope: { attack: 0.002, decay: 2.2, sustain: 0, release: 2 },
          modulationEnvelope: { attack: 0.002, decay: 0.8, sustain: 0, release: 1 },
        }, -14),
        tick: poly(Tone.Synth, {
          oscillator: { type: 'sine' },
          envelope: { attack: 0.001, decay: 0.05, sustain: 0, release: 0.05 },
        }, -12),
      };
      this.ready = true;
    }

    // Send the sound out through an <audio> element rather than straight to the
    // speakers. To a phone that makes it media playback, which is allowed to
    // carry on when the screen locks or another app comes forward; plain
    // synthesised Web Audio is suspended. Falls back to the direct path if the
    // browser will not have it.
    route(out) {
      try {
        const dest = Tone.getContext().createMediaStreamDestination();
        out.connect(dest);
        this.media = new Audio();
        this.media.srcObject = dest.stream;
        this.direct = () => { out.disconnect(dest); out.toDestination(); this.media = null; };
      } catch {
        out.toDestination();
        this.media = null;
      }
    }

    // After an interruption (a call, the lock screen) make sure sound is flowing.
    async wake() {
      if (!this.ready || !this.playing) return;
      if (Tone.getContext().state !== 'running') await Tone.getContext().resume().catch(() => {});
      if (this.media?.paused) await this.media.play().catch(() => {});
    }

    // Swap in a new score; `step` keeps the place when only the style or
    // tempo changed.
    load(score, step = 0) {
      const wasPlaying = this.playing;
      this.silence();
      this.score = score;
      this.step = clamp(step, 0, score ? score.steps.length - 1 : 0);
      if (score) Tone.Transport.bpm.value = score.bpm;
      if (!score && wasPlaying) this.stop();
    }

    silence() {
      if (this.ready) Object.values(this.inst).forEach((i) => i.releaseAll());
    }

    seek(step) {
      this.silence();
      this.step = clamp(step, 0, this.score.steps.length - 1);
    }

    async play() {
      await Tone.start();
      this.init();
      if (!this.score) return;
      if (this.media) {
        try { await this.media.play(); } catch { this.direct(); }
      }
      if (this.eventId === null) {
        this.eventId = Tone.Transport.scheduleRepeat((time) => this.tick(time), '8n');
      }
      Tone.Transport.start();
    }

    pause() { Tone.Transport.pause(); this.silence(); this.media?.pause(); }

    stop() {
      Tone.Transport.stop();
      if (this.eventId !== null) { Tone.Transport.clear(this.eventId); this.eventId = null; }
      this.silence();
      this.media?.pause();
      this.step = 0;
    }

    get playing() { return Tone.Transport.state === 'started'; }

    tick(time) {
      const { steps } = this.score;
      const step = this.step;
      if (step >= steps.length) {
        // Let the last chord ring before resetting.
        Tone.Draw.schedule(() => { this.stop(); this.onEnd(); }, time);
        return;
      }
      const eighth = Tone.Time('8n').toSeconds();
      for (const [name, midi, dur, vel] of steps[step]) {
        this.inst[name].triggerAttackRelease(Tone.Frequency(midi, 'midi').toFrequency(),
          dur * eighth, time, vel);
      }
      Tone.Draw.schedule(() => this.onStep(step), time);
      this.step++;
    }
  }

  window.Songlines = { compose, timeline, Player, STYLES, SOURCES, STEPS };
})();
