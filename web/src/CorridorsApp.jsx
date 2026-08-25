import { useEffect, useMemo, useRef, useState } from 'react'
import maplibregl from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'

/*  New York bus corridors and streets, ranked by passenger-minutes lost.
 *
 *  TWO LAYERS:
 *    CORRIDORS  300 chained runs of contiguous qualifying block, 194 miles.
 *               20.0M passenger-minutes, 47% of the citywide total on 13% of the
 *               network. The default view, because it is the unit a planner acts on.
 *    RUNS       3,628 continuous stretches of bus-carrying street, the whole
 *               network, 1,491 centreline miles, all 42.9M passenger-minutes.
 *               A run ends where the street does, so unlike a dissolve by name
 *               every row is somewhere you could walk end to end.
 *
 *  Colour encodes the ACTIVE METRIC, never rank, so switching metric repaints the map
 *  into a different picture. That switch is the argument, so it sits near the top.
 *
 *  Data comes from Equity_Analysis/29_export_web.py and 32_export_runs.py.
 */

const SRC = {
  corridors: { data: '/data/corridors.geojson', meta: '/data/corridors_meta.json',
               idKey: 'corridor_id' },
  runs: { data: '/data/runs.geojson', meta: '/data/runs_meta.json',
          idKey: 'run_id' },
}

const DAYS = 20              // the study window, for turning totals into daily rates
/* The window as a strip of cells. Built here rather than from Date arithmetic at
 * render time so the page has no timezone behaviour: a viewer in Auckland and one in
 * Los Angeles must see the same twenty days. Independence Day falls inside it and is
 * marked, because a holiday Saturday is not an ordinary Saturday for bus ridership. */
const CALENDAR = [
  ['Jun', 26, 'Fri'], ['Jun', 27, 'Sat'], ['Jun', 28, 'Sun'], ['Jun', 29, 'Mon'],
  ['Jun', 30, 'Tue'], ['Jul', 1, 'Wed'], ['Jul', 2, 'Thu'], ['Jul', 3, 'Fri'],
  ['Jul', 4, 'Sat'], ['Jul', 5, 'Sun'], ['Jul', 6, 'Mon'], ['Jul', 7, 'Tue'],
  ['Jul', 8, 'Wed'], ['Jul', 9, 'Thu'], ['Jul', 10, 'Fri'], ['Jul', 11, 'Sat'],
  ['Jul', 12, 'Sun'], ['Jul', 13, 'Mon'], ['Jul', 14, 'Tue'], ['Jul', 15, 'Wed'],
]
const HOLIDAY = 'Jul 4'

const INK = '#1c1c1e'
const MUTED = '#6d6e71'
const FAINT = '#93918d'
const LINE = '#e3e1dd'
const ORANGE = '#F26724'
const BLUE = '#476AA3'
const PAPER = '#ffffff'
const UI = '"Public Sans", "Segoe UI", system-ui, -apple-system, sans-serif'
const FIG = '"Source Serif 4", Cambria, Georgia, serif'
const CARTO_CREDIT =
  '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>' +
  ' contributors &copy; <a href="https://carto.com/attributions">CARTO</a>'

/* Single-hue ramps, magnitude by lightness. Every step is solved to a fixed contrast
 * ratio against the basemap land colour (1.95 / 2.72 / 3.80 / 5.30 / 7.40) with an
 * even 1.40 between neighbours, so the bottom class still reads as a line instead of
 * disappearing into the map. The old ramp bottomed out at 1.18, which is why the low
 * ranks were invisible. */
const RAMP_PAX = ['#EE9C65', '#E97121', '#C75A11', '#A3490C', '#813908']
const RAMP_BUS = ['#98B1D1', '#7395C3', '#4F7CB7', '#3C659A', '#2D4F7B']
const WIDTHS = [1.9, 2.4, 3.1, 4.0, 5.2]
const CLASS_LABELS = ['lowest half', '50-75th', '75-90th', '90-97th', 'worst 3%']

const METRICS = [
  { id: 'pax_delay_min', label: 'Passenger delay', unit: 'passenger-min',
    ramp: RAMP_PAX, accent: ORANGE,
    blurb: 'Minutes lost, times the people who lost them.' },
  { id: 'veh_delay_min', label: 'Bus delay', unit: 'bus-min',
    ramp: RAMP_BUS, accent: BLUE,
    blurb: 'Minutes the bus lost. Empty or full, same weight.' },
  { id: 'riders_20d', label: 'Riders carried', unit: 'riders',
    ramp: RAMP_PAX, accent: ORANGE,
    blurb: 'People past an average point, over the 20 days.' },
  { id: 'min_per_bus', label: 'Minutes per bus', unit: 'min',
    ramp: RAMP_BUS, accent: BLUE,
    blurb: 'What a bus loses end to end.' },
  { id: 'sec_per_rider', label: 'Seconds per rider', unit: 'sec',
    ramp: RAMP_PAX, accent: ORANGE,
    blurb: 'What a rider aboard the whole way loses.' },
]

