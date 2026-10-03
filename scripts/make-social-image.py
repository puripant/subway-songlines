#!/usr/bin/env python3
"""Draws the link-preview image (social.png, 1200x630) and the home-screen icon
(apple-touch-icon.png, 180x180). The preview uses real data: Bangkok's network
and the population profile along the Sukhumvit Line.

    python3 scripts/make-social-image.py      # needs Pillow; fonts are macOS's
"""
import json
import math
import re
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parent.parent
S = 2  # supersampling, for smooth lines
W, H = 1200 * S, 630 * S
PAPER, INK, MUTED, RULE, ACCENT = '#141413', '#ebe7dd', '#8c877c', '#2e2d2a', '#ef6a55'
FONTS = '/System/Library/Fonts'


def font(path, size, index=0):
    return ImageFont.truetype(f'{FONTS}/{path}', size * S, index=index)


def named(path, style, size):
    """Pick a face out of a .ttc collection by its style name."""
    for index in range(12):
        try:
            f = font(path, size, index)
        except OSError:
            break
        if f.getname()[1] == style:
            return f
    return font(path, size)


def load_city(city_id):
    text = (ROOT / 'data' / f'{city_id}.js').read_text()
    return json.loads(re.search(r'= (\{.*\});\s*$', text, re.S).group(1))


def lighten(hex_colour, amount):
    r, g, b = (int(hex_colour[i:i + 2], 16) for i in (1, 3, 5))
    return tuple(round(v + (255 - v) * amount) for v in (r, g, b))


def draw_network(d, city, box, width, dot):
    x0, y0, x1, y1 = box
    lat0 = sum(s['lat'] for s in city['stations']) / len(city['stations'])
    k = math.cos(math.radians(lat0))
    xs = [s['lon'] * k for s in city['stations']]
    ys = [-s['lat'] for s in city['stations']]
    scale = min((x1 - x0) / (max(xs) - min(xs)), (y1 - y0) / (max(ys) - min(ys)))
    ox = x0 + ((x1 - x0) - (max(xs) - min(xs)) * scale) / 2
    oy = y0 + ((y1 - y0) - (max(ys) - min(ys)) * scale) / 2
    xy = [(ox + (x - min(xs)) * scale, oy + (y - min(ys)) * scale) for x, y in zip(xs, ys)]
    for e in city['edges']:
        colour = lighten(city['lines'][e['line']]['color'], 0.25)
        d.line([xy[e['a']], xy[e['b']]], fill=colour, width=width)
    for x, y in xy:
        d.ellipse([x - dot, y - dot, x + dot, y + dot], fill=PAPER, outline=INK, width=max(1, S))
    return xy


def smooth(values, radius):
    out = []
    for i in range(len(values)):
        window = values[max(0, i - radius):i + radius + 1]
        out.append(sum(window) / len(window))
    return out


def social():
    city = load_city('bangkok')
    img = Image.new('RGB', (W, H), PAPER)
    d = ImageDraw.Draw(img)

    # The network, on the right.
    draw_network(d, city, (640 * S, 40 * S, 1160 * S, 430 * S), 3 * S, 3 * S)

    # Population along the longest line, across the bottom.
    line = 0
    stops = city['lines'][line]['stops']
    edges = {(e['a'], e['b']): e for e in city['edges'] if e['line'] == line}
    series, marks = [], [0]
    for a, b in zip(stops, stops[1:]):
        e = edges.get((a, b)) or edges.get((b, a))
        if not e:
            continue
        series += e['pop'] if (a, b) in edges else e['pop'][::-1]
        marks.append(len(series) - 1)
    series = smooth(series, 3)
    left, right, base, top = 64 * S, W - 64 * S, 566 * S, 456 * S
    colour = lighten(city['lines'][line]['color'], 0.15)
    pts = [(left + (right - left) * i / (len(series) - 1),
            base - (base - top) * v / max(series)) for i, v in enumerate(series)]
    d.polygon(pts + [(right, base), (left, base)], fill=tuple(round(c * 0.22 + 20 * 0.78) for c in colour))
    d.line(pts, fill=colour, width=3 * S, joint='curve')
    d.line([(left, base), (right, base)], fill=RULE, width=S)
    for m in marks:
        x = left + (right - left) * m / (len(series) - 1)
        d.ellipse([x - 3 * S, base - 3 * S, x + 3 * S, base + 3 * S], fill=PAPER, outline=INK, width=S)
    # Playhead.
    i = int(len(pts) * 0.41)
    d.line([(pts[i][0], top - 14 * S), (pts[i][0], base)], fill=ACCENT, width=2 * S)
    d.ellipse([pts[i][0] - 6 * S, pts[i][1] - 6 * S, pts[i][0] + 6 * S, pts[i][1] + 6 * S], fill=ACCENT)

    title = named('Supplemental/Iowan Old Style.ttc', 'Italic', 92)
    body = named('HelveticaNeue.ttc', 'Regular', 30)
    small = named('HelveticaNeue.ttc', 'Regular', 19)
    d.text((64 * S, 62 * S), 'Subway', font=title, fill=INK)
    d.text((64 * S, 162 * S), 'Songlines', font=title, fill=INK)
    d.text((66 * S, 288 * S), 'Hear the data along the line,', font=body, fill=MUTED)
    d.text((66 * S, 328 * S), 'for as long as the ride takes.', font=body, fill=MUTED)
    d.text((66 * S, 392 * S), 'TERRAIN  ·  POPULATION  ·  GREEN SPACE', font=small, fill=INK)
    label = 'BANGKOK  ·  HONG KONG  ·  LISBON  ·  NEW YORK  ·  LONDON  ·  TOKYO  ·  SEOUL  ·  SHANGHAI  ·  BEIJING'
    d.text((66 * S, 588 * S), label, font=small, fill=MUTED)

    img.resize((1200, 630), Image.LANCZOS).save(ROOT / 'social.png', optimize=True)


def icon():
    n = 180 * 4
    u = n / 64  # same 64-unit grid as favicon.svg
    img = Image.new('RGB', (n, n), PAPER)
    d = ImageDraw.Draw(img)
    # A subway line bent into an S, with three stations: the favicon's mark.
    w = round(6 * u)
    for x0, x1, y in ((26, 46, 14), (26, 38, 32), (18, 38, 50)):
        d.line([(x0 * u, y * u), (x1 * u, y * u)], fill=ACCENT, width=w)
    half = w / 2
    # Upper bend bulges left, lower bend bulges right.
    d.arc([17 * u - half, 14 * u - half, 35 * u + half, 32 * u + half], 90, 270, fill=ACCENT, width=w)
    d.arc([29 * u - half, 32 * u - half, 47 * u + half, 50 * u + half], 270, 90, fill=ACCENT, width=w)
    for x, y in ((46, 14), (32, 32), (18, 50)):
        r = 5 * u
        d.ellipse([x * u - r, y * u - r, x * u + r, y * u + r], fill=PAPER, outline=INK, width=round(2.5 * u))
    img.resize((180, 180), Image.LANCZOS).save(ROOT / 'apple-touch-icon.png', optimize=True)


social()
icon()
print('wrote social.png and apple-touch-icon.png')
