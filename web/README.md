# transitranked.com — where bus delay lands

The site Vercel builds. Vite + React + MapLibre, no router and no state library.

## What it is

Two layers over the New York bus network, and the difference between them is the
point of the site.

| Layer | Count | Miles | Passenger-minutes | What it answers |
|---|---|---|---|---|
| **Runs** | 3,628 stretches | 1,491 | 42,886,742 | Where delay actually lands |
| **Corridors** | 300 chained | 194 | 19,994,074 | Where you would build something |

Corridors are a selection carved out of the roads: 47% of the citywide delay on 13%
of the network. Roads are the whole thing, so no delay is hidden behind the chaining
step. The view toggle is the first control in the panel.

The threshold that picks corridors is a percentile taken **within each borough**, not
citywide. A citywide cut is a citywide competition and Staten Island loses it: its
median block runs 131 passenger-min per 100 ft against 294-332 elsewhere, so only 13%
of its network qualified, and Richmond Avenue, one of DOT's own 50 priority corridors,
produced no corridor at all.

Corridors is the default view at the top 50. The header carries every figure for
whatever is on screen -- riders, passenger-minutes, bus-minutes, bus trips, count and
centreline miles -- each with its per-day rate underneath, and the two delay figures also carry their share of the citywide total. It tracks both layers.

A **run** is a continuous stretch of one street: consecutive blocks that share a LION
node, carry the same name and keep going in the same direction. It is the corridor
chaining with the delay threshold removed, so corridors are a strict subset of runs.

This replaced an earlier layer that dissolved blocks by street and borough. That did
not require the blocks to touch, so Broadway in Manhattan was one row averaging 17.6
miles when it is 18 separate stretches on the ground, and Flatbush Avenue in Brooklyn
was one row of 11.64 miles when it is 5. Runs have no length floor, so every one of
the 42.9M passenger-minutes still lands somewhere.

Colour and rank follow whichever metric is selected, so switching from **bus delay**
to **passenger delay** repaints the map into a different picture. That switch is the
argument the site makes, so it sits directly under the view toggle.

Per street or corridor: riders carried, bus trips, delay under both metrics, minutes
lost per bus, average load, share of delay, the routes that use it, a weekday
AM/midday/PM/evening/overnight split, and an hour-by-hour profile.

## Files

| Path | What |
|---|---|
| `src/CorridorsApp.jsx` | The whole page. |
| `src/main.jsx` | Entry point. Renders `CorridorsApp`. |
| `index.html` | Title, meta, JSON-LD, inline favicon, popup CSS. |
| `public/data/runs.geojson` | 3,628 street runs, geometry + attributes, 5.4 MB. |
| `public/data/runs_meta.json` | Headline totals for the run layer. |
| `public/data/corridors.geojson` | 300 corridors, 0.8 MB. |
| `public/data/corridors_meta.json` | Headline totals and the field dictionary. |
| `public/transitranked_corridors.html` | Both layers as ONE file, no build, no network. |
| `public/static-map.html` | The older top-50 SVG map, kept as a fallback. |

## Running it

```
cd web
npm install
npm run dev      # look at it first
npm run build
```

Vercel builds from `web/` with `npm run build` and serves `web/dist`.

## Where the data comes from

The two geojson files are generated in the `gtfs-service-audit` repo and copied here:

```
python Equity_Analysis/29_export_web.py       # corridors.geojson
python Equity_Analysis/32_export_runs.py      # runs.geojson
python Equity_Analysis/30_standalone_site.py  # the single-file version, run last
```

Twenty days of MTA GTFS-Realtime trip updates, 2026-06-26 to 2026-07-15, matched to
LION street centrelines and weighted by stop-level automated passenger counts.

## The standalone file

`/transitranked_corridors.html` is 4.5 MB and makes **zero** network requests:
geometry inlined as SVG paths, attributes as a JS array, pan and zoom by rewriting
the viewBox. It opens from a USB stick, a file share, or an email attachment and
behaves identically. Useful for anyone who cannot reach the site.

## Units, and three traps worth knowing

**Riders are averaged along the length, not summed.** `riders_carried` and
`bus_traversals` in the source data are summed across blocks, so a rider who stays on
for five blocks is counted five times. Those sums are correct as the numerator of a
ratio (riders per bus is a true mean load) but they are not a passenger count. The
export publishes `riders_20d`, riders past an **average point**, and keeps the raw
sum as `rider_block_crossings` on the corridor layer. Sutphin Boulevard reads 224k
riders over 20 days, roughly 11,200 a day, rather than the 7.6M the raw block sum
would suggest.

**Centreline miles come from distinct SegmentIDs.** Length is a property of the
street, not of the direction rows. Summing segment length over segment-directions
double counts every two-way street and gives 2,247 miles against the true 1,491.

**Two denominators exist for "share of delay".** The corridor layer quotes share of
the 20.0M that falls on chained corridors; the road layer quotes share of the 42.9M
generated citywide. Each panel says which. The top 50 hold **52.7% of corridor
delay** and **24.5% of citywide delay** — both are in `corridors_meta.json`.

## Notes

- The favicon is an inline SVG so nothing 404s. To use a real logo, put
  `TransitRanked.png` in `public/` and point the `<link rel="icon">` at it.
- Basemap tiles come from OpenStreetMap and are the only external request the built
  site makes.