const PERIODS = [
  { id: 'am', label: 'AM peak', hours: '06-09' },
  { id: 'md', label: 'Midday', hours: '10-14' },
  { id: 'pm', label: 'PM peak', hours: '15-18' },
  { id: 'ev', label: 'Evening', hours: '19-23' },
  { id: 'night', label: 'Overnight', hours: '00-05' },
]

const fmt = (n, d = 0) =>
  n === null || n === undefined || Number.isNaN(Number(n))
    ? '—'
    : Number(n).toLocaleString('en-US', { minimumFractionDigits: d,
                                          maximumFractionDigits: d })
const pct = (part, whole) => {
  if (!whole) return '—'
  const v = (part / whole) * 100
  return v >= 10 ? `${v.toFixed(0)}%` : v >= 0.1 ? `${v.toFixed(1)}%` : '<0.1%'
}
const compact = (n) => {
  if (n === null || n === undefined || Number.isNaN(Number(n))) return '—'
  const a = Math.abs(n)
  if (a >= 1e6) return `${(n / 1e6).toFixed(a >= 1e7 ? 0 : 1)}M`
  if (a >= 1e3) return `${(n / 1e3).toFixed(a >= 1e4 ? 0 : 1)}k`
  return `${Math.round(n)}`
}

/* Percentile breaks. Intensity is log-normal, so equal intervals put most of the
 * network in one class. Ties are nudged apart because MapLibre rejects a step whose
 * stops are not strictly ascending. */
function breaks(values) {
  const v = values.filter((x) => x > 0).sort((a, b) => a - b)
  if (!v.length) return [1, 2, 3, 4]
  const at = (p) => v[Math.min(v.length - 1, Math.floor(p * v.length))]
  const b = [at(0.5), at(0.75), at(0.9), at(0.97)]
  for (let i = 1; i < b.length; i++) if (b[i] <= b[i - 1]) b[i] = b[i - 1] + 1e-6
  return b
}

