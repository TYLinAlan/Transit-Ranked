# transitranked.com — bus corridor map

Staging copy of everything that goes into `D:\Transit_Ranked\station-ranker`.
Built here first because the site folder sits outside this repo.

## What it is

All **303 chained bus corridors** in New York City, not just the published top 50,
on an interactive MapLibre map with a ranked list beside it.

Colour and rank are driven by whichever metric is selected, so switching from
**bus delay** to **passenger delay** repaints the map into a different picture.
That switch is the argument the site makes, so it is the first control.

Per corridor: riders carried, bus trips, delay under both metrics, minutes lost
per bus, average load, share of citywide corridor delay, the routes that use it,
a weekday AM/midday/PM/evening/overnight split, and an hour-by-hour profile.

## Files

| Path | What |
|---|---|
| `src/CorridorsApp.jsx` | The whole page. No router, no state library. |
| `src/main.jsx` | Entry point. Renders `CorridorsApp`. |
| `index.html` | Title, meta, JSON-LD, and the popup CSS MapLibre needs. |
| `public/data/corridors.geojson` | 303 corridors, geometry + attributes, 0.8 MB. |
| `public/data/corridors_meta.json` | Headline totals and the field dictionary. |
| `public/static-map.html` | The standalone SVG map, no build step, as a fallback. |

Regenerate the data with `python Equity_Analysis/29_export_web.py`.

## Installing over the site

Copy `src/`, `index.html` and `public/` into `D:\Transit_Ranked\station-ranker`,
then:

```
cd D:\Transit_Ranked\station-ranker
npm run dev      # check it locally first
npm run build
```

**Nothing is deleted.** The subway station ranker stays at
`src/StationRankerApp.jsx`. To put it back, change two lines in `src/main.jsx`:

```js
import StationRankerApp from './StationRankerApp'
// ...
<StationRankerApp />
```

## Units, and one trap worth knowing

`riders_carried` and `bus_traversals` in the source parquet are summed **across
blocks**, so a rider who stays on for five blocks is counted five times. Those
sums are correct as the numerator of a ratio (riders per bus is a true mean load)
but they are not a passenger count.

The export therefore publishes:

- `riders_20d` — riders past an **average point** on the corridor over 20 days
- `bus_trips_20d` — bus trips past an average point
- `rider_block_crossings` — the raw sum, kept and clearly named

Sutphin Boulevard reads 224k riders over 20 days, roughly 11,200 a day, rather
than the 7.6M the raw block sum would suggest.

Two denominators also exist for "share of delay" and they are easy to confuse:

- **corridor delay** — 19.9M passenger-minutes, what falls on chained corridors
- **citywide delay** — 42.9M, generated across every roadway block

The top 50 hold **52.8% of corridor delay** and **24.5% of citywide delay**. The
site quotes the corridor figure and says so; both are in `corridors_meta.json`.

## Not done here

The site has **not** been deployed. Run the build and deploy yourself once you
have looked at it.
