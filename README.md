# Subway Songlines

Pick two stations on a subway system and the web app turns a selected data along the route into a
piece of minimal music that lasts as long as the ride. You can press play as the doors close and hear the data on the way.

It is a static page with no build step. Open `index.html` in a browser or serve
the folder:

```bash
python3 -m http.server 8421
```

Audio is synthesized in the browser with [Tone.js](https://tonejs.github.io), loaded from a CDN.

## Data Sonification

You choose one data source to play: terrain height, population density, or green space. Whichever you choose drives the same single track.

- **Value sets the chord.** The lowest value on the route is the home chord; the chord root climbs the scale as the value rises.
- **Slope sets the figure.** The arpeggio rises when the value is climbing, falls when it is dropping, and rocks back and forth when it is steady.
- **Range sets the palette.** A route where the value hardly changes circles a few chords; one with big swings sweeps across many.

The ride itself shapes the music too: voices thin out as the train brakes, one quiet figure idles at each platform, a bell marks arrivals and a two-note chime the doors closing. Each line has its own key, so changing lines changes key.

However, ride time comes from a generic metro model, not from timetables: about 72 km/h between stations plus 40 s per hop for accelerating and braking, 30 s at each station, 4 minutes for a line change, and walking time plus 3 minutes for a transfer between nearby stations. Real rides differ by a minute or two, so the skip buttons (⏮ and ⏭) jump to the previous or next departure or arrival to re-sync. The pace control plays the same ride 2×, 5× or 15× faster for listening at a desk.

There are three styles: Glass (arpeggios), Reich (pulses) and Eno (drift).

Your last city, route, data source, style, pace, and tempo are remembered in the browser (`localStorage`; nothing is sent anywhere). Sound is sent through an audio element and registered with the phone's media controls, so it should keep playing when the screen locks or another app comes forward, with play/pause and the skip buttons on the lock screen. Phone browsers differ here; iOS Safari is the strictest.

## Data Processing

There are 9 subway systems: Bangkok, Tokyo, Seoul, Shanghai, Beijing, Hong Kong, New York, London, and Lisbon. Lines and stations are from OpenStreetMap (OSM) via Overpass; only what OSM tags as `route=subway` (plus monorail in Bangkok) so some suburban and airport lines are missing. 

Bangkok terrain heights are from Copernicus GLO-90 via Open-Meteo while others are from SRTM 90m via Open Topo Data. Population density is from GHSL GHS-POP 2025 at 3 arc-second grid (~100 m); the metric is averaged over the 3×3 cells around each sample. Green space is from ESA WorldCover 2021 at 10m; it includes tree cover, shrubland, grassland, cropland, wetland and mangroves.

Everything is sampled every ~100 m on **straight lines between stations**, not along the real track, and it describes the surface, not the tunnel. A harbour crossing dips to sea level; a tunnel under a hill climbs it.

To rebuild the data,

```bash
npm install
node scripts/fetch-city.mjs --dem=srtm tokyo   # lines, stations, terrain
node scripts/add-layers.mjs tokyo              # population and green space
```

To add a city, add a name and bounding box to `CITIES` in `scripts/fetch-city.mjs` and run both scripts. Downloads are cached in `.cache/`; the population tiles in `.cache/ghsl/` are 50–150 MB each and can be deleted afterwards.

File structure:
- `index.html`: the main page
- `app.js`: routing, map, profile chart, controls
- `music.js`: the composer (route → score) and the Tone.js player
- `data/`: one file per city, loaded on demand
- `scripts/`: data pipeline

## Prompts

This project was built with Claude Code (Opus 5.5 at medium effort). The following are the prompts.

> I have an idea for a webapp called Subway Songlines. A user selects a starting and departing subway stations. The webapp will generate music from geographical terrain heights along the subway path. I think the style should be minimal like Philip Glass music but other styles are welcome. The music-playing library can be anything; I came across tone.js https://tonejs.github.io which may be helpful.

> The generated music length should roughly match the time to ride the subway; a user can use this web app, ride the train, and get the sense of geographical terrain in real time.
>
> I also want more data for New York, London, Tokyo, Seoul, Shanghai, and Beijing.

> Wonder if I can add more data besides geographical terrain along subway lines. Any data available in most cities on the list and different on subway station level? Crime rate?

> I want to add population density and green space. They are different from geographical terrain and will be more in the theme of sonification. Add a UI to choose if or which data should be played.
>
> Update the tagline; possibly "Hear the data ..." Also, update readme to describe the project and include my prompts, verbatim, except the move instruction.

> I think playing only one main track just like in the beginning is better. The user has to choose the data source to play; cannot play many datasets at the same time.

> Add a cookie(?) to save the previously selected options so the user can go back to the same route easily next time he/she opens the web.
>
> Also, add all social media images/information for sharing online. The URL will be at https://puripant.github.io/subway-songlines/

> I think the touch icon and favicon should be like subway line but like letter S

> Is there a way to make the web app keep playing sound when it's not active?

> build option 1