export default function CorridorsApp() {
  const mapRef = useRef(null)
  const boxRef = useRef(null)
  const popRef = useRef(null)

  const [sets, setSets] = useState({ runs: null, corridors: null })
  const [error, setError] = useState(null)
  const [ready, setReady] = useState(false)

  const [view, setView] = useState('corridors')
  const [metricId, setMetricId] = useState('pax_delay_min')
  const [boros, setBoros] = useState(null)
  const [topN, setTopN] = useState(50)
  const [query, setQuery] = useState('')
  const [sel, setSel] = useState(null)
  const [hover, setHover] = useState(null)

  const metric = METRICS.find((m) => m.id === metricId)
  const features = sets[view]

  useEffect(() => {
    let alive = true
    const grab = (k) => fetch(SRC[k].data).then((r) => {
      if (!r.ok) throw new Error(`${SRC[k].data} ${r.status}`)
      return r.json()
    }).then((gj) => {
      // one id field, so nothing downstream cares which layer it came from
      gj.features.forEach((f) => { f.properties.fid = f.properties[SRC[k].idKey] })
      return [k, gj.features]
    })

    Promise.all([grab('corridors'), grab('runs')])
      .then((res) => {
        if (!alive) return
        const s = {}
        res.forEach(([k, f]) => { s[k] = f })
        setSets(s)
        setBoros(new Set([...s.runs, ...s.corridors]
          .map((f) => f.properties.borough)))
      })
      .catch((e) => { if (alive) setError(e.message) })
    return () => { alive = false }
  }, [])

  const allBoros = useMemo(() => {
    const all = [...(sets.runs || []), ...(sets.corridors || [])]
    return [...new Set(all.map((f) => f.properties.borough))].sort()
  }, [sets])

  const rows = useMemo(() => {
    if (!features || !boros) return []
    const q = query.trim().toLowerCase()
    return features
      .map((f) => f.properties)
      .filter((p) => boros.has(p.borough))
      .filter((p) => !q
        || p.name.toLowerCase().includes(q)
        || String(p.routes || '').toLowerCase().includes(q))
      .sort((a, b) => (Number(b[metricId]) || 0) - (Number(a[metricId]) || 0))
      .slice(0, topN)
  }, [features, boros, query, metricId, topN])

  /* Citywide totals come from the run layer, which covers the whole network with
   * nothing filtered out. Summing them here rather than hardcoding means a rebuild of
   * the data cannot leave a stale percentage on screen. */
  const city = useMemo(() => {
    const r = sets.runs
    if (!r) return null
    const sum = (k) => r.reduce((a, f) => a + (Number(f.properties[k]) || 0), 0)
    return { pax: sum('pax_delay_min'), veh: sum('veh_delay_min'),
             miles: sum('miles') }
  }, [sets.runs])

  const brk = useMemo(
    () => breaks(rows.map((r) => Number(r[metricId]) || 0)), [rows, metricId])

  const totals = useMemo(() => {
    const sum = (k) => rows.reduce((a, r) => a + (Number(r[k]) || 0), 0)
    return { n: rows.length, pax: sum('pax_delay_min'), bus: sum('veh_delay_min'),
             riders: sum('riders_20d'), trips: sum('bus_trips_20d'),
             miles: sum('miles') }
  }, [rows])

  // ------------------------------------------------------------------- map
  useEffect(() => {
    if (mapRef.current || !boxRef.current) return
    const map = new maplibregl.Map({
      container: boxRef.current,
      /* CARTO Positron, split into ground and labels so the labels can sit ABOVE
       * the data. Positron is already a near-grey cartography, so unlike raw OSM it
       * needs no saturation or contrast correction to stop it fighting the lines. */
      style: {
        version: 8,
        sources: {
          ground: {
            type: 'raster', tileSize: 256,
            tiles: ['a', 'b', 'c', 'd'].map((h) =>
              `https://${h}.basemaps.cartocdn.com/light_nolabels/{z}/{x}/{y}@2x.png`),
            attribution: CARTO_CREDIT,
          },
          places: {
            type: 'raster', tileSize: 256,
            tiles: ['a', 'b', 'c', 'd'].map((h) =>
              `https://${h}.basemaps.cartocdn.com/light_only_labels/{z}/{x}/{y}@2x.png`),
          },
        },
        layers: [{ id: 'ground', type: 'raster', source: 'ground' }],
      },
      center: [-73.94, 40.70],
      zoom: 10.1,
    })
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right')
    map.addControl(new maplibregl.ScaleControl({ unit: 'imperial' }), 'bottom-right')
    mapRef.current = map
    return () => { map.remove(); mapRef.current = null }
  }, [])

  useEffect(() => {
    const map = mapRef.current
    if (!map || !features) return
    const apply = () => {
      const data = { type: 'FeatureCollection', features }
      if (!map.getSource('lines')) {
        map.addSource('lines', { type: 'geojson', data })
        map.addLayer({ id: 'lines-casing', type: 'line', source: 'lines',
          layout: { 'line-cap': 'round', 'line-join': 'round' },
          paint: { 'line-color': PAPER, 'line-width': 6, 'line-opacity': 0.85 } })
        map.addLayer({ id: 'lines', type: 'line', source: 'lines',
          layout: { 'line-cap': 'round', 'line-join': 'round' },
          paint: { 'line-color': ORANGE, 'line-width': 2 } })
        map.addLayer({ id: 'lines-hit', type: 'line', source: 'lines',
          paint: { 'line-color': '#000', 'line-opacity': 0, 'line-width': 16 } })
        map.addLayer({ id: 'places', type: 'raster', source: 'places',
          paint: { 'raster-opacity': 0.85 } })

        map.on('mousemove', 'lines-hit', (e) => {
          const f = e.features && e.features[0]
          if (!f) return
          map.getCanvas().style.cursor = 'pointer'
          setHover(f.properties.fid)
          const p = f.properties
          if (!popRef.current) {
            popRef.current = new maplibregl.Popup({
              closeButton: false, closeOnClick: false, offset: 12,
              className: 'corridor-tip' })
          }
          popRef.current.setLngLat(e.lngLat).setHTML(
            '<div class="tipname">' + p.rank + '. ' + p.name + '</div>' +
            '<div class="tipsub">' +
            Math.round(Number(p.pax_delay_min) / DAYS).toLocaleString() +
            ' passenger-min lost per day</div>').addTo(map)
        })
        map.on('mouseleave', 'lines-hit', () => {
          map.getCanvas().style.cursor = ''
          setHover(null)
          if (popRef.current) popRef.current.remove()
        })
        map.on('click', 'lines-hit', (e) => {
          const p = e.features && e.features[0] && e.features[0].properties
          if (p) setSel({ ...p })
        })
      } else {
        map.getSource('lines').setData(data)
      }
      setReady(true)
    }
    if (map.isStyleLoaded()) apply()
    else map.once('load', apply)
  }, [features])

  useEffect(() => {
    const map = mapRef.current
    if (!map || !ready || !map.getLayer('lines') || !boros) return

    /* A literal id list is fine for a handful of search hits but slow for 1,886
     * streets, so the normal path filters on the properties themselves. */
    const cutoff = rows.length
      ? Number(rows[rows.length - 1][metricId]) || 0
      : Number.POSITIVE_INFINITY
    const boroFilter = ['in', ['get', 'borough'], ['literal', [...boros]]]
    const filter = query.trim()
      ? ['in', ['get', 'fid'], ['literal', rows.map((r) => r.fid)]]
      : ['all', boroFilter, ['>=', ['coalesce', ['get', metricId], 0], cutoff]]

    const selId = sel ? sel.fid : '__none__'
    const colour = ['case',
      ['==', ['get', 'fid'], selId], INK,
      ['step', ['coalesce', ['get', metricId], 0],
        metric.ramp[0], brk[0], metric.ramp[1], brk[1], metric.ramp[2],
        brk[2], metric.ramp[3], brk[3], metric.ramp[4]]]
    const width = ['case',
      ['==', ['get', 'fid'], selId], 7,
      ['==', ['get', 'fid'], hover === null ? '__none__' : hover], 6,
      ['step', ['coalesce', ['get', metricId], 0],
        WIDTHS[0], brk[0], WIDTHS[1], brk[1], WIDTHS[2],
        brk[2], WIDTHS[3], brk[3], WIDTHS[4]]]

    const ids = ['lines', 'lines-casing', 'lines-hit']
    ids.forEach((id) => map.setFilter(id, filter))
    map.setPaintProperty('lines', 'line-color', colour)
    map.setPaintProperty('lines', 'line-width', width)
    map.setPaintProperty('lines-casing', 'line-width',
      ['+', 2.6, ['case', ['==', ['get', 'fid'], selId], 7, 2.6]])
  }, [rows, metricId, brk, sel, hover, metric, boros, query, ready])

  const focus = (p) => {
    setSel(p)
    const map = mapRef.current
    const f = features && features.find((x) => x.properties.fid === p.fid)
    if (!map || !f) return
    const coords = f.geometry.type === 'MultiLineString'
      ? f.geometry.coordinates.flat() : f.geometry.coordinates
    if (!coords.length) return
    const b = coords.reduce((acc, c) => acc.extend(c),
      new maplibregl.LngLatBounds(coords[0], coords[0]))
    map.fitBounds(b, { padding: 150, maxZoom: 15.5, duration: 700 })
  }

  const toggleBoro = (b) => setBoros((prev) => {
    const next = new Set(prev)
    if (next.has(b)) { if (next.size > 1) next.delete(b) } else next.add(b)
    return next
  })

  const switchView = (v) => {
    setView(v)
    setSel(null)
    setTopN(v === 'corridors' ? 50 : 200)
  }

  if (error) {
    return (
      <div style={S.err}>
        <h1 style={{ margin: 0, fontSize: 20 }}>Could not load the data</h1>
        <p style={{ color: MUTED }}>{error}</p>
        <p style={{ color: MUTED, fontSize: 13 }}>
          Expecting corridors.geojson and runs.geojson under <code>public/data/</code>.
        </p>
      </div>
    )
  }

  const nAll = features ? features.length : 0
  const noun = view === 'corridors' ? 'corridors' : 'runs'
  const scope = !nAll ? 'loading'
    : totals.n >= nAll ? `all ${fmt(nAll)} ${noun}`
    : `top ${fmt(totals.n)} of ${fmt(nAll)} ${noun}`

  return (
    <div style={S.page}>
      <header style={S.header}>
        <div style={{ flex: '0 1 auto', minWidth: 290 }}>
          <h1 style={S.h1}>Where bus delay lands in New York</h1>
          <p style={S.sub}>
            Twenty days of MTA real-time data, matched to the street and weighted by
            how many people were on the bus.
          </p>
        </div>

        <Calendar />

        {/* every figure for what is on screen, and it tracks both layers alike */}
        <div style={{ flex: '0 0 auto' }}>
          <div style={S.scope}>{scope}</div>
          <div style={S.hstats}>
            <Stat v={compact(totals.riders)} l="riders carried"
                  per={`${compact(totals.riders / DAYS)} per day`} accent={ORANGE} />
            <Stat v={compact(totals.pax)} l="passenger-min lost"
                  per={`${compact(totals.pax / DAYS)} per day`}
                  pct={city && `${pct(totals.pax, city.pax)} of citywide`} />
            <Stat v={compact(totals.bus)} l="bus-min lost"
                  per={`${compact(totals.bus / DAYS)} per day`}
                  pct={city && `${pct(totals.bus, city.veh)} of citywide`} />
            <Stat v={compact(totals.trips)} l="bus trips"
                  per={`${compact(totals.trips / DAYS)} per day`} />
            <Stat v={fmt(totals.n)} l={noun}
                  per={`${totals.miles.toFixed(1)} centreline mi`}
                  pct={city && `${pct(totals.miles, city.miles)} of the network`} />
          </div>
        </div>
      </header>

      <div style={S.body}>
        <aside style={S.panel}>
          <section style={S.block}>
            <div style={S.viewGrid}>
              <ViewBtn on={view === 'corridors'} onClick={() => switchView('corridors')}
                       n={sets.corridors && sets.corridors.length} lab="corridors"
                       sub="the bad stretches" />
              <ViewBtn on={view === 'runs'} onClick={() => switchView('runs')}
                       n={sets.runs && sets.runs.length} lab="runs"
                       sub="every bus street" />
            </div>
            <p style={S.blurb}>
              {view === 'corridors'
                ? 'Bad blocks, chained where they touch. 300 corridors over 194 miles hold 47% of the delay on 13% of the streets. The cut is a percentile within each borough, so Staten Island is judged against Staten Island.'
                : 'Every bus street in the city, cut where the street breaks. 3,628 stretches, 1,491 miles, nothing filtered out. Broadway in Manhattan is 18 runs here, not one row with an average on it.'}
            </p>
          </section>

          <section style={{ ...S.block, borderTop: `1px solid ${LINE}` }}>
            <div style={S.mGrid}>
              {METRICS.map((m) => (
                <button key={m.id} onClick={() => setMetricId(m.id)} style={{
                  ...S.mBtn,
                  borderColor: metricId === m.id ? m.accent : LINE,
                  background: metricId === m.id ? `${m.accent}12` : PAPER,
                  color: metricId === m.id ? m.accent : INK,
                  fontWeight: metricId === m.id ? 700 : 500,
                }}>{m.label}</button>
              ))}
            </div>
            <p style={S.aside}>{metric.blurb}</p>

            <div style={{ ...S.label, marginTop: 18 }}>Borough</div>
            <div style={S.chips}>
              {allBoros.map((b) => (
                <button key={b} onClick={() => toggleBoro(b)} style={{
                  ...S.chip,
                  borderColor: boros && boros.has(b) ? INK : LINE,
                  background: boros && boros.has(b) ? INK : PAPER,
                  color: boros && boros.has(b) ? PAPER : MUTED,
                }}>{b}</button>
              ))}
            </div>

            <div style={{ ...S.label, marginTop: 18 }}>
              Showing <span style={{ color: INK, fontWeight: 700 }}>
                {Math.min(topN, nAll) || 0}</span> of {fmt(nAll)}
            </div>
            <input type="range" min="10" max={nAll || 100}
                   value={Math.min(topN, nAll || 100)}
                   onChange={(e) => setTopN(Number(e.target.value))} style={S.range} />
            <div style={S.ticks}>
              {(view === 'corridors' ? [10, 50, 100, 200, nAll]
                                     : [25, 100, 400, 1000, nAll])
                .filter((n) => n && n <= nAll)
                .map((n) => (
                  <button key={n} onClick={() => setTopN(n)} style={{
                    ...S.tick,
                    color: topN === n ? metric.accent : MUTED,
                    fontWeight: topN === n ? 700 : 400,
                  }}>{fmt(n)}</button>
                ))}
            </div>

            <input value={query} onChange={(e) => setQuery(e.target.value)}
                   placeholder="B41, Utica, Flatbush"
                   style={S.search} />
          </section>

          <section style={{ ...S.block, borderTop: `1px solid ${LINE}` }}>
            <div style={S.label}>{metric.label}, {metric.unit}</div>
            {metric.ramp.map((c, i) => (
              <div key={i} style={S.lRow}>
                <span style={{ ...S.lSw, background: c, height: WIDTHS[i] }} />
                <span style={S.lLab}>{CLASS_LABELS[i]}</span>
                <span style={S.lVal}>
                  {i === 0 ? '< ' + compact(brk[0])
                    : i === 4 ? '> ' + compact(brk[3])
                    : compact(brk[i - 1]) + ' – ' + compact(brk[i])}
                </span>
              </div>
            ))}
            <p style={S.aside}>
              Percentile classes, taken from whatever is on screen.
            </p>
          </section>

          <section style={{ ...S.block, borderTop: `1px solid ${LINE}`,
                            paddingBottom: 40 }}>
            <div style={S.thead}>
              <span style={{ width: 26 }} />
              <span style={{ flex: 1 }}>{view === 'corridors' ? 'Corridor' : 'Run'}</span>
              <span>{metric.unit}</span>
            </div>
            {rows.map((p, i) => {
              const on = sel && sel.fid === p.fid
              return (
                <button key={p.fid} onClick={() => focus(p)}
                        onMouseEnter={() => setHover(p.fid)}
                        onMouseLeave={() => setHover(null)}
                        style={{
                          ...S.row,
                          background: on ? `${metric.accent}12`
                            : hover === p.fid ? '#f4f3f1' : 'transparent',
                          borderLeftColor: on ? metric.accent : 'transparent',
                        }}>
                  <span style={{ ...S.rRank, color: i < 10 ? metric.accent : MUTED }}>
                    {i + 1}
                  </span>
                  <span style={S.rName}>
                    <span style={S.rTitle}>{p.name}</span>
                    <span style={S.rMeta}>
                      {p.miles} mi · {p.n_routes} routes ·{' '}
                      {compact(Number(p.riders_20d) / DAYS)} riders/day
                    </span>
                  </span>
                  <span style={S.rVal}>{compact(p[metricId])}</span>
                </button>
              )
            })}
            {!rows.length && <p style={S.aside}>Nothing matches that filter.</p>}
            <div style={S.mark}>
              Transit Ranked<span style={{ color: FAINT }}>
                {'  \u00b7  '}MTA real-time, 26 June to 15 July 2026</span>
            </div>
          </section>
        </aside>

        <main style={S.mapWrap}>
          <div ref={boxRef} style={S.map} />
          {!features && <div style={S.loading}>Loading the bus network</div>}
          {sel && <Detail p={sel} metric={metric} view={view} total={nAll}
                          onClose={() => setSel(null)} />}
        </main>
      </div>
    </div>
  )
}

