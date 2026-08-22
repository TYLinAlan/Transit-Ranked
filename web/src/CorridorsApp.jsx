import { useEffect, useMemo, useRef, useState } from 'react'
import maplibregl from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'

/*  Where Delay Lands - every street and every corridor in the New York bus network,
 *  ranked by the delay riders absorb rather than the delay buses absorb.
 *
 *  TWO LAYERS, and the difference between them matters:
 *
 *    ROADS      1,886 streets, the whole bus network, 1,491 centreline miles.
 *               42.9M passenger-minutes: every minute generated anywhere.
 *               This is where delay actually falls.
 *    CORRIDORS  303 chained runs of contiguous bad street, 191 miles.
 *               19.9M passenger-minutes, 46% of the total on 13% of the network.
 *               This is where you would build something.
 *
 *  Colour always encodes the ACTIVE METRIC, never rank, so switching metric repaints
 *  the map into a genuinely different picture. That switch is the argument, so it sits
 *  near the top of the panel.
 *
 *  Data is written by Equity_Analysis/29_export_web.py and 31_export_roads.py.
 */

const SRC = {
  roads: { data: '/data/roads.geojson', meta: '/data/roads_meta.json', idKey: 'road_id' },
  corridors: { data: '/data/corridors.geojson', meta: '/data/corridors_meta.json',
               idKey: 'corridor_id' },
}

const INK = '#1c1c1e'
const MUTED = '#6d6e71'
const LINE = '#e3e1dd'
const ORANGE = '#F26724'
const BLUE = '#476AA3'
const PAPER = '#ffffff'

// single-hue ramps: magnitude by lightness, never by hue rotation
const RAMP_PAX = ['#FBD9C4', '#F5A970', '#EE8440', '#D4570F', '#8A3208']
const RAMP_BUS = ['#D3DEEB', '#A9BFD8', '#7B9AC2', '#4F76A6', '#2C4B77']
const CLASS_LABELS = ['lowest half', '50-75th', '75-90th', '90-97th', 'worst 3%']