const ViewBtn = ({ on, onClick, n, lab, sub }) => (
  <button onClick={onClick} style={{
    ...S.viewBtn, borderColor: on ? ORANGE : LINE,
    background: on ? '#F2672410' : PAPER,
  }}>
    <b style={{ color: on ? ORANGE : INK, fontSize: 12.5 }}>
      {n ? fmt(n) : '—'} {lab}
    </b>
    <span style={S.viewSub}>{sub}</span>
  </button>
)
function Calendar() {
  return (
    <div style={S.calWrap}>
      <div style={S.calHead}>
        Study window &middot; 26 Jun to 15 Jul 2026 &middot;
        14 weekdays, 6 weekend days
      </div>
      <div style={S.calRow}>
        {CALENDAR.map(([mon, day, dow], i) => {
          const weekend = dow === 'Sat' || dow === 'Sun'
          const holiday = `${mon} ${day}` === HOLIDAY
          const newMonth = i > 0 && CALENDAR[i - 1][0] !== mon
          return (
            <div key={`${mon}${day}`}
                 title={`${dow} ${day} ${mon} 2026${holiday ? ' — Independence Day' : ''}`}
                 style={{
                   ...S.calCell,
                   marginLeft: newMonth ? 6 : 0,
                   background: holiday ? '#F2672418' : weekend ? '#f1efec' : PAPER,
                   borderColor: holiday ? ORANGE : LINE,
                   color: holiday ? ORANGE : weekend ? FAINT : INK,
                   fontWeight: holiday ? 700 : 500,
                 }}>
              <span style={S.calDow}>{dow[0]}</span>
              {day}
            </div>
          )
        })}
      </div>
    </div>
  )
}

const Stat = ({ v, l, per, pct: share, accent }) => (
  <div style={{ minWidth: 88 }}>
    <div style={{ ...S.statV, color: accent || INK }}>{v}</div>
    <div style={S.statL}>{l}</div>
    {per && <div style={S.statPer}>{per}</div>}
    {share && <div style={{ ...S.statPer, color: accent || INK, fontWeight: 600 }}>
      {share}</div>}
  </div>
)

/* ------------------------------------------------------------------ detail */
function Detail({ p, metric, view, total, onClose }) {
  /* MapLibre serialises nested JSON in feature properties to strings on click, while
   * a row clicked in the list is the real object. Accept both. */
  const asArray = (v) => {
    if (Array.isArray(v)) return v
    if (typeof v === 'string') { try { return JSON.parse(v) } catch (e) { return [] } }
    return []
  }
  const routes = asArray(p.routes)
  const hourly = asArray(p.hourly_pax)
  const hMax = Math.max.apply(null, [1].concat(hourly))
  const pMax = Math.max.apply(null,
    [1].concat(PERIODS.map((q) => Number(p['pax_' + q.id]) || 0)))

  return (
    <div style={S.detail}>
      <div style={S.dHead}>
        <div>
          <div style={{ ...S.eyebrow, color: metric.accent }}>
            Rank {p.rank} of {fmt(total)} by passenger delay
          </div>
          <h2 style={S.dH}>{p.name}</h2>
          <div style={S.dSub}>
            {p.borough} · {p.miles} miles · {p.n_blocks} roadway blocks
            {view === 'corridors' ? ' chained' : ''}
          </div>
        </div>
        <button onClick={onClose} style={S.close} aria-label="Close">&times;</button>
      </div>

      <div style={S.dGrid}>
        <Cell big v={fmt(p.riders_per_day)} l="riders per day"
              sub={`${fmt(p.riders_20d)} over 20 days`} accent={ORANGE} />
        <Cell big v={fmt(Number(p.pax_delay_min) / DAYS)} l="passenger-min lost per day"
              sub={`${fmt(p.pax_delay_min)} over 20 days`} />
        <Cell v={fmt(Number(p.veh_delay_min) / DAYS)} l="bus-min lost per day"
              sub={`${fmt(p.veh_delay_min)} over 20 days`} />
        <Cell v={fmt(p.buses_per_day)} l="buses per day"
              sub={`${fmt(p.bus_trips_20d)} over 20 days`} />
        <Cell v={fmt(p.min_per_bus, 2)} l="minutes lost end to end"
              sub="for the bus, and a rider aboard" />
        <Cell v={fmt(p.riders_per_bus, 1)} l="riders per bus" sub="average load" />
        <Cell v={fmt(p.sec_per_rider)} l="seconds lost per rider" />
        <Cell v={fmt(p.riders_per_delayed_bus_min, 1)} l="riders per bus-minute lost" />
        <Cell v={fmt(p.share_of_city_delay_pct, 2) + '%'}
              l={view === 'corridors' ? 'of all corridor delay' : 'of citywide delay'} />
        <Cell v={fmt(p.pax_delay_per_mile)} l="passenger-min per mile"
              sub="over 20 days" />
      </div>

      <div style={S.dBlock}>
        <div style={S.label}>When it happens, weekday</div>
        {PERIODS.map((q) => {
          const share = p['share_' + q.id + '_pct']
          return (
            <div key={q.id} style={S.pRow}>
              <span style={S.pName}>
                {q.label}{' '}
                <span style={{ color: MUTED, fontWeight: 400 }}>{q.hours}</span>
              </span>
              <span style={S.pBarWrap}>
                <span style={{
                  ...S.pBar,
                  width: ((Number(p['pax_' + q.id]) || 0) / pMax) * 100 + '%',
                  background: p.peak_period === q.id ? metric.accent : '#cfcdc9',
                }} />
              </span>
              <span style={S.pVal}>
                {share === null || share === undefined ? '—' : share + '%'}
              </span>
            </div>
          )
        })}
        {hourly.length === 24 && (
          <div>
            <div style={S.spark}>
              {hourly.map((v, h) => (
                <span key={h} title={h + ':00 — ' + fmt(v) + ' passenger-min'}
                      style={{
                        ...S.sparkBar,
                        height: Math.max(2, (v / hMax) * 44) + 'px',
                        background: (h >= 6 && h <= 9) || (h >= 15 && h <= 18)
                          ? metric.accent : '#cfcdc9',
                      }} />
              ))}
            </div>
            <div style={S.axis}>
              <span>00</span><span>06</span><span>12</span><span>18</span><span>23</span>
            </div>
          </div>
        )}
      </div>

      <div style={S.dBlock}>
        <div style={S.label}>
          {routes.length} routes use this {view === 'corridors' ? 'corridor' : 'run'}
        </div>
        <div style={S.rtWrap}>
          {routes.map((r) => <span key={r} style={S.rt}>{r}</span>)}
        </div>
      </div>

      <p style={S.foot}>
        Both directions together, since you pave a street and not a side of it. Time
        a bus makes back does not cancel time it lost. Riders are counted past an
        average point, not added up along the length. Daily figures are the 20-day
        total over 20, weekends included.
      </p>
    </div>
  )
}