const METRICS = [
  { id: 'pax_delay_min', label: 'Passenger delay', unit: 'passenger-min',
    ramp: RAMP_PAX, accent: ORANGE,
    blurb: 'Bus delay multiplied by how many people were on board.' },
  { id: 'veh_delay_min', label: 'Bus delay', unit: 'bus-min',
    ramp: RAMP_BUS, accent: BLUE,
    blurb: 'The conventional measure. Every bus counts the same, full or empty.' },
  { id: 'riders_20d', label: 'Riders carried', unit: 'riders',
    ramp: RAMP_PAX, accent: ORANGE,
    blurb: 'Passengers past an average point over 20 days.' },
  { id: 'min_per_bus', label: 'Minutes per bus', unit: 'min',
    ramp: RAMP_BUS, accent: BLUE,
    blurb: 'What an average bus loses over the whole length.' },
  { id: 'sec_per_rider', label: 'Seconds per rider', unit: 'sec',
    ramp: RAMP_PAX, accent: ORANGE,
    blurb: 'What a rider aboard for the whole length loses.' },
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
const compact = (n) => {
  if (n === null || n === undefined) return '—'
  const a = Math.abs(n)
  if (a >= 1e6) return `${(n / 1e6).toFixed(a >= 1e7 ? 0 : 1)}M`
  if (a >= 1e3) return `${(n / 1e3).toFixed(a >= 1e4 ? 0 : 1)}k`
  return `${Math.round(n)}`
}

/* percentile breaks: intensity is log-normal, so equal intervals would drop
 * four-fifths of the network into a single class */
function breaks(values) {
  const v = values.filter((x) => x > 0).sort((a, b) => a - b)
  if (!v.length) return [1, 2, 3, 4]
  const at = (p) => v[Math.min(v.length - 1, Math.floor(p * v.length))]
  const b = [at(0.5), at(0.75), at(0.9), at(0.97)]
  // rounded values tie often, and MapLibre throws on a step stop that is not
  // strictly ascending, so nudge any tie up rather than let the map go blank
  for (let i = 1; i < b.length; i++) if (b[i] <= b[i - 1]) b[i] = b[i - 1] + 1e-6
  return b
}

export default function CorridorsApp() {
  const mapRef = useRef(null)
  const boxRef = useRef(null)
  const popRef = useRef(null)

  const [sets, setSets] = useState({ roads: null, corridors: null })
  const [metas, setMetas] = useState({ roads: null, corridors: null })
  const [error, setError] = useState(null)

  const [view, setView] = useState('roads')
  const [metricId, setMetricId] = useState('pax_delay_min')
  const [boros, setBoros] = useState(null)
  const [topN, setTopN] = useState(400)
  const [query, setQuery] = useState('')
  const [sel, setSel] = useState(null)
  const [ready, setReady] = useState(false)
  const [hover, setHover] = useState(null)

  const metric = METRICS.find((m) => m.id === metricId)
  const features = sets[view]
  const meta = metas[view]

  useEffect(() => {
    let alive = true
    const grab = (k) => Promise.all([
      fetch(SRC[k].data).then((r) => {
        if (!r.ok) throw new Error(`${SRC[k].data} ${r.status}`)
        return r.json()
      }),
      fetch(SRC[k].meta).then((r) => (r.ok ? r.json() : null)),
    ]).then(([gj, m]) => {
      // one id field, so nothing downstream has to care which layer it came from
      gj.features.forEach((f) => { f.properties.fid = f.properties[SRC[k].idKey] })
      return [k, gj.features, m]
    })

    Promise.all([grab('roads'), grab('corridors')])
      .then((res) => {
        if (!alive) return
        const s = {}
        const mm = {}
        res.forEach(([k, f, m]) => { s[k] = f; mm[k] = m })
        setSets(s)
        setMetas(mm)
        setBoros(new Set([...s.roads, ...s.corridors]
          .map((f) => f.properties.borough)))
      })
      .catch((e) => { if (alive) setError(e.message) })
    return () => { alive = false }
  }, [])

  const allBoros = useMemo(() => {
    const all = [...(sets.roads || []), ...(sets.corridors || [])]
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
      style: {
        version: 8,
        sources: {
          osm: {
            type: 'raster',
            tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
            tileSize: 256,
            attribution: '&copy; OpenStreetMap contributors',
          },
        },
        layers: [{
          id: 'osm', type: 'raster', source: 'osm',
          paint: { 'raster-saturation': -0.88, 'raster-contrast': -0.12,
                   'raster-brightness-min': 0.18 },
        }],
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
          paint: { 'line-color': PAPER, 'line-width': 5, 'line-opacity': 0.7 } })
        map.addLayer({ id: 'lines', type: 'line', source: 'lines',
          layout: { 'line-cap': 'round', 'line-join': 'round' },
          paint: { 'line-color': ORANGE, 'line-width': 2 } })
        map.addLayer({ id: 'lines-hit', type: 'line', source: 'lines',
          paint: { 'line-color': '#000', 'line-opacity': 0, 'line-width': 16 } })

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
            '<div class="tipname">#' + p.rank + ' ' + p.name + '</div>' +
            '<div class="tipsub">' + Number(p.pax_delay_min).toLocaleString() +
            ' passenger-min &middot; ' + Number(p.riders_20d).toLocaleString() +
            ' riders</div>').addTo(map)
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
     * streets, so the normal path filters on the properties themselves and only
     * falls back to ids when a search has already narrowed things down. */
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
      ['==', ['get', 'fid'], selId], 6.5,
      ['==', ['get', 'fid'], hover === null ? '__none__' : hover], 5.5,
      ['step', ['coalesce', ['get', metricId], 0],
        1.4, brk[0], 1.9, brk[1], 2.6, brk[2], 3.6, brk[3], 4.8]]

    const ids = ['lines', 'lines-casing', 'lines-hit']
    ids.forEach((id) => map.setFilter(id, filter))
    map.setPaintProperty('lines', 'line-color', colour)
    map.setPaintProperty('lines', 'line-width', width)
    map.setPaintProperty('lines-casing', 'line-width',
      ['+', 2.5, ['case', ['==', ['get', 'fid'], selId], 6.5, 2]])
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
    setTopN(v === 'roads' ? 400 : 303)
  }

  if (error) {
    return (
      <div style={S.err}>
        <h1 style={{ margin: 0, fontSize: 20 }}>Could not load the data</h1>
        <p style={{ color: MUTED }}>{error}</p>
        <p style={{ color: MUTED, fontSize: 13 }}>
          Expecting roads.geojson and corridors.geojson under <code>public/data/</code>.
        </p>
      </div>
    )
  }

  const nAll = features ? features.length : 0
  const headRiders = view === 'roads'
    ? (meta && meta.riders_20d) : (meta && meta.totals && meta.totals.riders_20d)
  const headPax = view === 'roads'
    ? (meta && meta.passenger_delay_min)
    : (meta && meta.totals && meta.totals.passenger_delay_min)
  const headBus = view === 'roads'
    ? (meta && meta.bus_delay_min)
    : (meta && meta.totals && meta.totals.bus_delay_min)

  return (
    <div style={S.page}>
      <header style={S.header}>
        <div>
          <div style={S.eyebrow}>TRANSIT RANKED</div>
          <h1 style={S.h1}>Where bus delay lands in New York</h1>
          <p style={S.sub}>
            Every street the buses run on, ranked by the delay its riders absorb rather
            than the delay its buses absorb. Twenty days of GTFS-Realtime, weighted by
            how many people were actually on board.
          </p>
        </div>
        {meta && (
          <div style={S.hstats}>
            <Stat v={compact(headRiders)} l="riders carried" accent={ORANGE} />
            <Stat v={compact(headPax)} l="passenger-minutes lost" />
            <Stat v={compact(headBus)} l="bus-minutes lost" />
            <Stat v={fmt(nAll)} l={view === 'roads' ? 'streets' : 'corridors'} />
          </div>
        )}
      </header>

      <div style={S.body}>
        <aside style={S.panel}>
          <section style={S.block}>
            <div style={S.label}>WHAT TO SHOW</div>
            <div style={S.viewGrid}>
              <ViewBtn on={view === 'roads'} onClick={() => switchView('roads')}
                       n={sets.roads && sets.roads.length} lab="roads"
                       sub="every street a bus runs on" />
              <ViewBtn on={view === 'corridors'} onClick={() => switchView('corridors')}
                       n={sets.corridors && sets.corridors.length} lab="corridors"
                       sub="contiguous runs worth funding" />
            </div>
            <p style={S.blurb}>
              {view === 'roads'
                ? 'All 1,886 streets carrying bus service, over 1,491 centreline miles. Between them they hold every one of the 42.9M passenger-minutes generated citywide.'
                : 'The 303 chained corridors, on 191 miles. They hold 19.9M passenger-minutes, 46% of the citywide total, on 13% of the network.'}
            </p>
          </section>

          <section style={{ ...S.block, borderTop: `1px solid ${LINE}` }}>
            <div style={S.label}>COLOUR AND RANK BY</div>
            <div style={S.mGrid}>
              {METRICS.map((m) => (
                <button key={m.id} onClick={() => setMetricId(m.id)} style={{
                  ...S.mBtn,
                  borderColor: metricId === m.id ? m.accent : LINE,
                  background: metricId === m.id ? `${m.accent}14` : PAPER,
                  color: metricId === m.id ? m.accent : INK,
                  fontWeight: metricId === m.id ? 700 : 500,
                }}>{m.label}</button>
              ))}
            </div>
            <p style={S.blurb}>{metric.blurb}</p>

            <div style={{ ...S.label, marginTop: 16 }}>BOROUGH</div>
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

            <div style={{ ...S.label, marginTop: 16 }}>
              SHOW TOP <span style={{ color: INK }}>{Math.min(topN, nAll) || 0}</span>
              {' '}OF {fmt(nAll)}
            </div>
            <input type="range" min="10" max={nAll || 100}
                   value={Math.min(topN, nAll || 100)}
                   onChange={(e) => setTopN(Number(e.target.value))} style={S.range} />
            <div style={S.ticks}>
              {(view === 'roads' ? [25, 100, 400, 1000, nAll] : [10, 50, 100, 200, nAll])
                .filter((n) => n && n <= nAll)
                .map((n) => (
                  <button key={n} onClick={() => setTopN(n)} style={S.tick}>{fmt(n)}</button>
                ))}
            </div>

            <input value={query} onChange={(e) => setQuery(e.target.value)}
                   placeholder="Search a street or route (B41, Utica...)"
                   style={S.search} />
          </section>

          <section style={{ ...S.block, borderTop: `1px solid ${LINE}` }}>
            <div style={S.label}>WHAT IS ON SCREEN</div>
            <div style={S.sumGrid}>
              <Sum v={fmt(totals.n)} l={view === 'roads' ? 'streets' : 'corridors'} />
              <Sum v={compact(totals.riders)} l="riders" accent={ORANGE} />
              <Sum v={compact(totals.pax)} l="passenger-min" />
              <Sum v={compact(totals.bus)} l="bus-min" />
              <Sum v={compact(totals.trips)} l="bus trips" />
              <Sum v={totals.miles.toFixed(1)} l="miles" />
            </div>
          </section>

          <section style={{ ...S.block, borderTop: `1px solid ${LINE}` }}>
            <div style={S.label}>{metric.label.toUpperCase()} ({metric.unit})</div>
            {metric.ramp.map((c, i) => (
              <div key={i} style={S.lRow}>
                <span style={{ ...S.lSw, background: c, height: 3 + i * 1.2 }} />
                <span style={S.lLab}>{CLASS_LABELS[i]}</span>
                <span style={S.lVal}>
                  {i === 0 ? '< ' + compact(brk[0])
                    : i === 4 ? '> ' + compact(brk[3])
                    : compact(brk[i - 1]) + ' – ' + compact(brk[i])}
                </span>
              </div>
            ))}
            <p style={S.blurb}>
              Classes are percentiles of what is on screen. Intensity is log-normal, so
              equal intervals would put four-fifths of the network into one band.
            </p>
          </section>

          <section style={{ ...S.block, borderTop: `1px solid ${LINE}`,
                            paddingBottom: 40 }}>
            <div style={S.label}>RANKED LIST</div>
            {rows.map((p, i) => {
              const on = sel && sel.fid === p.fid
              return (
                <button key={p.fid} onClick={() => focus(p)}
                        onMouseEnter={() => setHover(p.fid)}
                        onMouseLeave={() => setHover(null)}
                        style={{
                          ...S.row,
                          background: on ? `${metric.accent}14`
                            : hover === p.fid ? '#f5f4f2' : 'transparent',
                          borderLeftColor: on ? metric.accent : 'transparent',
                        }}>
                  <span style={{ ...S.rRank, color: i < 10 ? metric.accent : MUTED }}>
                    {i + 1}
                  </span>
                  <span style={S.rName}>
                    <span style={S.rTitle}>{p.name}</span>
                    <span style={S.rMeta}>
                      {p.miles} mi &middot; {p.n_routes} routes &middot;{' '}
                      {compact(p.riders_20d)} riders
                    </span>
                  </span>
                  <span style={S.rVal}>{compact(p[metricId])}</span>
                </button>
              )
            })}
            {!rows.length && <p style={S.blurb}>Nothing matches that filter.</p>}
          </section>
        </aside>

        <main style={S.mapWrap}>
          <div ref={boxRef} style={S.map} />
          {!features && <div style={S.loading}>Loading the bus network...</div>}
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
    background: on ? '#F2672412' : PAPER,
  }}>
    <b style={{ color: on ? ORANGE : INK, fontSize: 12.5 }}>
      {n ? fmt(n) : '...'} {lab}
    </b>
    <span style={S.viewSub}>{sub}</span>
  </button>
)
const Stat = ({ v, l, accent }) => (
  <div style={{ minWidth: 92 }}>
    <div style={{ ...S.statV, color: accent || INK }}>{v}</div>
    <div style={S.statL}>{l}</div>
  </div>
)
const Sum = ({ v, l, accent }) => (
  <div>
    <div style={{ ...S.sumV, color: accent || INK }}>{v}</div>
    <div style={S.sumL}>{l}</div>
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
            RANK {p.rank} OF {fmt(total)} BY PASSENGER DELAY
          </div>
          <h2 style={S.dH}>{p.name}</h2>
          <div style={S.dSub}>
            {p.borough} &middot; {p.miles} miles &middot; {p.n_blocks} roadway blocks
            {view === 'roads' ? '' : ' chained'}
          </div>
        </div>
        <button onClick={onClose} style={S.close} aria-label="Close">&times;</button>
      </div>

      <div style={S.dGrid}>
        <Cell big v={fmt(p.riders_20d)} l="riders carried"
              sub="past an average point, 20 days" accent={ORANGE} />
        <Cell big v={fmt(p.pax_delay_min)} l="passenger-minutes lost" />
        <Cell v={fmt(p.veh_delay_min)} l="bus-minutes lost" />
        <Cell v={fmt(p.bus_trips_20d)} l="bus trips" sub="past an average point" />
        <Cell v={fmt(p.min_per_bus, 2)} l="minutes lost end to end"
              sub="for the bus, and a rider aboard" />
        <Cell v={fmt(p.riders_per_bus, 1)} l="riders per bus" sub="average load" />
        <Cell v={fmt(p.sec_per_rider)} l="seconds lost per rider" />
        <Cell v={fmt(p.riders_per_delayed_bus_min, 1)} l="riders per bus-minute lost" />
        <Cell v={fmt(p.riders_per_day)} l="riders per day" />
        <Cell v={fmt(p.buses_per_day)} l="buses per day" />
        <Cell v={fmt(p.share_of_city_delay_pct, 2) + '%'}
              l={view === 'roads' ? 'of citywide delay' : 'of all corridor delay'} />
        <Cell v={fmt(p.pax_delay_per_mile)} l="passenger-min per mile" />
      </div>

      <div style={S.dBlock}>
        <div style={S.label}>WHEN IT HAPPENS (WEEKDAY)</div>
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
                  background: p.peak_period === q.id ? metric.accent : '#d8d6d2',
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
                          ? metric.accent : '#d8d6d2',
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
          {routes.length} ROUTES USE THIS {view === 'roads' ? 'STREET' : 'CORRIDOR'}
        </div>
        <div style={S.rtWrap}>
          {routes.map((r) => <span key={r} style={S.rt}>{r}</span>)}
        </div>
      </div>

      <p style={S.foot}>
        Both directions are combined, because an intervention is scoped for the street
        rather than one side of it. Delay is clipped at the source cell, so a bus
        recovering time is not counted as negative delay. Riders are counted past an
        average point, not summed along the length.
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
  page: { fontFamily: '"Segoe UI", system-ui, -apple-system, sans-serif', color: INK,
          background: PAPER, height: '100vh', display: 'flex',
          flexDirection: 'column', overflow: 'hidden' },
  header: { padding: '16px 24px 14px', borderBottom: `1px solid ${LINE}`,
            display: 'flex', gap: 28, alignItems: 'flex-start',
            justifyContent: 'space-between', flexWrap: 'wrap' },
  eyebrow: { fontSize: 10.5, fontWeight: 700, letterSpacing: '.12em', color: ORANGE,
             marginBottom: 5 },
  h1: { margin: 0, fontSize: 24, fontWeight: 700, letterSpacing: '-.01em' },
  sub: { margin: '6px 0 0', color: MUTED, fontSize: 13, maxWidth: 640,
         lineHeight: 1.5 },
  hstats: { display: 'flex', gap: 24 },
  statV: { fontSize: 24, fontWeight: 700, lineHeight: 1.05 },
  statL: { fontSize: 10.5, color: MUTED, marginTop: 3 },

  body: { flex: 1, display: 'flex', minHeight: 0 },
  panel: { width: 384, minWidth: 330, borderRight: `1px solid ${LINE}`,
           overflowY: 'auto', background: '#fcfbfa' },
  block: { padding: '15px 19px' },
  label: { fontSize: 10, fontWeight: 700, letterSpacing: '.1em', color: MUTED,
           marginBottom: 8 },
  blurb: { fontSize: 11.5, color: MUTED, lineHeight: 1.45, margin: '8px 0 0' },

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
  tick: { fontSize: 10.5, color: MUTED, background: 'none', border: 'none',
          cursor: 'pointer', padding: '2px 3px', fontFamily: 'inherit' },
  search: { width: '100%', marginTop: 14, padding: '8px 10px', fontSize: 12.5,
            border: `1px solid ${LINE}`, borderRadius: 6, fontFamily: 'inherit',
            boxSizing: 'border-box' },

  sumGrid: { display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '11px 6px' },
  sumV: { fontSize: 16, fontWeight: 700, lineHeight: 1.1 },
  sumL: { fontSize: 10, color: MUTED, marginTop: 2 },

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
  rVal: { fontSize: 12, fontWeight: 600, fontVariantNumeric: 'tabular-nums' },

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
  cellV: { fontWeight: 700, lineHeight: 1.12, fontVariantNumeric: 'tabular-nums' },
  cellL: { fontSize: 10.5, color: MUTED, marginTop: 2, lineHeight: 1.3 },
  cellSub: { fontSize: 9.5, color: '#a9a7a3', marginTop: 1 },
  dBlock: { marginTop: 18, paddingTop: 14, borderTop: `1px solid ${LINE}` },

  pRow: { display: 'flex', alignItems: 'center', gap: 9, padding: '3px 0' },
  pName: { fontSize: 11, width: 104, fontWeight: 600 },
  pBarWrap: { flex: 1, height: 7, background: '#f0efed', borderRadius: 4 },
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

  err: { padding: 40, fontFamily: '"Segoe UI", system-ui, sans-serif' },
}