const Cell = ({ v, l, sub, accent, big }) => (
  <div>
    <div style={{ ...S.cellV, color: accent || INK, fontSize: big ? 21 : 17 }}>{v}</div>
    <div style={S.cellL}>{l}</div>
    {sub && <div style={S.cellSub}>{sub}</div>}
  </div>
)

/* ------------------------------------------------------------------ styles */
const S = {
  page: { fontFamily: UI, color: INK,
          background: PAPER, height: '100vh', display: 'flex',
          flexDirection: 'column', overflow: 'hidden' },
  header: { padding: '13px 22px 11px', borderBottom: `1px solid ${LINE}`,
            display: 'flex', gap: 22, alignItems: 'flex-start',
            justifyContent: 'space-between', flexWrap: 'wrap' },
  eyebrow: { fontSize: 11, fontWeight: 600, color: ORANGE, marginBottom: 5 },
  h1: { fontFamily: FIG, margin: 0, fontSize: 25, fontWeight: 600,
        letterSpacing: '-.005em' },
  sub: { margin: '6px 0 0', color: MUTED, fontSize: 12.5, maxWidth: 470,
         lineHeight: 1.45 },

  calWrap: { paddingTop: 3, flex: '1 1 auto', display: 'flex',
             flexDirection: 'column', alignItems: 'center' },
  calHead: { fontSize: 11, fontWeight: 600, color: MUTED, marginBottom: 7 },
  calRow: { display: 'flex', gap: 2 },
  calCell: { width: 26, height: 34, border: `1px solid ${LINE}`, borderRadius: 4,
             fontSize: 13, display: 'flex', flexDirection: 'column',
             alignItems: 'center', justifyContent: 'center', lineHeight: 1.05,
             fontVariantNumeric: 'tabular-nums' },
  calDow: { fontSize: 8.5, color: FAINT, letterSpacing: '.05em', marginBottom: 1 },

  scope: { fontSize: 11, fontWeight: 600, color: MUTED, marginBottom: 7,
           textAlign: 'right' },
  hstats: { display: 'flex', gap: 22 },
  statV: { fontFamily: FIG, fontSize: 22, fontWeight: 700, lineHeight: 1.05,
           fontVariantNumeric: 'tabular-nums' },
  statL: { fontSize: 10.5, color: MUTED, marginTop: 3 },
  statPer: { fontSize: 10, color: FAINT, marginTop: 1,
             fontVariantNumeric: 'tabular-nums' },

  body: { flex: 1, display: 'flex', minHeight: 0 },
  panel: { width: 380, minWidth: 330, borderRight: `1px solid ${LINE}`,
           overflowY: 'auto', background: '#fcfbfa' },
  block: { padding: '15px 19px' },
  label: { fontSize: 11, fontWeight: 600, color: MUTED, marginBottom: 8 },
  blurb: { fontSize: 11.5, color: MUTED, lineHeight: 1.45, margin: '8px 0 0' },
  aside: { fontSize: 11.5, color: MUTED, lineHeight: 1.45, margin: '9px 0 0',
           paddingLeft: 9, borderLeft: `2px solid ${LINE}` },
  thead: { display: 'flex', alignItems: 'baseline', gap: 9, padding: '0 7px 6px',
           fontSize: 10.5, color: FAINT, borderBottom: `1px solid ${LINE}`,
           marginBottom: 4 },
  mark: { marginTop: 22, paddingTop: 12, borderTop: `1px solid ${LINE}`,
          fontFamily: FIG, fontSize: 12, color: MUTED, letterSpacing: '.01em' },

  viewGrid: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 },
  viewBtn: { padding: '9px 10px', border: `1.5px solid ${LINE}`, borderRadius: 7,
             cursor: 'pointer', textAlign: 'left', fontFamily: 'inherit' },
  viewSub: { display: 'block', fontSize: 10, color: MUTED, marginTop: 2,
             lineHeight: 1.25 },

  mGrid: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 5 },
  mBtn: { padding: '8px 9px', fontSize: 11.5, borderRadius: 6,
          border: `1.5px solid ${LINE}`, cursor: 'pointer', fontFamily: 'inherit',
          textAlign: 'left' },
  chips: { display: 'flex', flexWrap: 'wrap', gap: 4 },
  chip: { padding: '4px 9px', fontSize: 11, borderRadius: 999,
          border: `1px solid ${LINE}`, cursor: 'pointer', fontFamily: 'inherit' },
  range: { width: '100%', accentColor: ORANGE },
  ticks: { display: 'flex', gap: 6, marginTop: 3 },
  tick: { fontSize: 10.5, background: 'none', border: 'none', cursor: 'pointer',
          padding: '2px 3px', fontFamily: 'inherit' },
  search: { width: '100%', marginTop: 14, padding: '8px 10px', fontSize: 12.5,
            border: `1px solid ${LINE}`, borderRadius: 6, fontFamily: 'inherit',
            boxSizing: 'border-box' },

  lRow: { display: 'flex', alignItems: 'center', gap: 9, padding: '3px 0' },
  lSw: { width: 28, borderRadius: 2, flexShrink: 0 },
  lLab: { fontSize: 11.5, flex: 1 },
  lVal: { fontSize: 10.5, color: MUTED, fontVariantNumeric: 'tabular-nums' },

  row: { display: 'flex', alignItems: 'center', gap: 9, width: '100%',
         padding: '6px 7px', border: 'none', borderLeft: '3px solid transparent',
         cursor: 'pointer', textAlign: 'left', fontFamily: 'inherit', borderRadius: 4 },
  rRank: { fontSize: 11.5, fontWeight: 700, width: 26, flexShrink: 0,
           fontVariantNumeric: 'tabular-nums' },
  rName: { flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 1 },
  rTitle: { fontSize: 12, fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden',
            textOverflow: 'ellipsis' },
  rMeta: { fontSize: 10, color: MUTED },
  rVal: { fontFamily: FIG, fontSize: 12, fontWeight: 600, fontVariantNumeric: 'tabular-nums' },

  mapWrap: { flex: 1, position: 'relative', minWidth: 0 },
  map: { position: 'absolute', inset: 0 },
  loading: { position: 'absolute', top: 18, left: 18, background: PAPER,
             padding: '8px 13px', borderRadius: 7, fontSize: 13, color: MUTED,
             border: `1px solid ${LINE}` },

  detail: { position: 'absolute', top: 14, right: 14, bottom: 14, width: 372,
            background: PAPER, borderRadius: 11, border: `1px solid ${LINE}`,
            boxShadow: '0 10px 34px rgba(0,0,0,.14)', overflowY: 'auto',
            padding: '15px 18px 22px' },
  dHead: { display: 'flex', justifyContent: 'space-between', gap: 10 },
  dH: { margin: '2px 0 0', fontSize: 18, fontWeight: 700, lineHeight: 1.2 },
  dSub: { fontSize: 11.5, color: MUTED, marginTop: 4 },
  close: { background: 'none', border: 'none', fontSize: 25, lineHeight: 1,
           color: MUTED, cursor: 'pointer', padding: 0, height: 26 },
  dGrid: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px 11px',
           margin: '16px 0 4px' },
  cellV: { fontFamily: FIG, fontWeight: 700, lineHeight: 1.12, fontVariantNumeric: 'tabular-nums' },
  cellL: { fontSize: 10.5, color: MUTED, marginTop: 2, lineHeight: 1.3 },
  cellSub: { fontSize: 9.5, color: FAINT, marginTop: 1 },
  dBlock: { marginTop: 18, paddingTop: 14, borderTop: `1px solid ${LINE}` },

  pRow: { display: 'flex', alignItems: 'center', gap: 9, padding: '3px 0' },
  pName: { fontSize: 11, width: 104, fontWeight: 600 },
  pBarWrap: { flex: 1, height: 7, background: '#efedea', borderRadius: 4 },
  pBar: { display: 'block', height: 7, borderRadius: 4 },
  pVal: { fontSize: 10.5, color: MUTED, width: 36, textAlign: 'right',
          fontVariantNumeric: 'tabular-nums' },
  spark: { display: 'flex', alignItems: 'flex-end', gap: 2, height: 46,
           marginTop: 14 },
  sparkBar: { flex: 1, borderRadius: '1px 1px 0 0' },
  axis: { display: 'flex', justifyContent: 'space-between', fontSize: 9.5,
          color: MUTED, marginTop: 4 },

  rtWrap: { display: 'flex', flexWrap: 'wrap', gap: 4 },
  rt: { fontSize: 10.5, padding: '3px 7px', background: '#f2f1ef', borderRadius: 4,
        fontVariantNumeric: 'tabular-nums' },
  foot: { fontSize: 10, color: MUTED, lineHeight: 1.45, marginTop: 18, paddingTop: 12,
          borderTop: `1px solid ${LINE}` },

  err: { padding: 40, fontFamily: UI },
}
