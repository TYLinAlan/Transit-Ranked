import { useEffect, useMemo, useRef, useState } from 'react'
import maplibregl from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'

/*  Where Delay Lands — every bus corridor in New York, ranked by the delay its
 *  riders absorb rather than the delay its buses absorb.
 *
 *  The whole page is driven by two files in /data:
 *    corridors.geojson    303 corridors, geometry + attributes
 *    corridors_meta.json  headline totals and the field dictionary
 *
 *  Colour always encodes the ACTIVE METRIC, never rank, so switching metric
 *  repaints the map into a genuinely different picture. That switch is the
 *  argument the site is making, so it is the first control in the panel.
 */

const DATA = '/data/corridors.geojson'
const META = '/data/corridors_meta.json'

const INK = '#1c1c1e'
const MUTED = '#6d6e71'
const LINE = '#e3e1dd'
const ORANGE = '#F26724'
const BLUE = '#476AA3'
const PAPER = '#ffffff'

// single-hue ramps: magnitude by lightness, never by hue rotation
const RAMP_PAX = ['#FBD9C4', '#F5A970', '#EE8440', '#D4570F', '#8A3208']
const RAMP_BUS = ['#D3DEEB', '#A9BFD8', '#7B9AC2', '#4F76A6', '#2C4B77']
const CLASS_LABELS = ['lowest half', '50–75th', '75–90th', '90–97th', 'worst 3%']

const METRICS = [
  { id: 'pax_delay_min', label: 'Passenger delay', unit: 'passenger-min',
    ramp: RAMP_PAX, accent: ORANGE,
    blurb: 'Bus delay multiplied by how many people were on board.' },
  { id: 'veh_delay_min', label: 'Bus delay', unit: 'bus-min',
    ramp: RAMP_BUS, accent: BLUE,
    blurb: 'The conventional measure. Every bus counts the same, full or empty.' },
  { id: 'riders_20d', label: 'Riders carried', unit: 'riders',
    ramp: RAMP_PAX, accent: ORANGE,
    blurb: 'Passengers past an average point on the corridor over 20 days.' },
  { id: 'min_per_bus', label: 'Minutes per bus', unit: 'min',
    ramp: RAMP_BUS, accent: BLUE,
    blurb: 'What an average bus loses crossing the whole corridor.' },
  { id: 'sec_per_rider', label: 'Seconds per rider', unit: 'sec',
    ramp: RAMP_PAX, accent: ORANGE,
    blurb: 'What a rider aboard for the whole corridor loses.' },
]

const PERIODS = [
  { id: 'am', label: 'AM peak', hours: '06–09' },
  { id: 'md', label: 'Midday', hours: '10–14' },
  { id: 'pm', label: 'PM peak', hours: '15–18' },
  { id: 'ev', label: 'Evening', hours: '19–23' },
  { id: 'night', label: 'Overnight', hours: '00–05' },
]

// the fixed list is a fallback; the live one is derived from the data below so a
// corridor with an unexpected borough is never silently filtered away
const BOROUGH_FALLBACK = ['Bronx', 'Brooklyn', 'Manhattan', 'Queens', 'Staten Island']

const fmt = (n, d = 0) =>
  n === null || n === undefined || Number.isNaN(n)
    ? '—'
    : Number(n).toLocaleString('en-US', { minimumFractionDigits: d,
                                          maximumFractionDigits: d })
const compact = (n) =>
  n === null || n === undefined ? '—'
    : Math.abs(n) >= 1e6 ? `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M`
    : Math.abs(n) >= 1e3 ? `${(n / 1e3).toFixed(n >= 1e4 ? 0 : 1)}k`
    : `${Math.round(n)}`

/* percentile breaks, because corridor intensity is log-normal and equal
 * intervals would drop four-fifths of the network into one class */
function breaks(values) {
  const v = values.filter((x) => x > 0).sort((a, b) => a - b)
  if (!v.length) return [0, 0, 0, 0]
  const at = (p) => v[Math.min(v.length - 1, Math.floor(p * v.length))]
  return [at(0.5), at(0.75), at(0.9), at(0.97)]
}
export default function CorridorsApp() {
  const mapRef = useRef(null)
  const containerRef = useRef(null)
  const popupRef = useRef(null)

  const [features, setFeatures] = useState(null)
  const [meta, setMeta] = useState(null)
  const [error, setError] = useState(null)

  const [metricId, setMetricId] = useState('pax_delay_min')
  const [boroughs, setBoroughs] = useState(new Set(BOROUGH_FALLBACK))
  const [topN, setTopN] = useState(303)
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState(null)
  const [hovered, setHovered] = useState(null)

  const metric = METRICS.find((m) => m.id === metricId)
  const BOROUGHS = useMemo(() => features
    ? [...new Set(features.map((f) => f.properties.borough))].sort()
    : BOROUGH_FALLBACK, [features])

  useEffect(() => {
    let alive = true
    Promise.all([
      fetch(DATA).then((r) => { if (!r.ok) throw new Error(`corridors.geojson ${r.status}`); return r.json() }),
      fetch(META).then((r) => (r.ok ? r.json() : null)),
    ])
      .then(([gj, m]) => {
        if (!alive) return
        setFeatures(gj.features)
        setMeta(m)
        setBoroughs(new Set(gj.features.map((f) => f.properties.borough)))
      })
      .catch((e) => alive && setError(e.message))
    return () => { alive = false }
  }, [])

  /* rows the table and the map agree on: same filter, same order */
  const rows = useMemo(() => {
    if (!features) return []
    const q = query.trim().toLowerCase()
    return features
      .map((f) => f.properties)
      .filter((p) => boroughs.has(p.borough))
      .filter((p) => !q
        || p.name.toLowerCase().includes(q)
        || String(p.routes || '').toLowerCase().includes(q))
      .sort((a, b) => (b[metricId] ?? 0) - (a[metricId] ?? 0))
      .slice(0, topN)
  }, [features, boroughs, query, metricId, topN])

  const visibleIds = useMemo(() => new Set(rows.map((r) => r.corridor_id)), [rows])
  const brk = useMemo(() => breaks(rows.map((r) => r[metricId] ?? 0)), [rows, metricId])

  const totals = useMemo(() => {
    const sum = (k) => rows.reduce((a, r) => a + (Number(r[k]) || 0), 0)
    return {
      n: rows.length,
      pax: sum('pax_delay_min'),
      bus: sum('veh_delay_min'),
      riders: sum('riders_20d'),
      trips: sum('bus_trips_20d'),
      miles: sum('miles'),
    }
  }, [rows])

  // ------------------------------------------------------------------- map
  useEffect(() => {
    if (mapRef.current || !containerRef.current) return
    const map = new maplibregl.Map({
      container: containerRef.current,
      style: {
        version: 8,
        sources: {
          osm: {
            type: 'raster',
            tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
            tileSize: 256,
            attribution: '© OpenStreetMap contributors',
          },
        },
        layers: [
          { id: 'osm', type: 'raster', source: 'osm',
            paint: { 'raster-saturation': -0.86, 'raster-contrast': -0.12,
                     'raster-brightness-min': 0.16 } },
        ],
      },
      center: [-73.94, 40.70],
      zoom: 10.1,
      attributionControl: { compact: true },
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
      if (!map.getSource('corridors')) {
        map.addSource('corridors', { type: 'geojson', data, promoteId: 'corridor_id' })
        map.addLayer({
          id: 'corridors-casing', type: 'line', source: 'corridors',
          layout: { 'line-cap': 'round', 'line-join': 'round' },
          paint: { 'line-color': PAPER, 'line-width': 6, 'line-opacity': 0.85 },
        })
        map.addLayer({
          id: 'corridors-line', type: 'line', source: 'corridors',
          layout: { 'line-cap': 'round', 'line-join': 'round' },
          paint: { 'line-color': ORANGE, 'line-width': 3 },
        })
        map.addLayer({
          id: 'corridors-hit', type: 'line', source: 'corridors',
          paint: { 'line-color': '#000', 'line-opacity': 0, 'line-width': 18 },
        })
        map.on('mousemove', 'corridors-hit', (e) => {
          map.getCanvas().style.cursor = 'pointer'
          const f = e.features?.[0]
          if (!f) return
          setHovered(f.properties.corridor_id)
          const q = f.properties
          if (!popupRef.current) {
            popupRef.current = new maplibregl.Popup({
              closeButton: false, closeOnClick: false, offset: 12,
              className: 'corridor-tip',
            })
          }
          popupRef.current
            .setLngLat(e.lngLat)
            .setHTML(
              `<div style="font:600 12.5px 'Segoe UI',system-ui,sans-serif;color:#1c1c1e">
                 #${q.rank} ${q.name}</div>
               <div style="font:400 11px 'Segoe UI',system-ui,sans-serif;color:#6d6e71;margin-top:2px">
                 ${Number(q.pax_delay_min).toLocaleString()} passenger-min ·
                 ${Number(q.riders_20d).toLocaleString()} riders</div>`)
            .addTo(map)
        })
        map.on('mouseleave', 'corridors-hit', () => {
          map.getCanvas().style.cursor = ''
          setHovered(null)
          popupRef.current?.remove()
        })
        map.on('click', 'corridors-hit', (e) => {
          const p = e.features?.[0]?.properties
          if (p) setSelected(JSON.parse(JSON.stringify(p)))
        })
      } else {
        map.getSource('corridors').setData(data)
      }
    }
    if (map.isStyleLoaded()) apply()
    else map.once('load', apply)
  }, [features])

  /* repaint on every control change: colour by class, hide what is filtered out,
   * and thicken the selection so it survives a busy background */
  useEffect(() => {
    const map = mapRef.current
    if (!map || !map.getLayer || !map.getLayer('corridors-line')) return
    const ids = [...visibleIds]
    const filter = ids.length
      ? ['in', ['get', 'corridor_id'], ['literal', ids]]
      : ['==', ['get', 'corridor_id'], '__none__']

    const colour = ['case',
      ['==', ['get', 'corridor_id'], selected?.corridor_id ?? '__none__'], INK,
      ['step', ['coalesce', ['get', metricId], 0],
        metric.ramp[0], brk[0], metric.ramp[1], brk[1], metric.ramp[2],
        brk[2], metric.ramp[3], brk[3], metric.ramp[4]],
    ]
    const width = ['case',
      ['==', ['get', 'corridor_id'], selected?.corridor_id ?? '__none__'], 7,
      ['==', ['get', 'corridor_id'], hovered ?? '__none__'], 6,
      ['step', ['coalesce', ['get', metricId], 0],
        2, brk[0], 2.6, brk[1], 3.4, brk[2], 4.4, brk[3], 5.6],
    ]
    map.setFilter('corridors-line', filter)
    map.setFilter('corridors-casing', filter)
    map.setFilter('corridors-hit', filter)
    map.setPaintProperty('corridors-line', 'line-color', colour)
    map.setPaintProperty('corridors-line', 'line-width', width)
    map.setPaintProperty('corridors-casing', 'line-width',
      ['+', 3, ['case', ['==', ['get', 'corridor_id'], selected?.corridor_id ?? '__none__'], 7, 3]])
  }, [visibleIds, metricId, brk, selected, hovered, metric])

  /* fly to a corridor when it is chosen from the list */
  const focus = (p) => {
    setSelected(p)
    const map = mapRef.current
    const f = features?.find((x) => x.properties.corridor_id === p.corridor_id)
    if (!map || !f) return
    const coords = f.geometry.type === 'MultiLineString'
      ? f.geometry.coordinates.flat() : f.geometry.coordinates
    const b = coords.reduce((acc, c) => acc.extend(c),
      new maplibregl.LngLatBounds(coords[0], coords[0]))
    map.fitBounds(b, { padding: 140, maxZoom: 15, duration: 700 })
  }

  const toggleBorough = (b) => setBoroughs((prev) => {
    const next = new Set(prev)
    if (next.has(b)) { if (next.size > 1) next.delete(b) } else next.add(b)
    return next
  })

  if (error) {
    return (
      <div style={S.errorWrap}>
        <h1 style={{ margin: 0, fontSize: 20 }}>Could not load the corridor data</h1>
        <p style={{ color: MUTED }}>{error}</p>
        <p style={{ color: MUTED, fontSize: 13 }}>
          Expected <code>{DATA}</code> and <code>{META}</code> under <code>public/</code>.
        </p>
      </div>
    )
  }

  return (
    <div style={S.page}>
      <Header meta={meta} />

      <div style={S.body}>
        <aside style={S.panel}>
          <Controls
            metricId={metricId} setMetricId={setMetricId}
            boroughs={boroughs} toggleBorough={toggleBorough} allBoroughs={BOROUGHS}
            topN={topN} setTopN={setTopN}
            query={query} setQuery={setQuery}
            total={features?.length ?? 0}
          />
          <Summary totals={totals} metric={metric} />
          <Legend metric={metric} brk={brk} />
          <RankList
            rows={rows} metric={metric} selected={selected}
            hovered={hovered} setHovered={setHovered} onPick={focus}
          />
        </aside>

        <main style={S.mapWrap}>
          <div ref={containerRef} style={S.map} />
          {!features && <div style={S.loading}>Loading 303 corridors…</div>}
          {selected && (
            <Detail
              p={selected} metric={metric}
              onClose={() => setSelected(null)}
            />
          )}
        </main>
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ header */
function Header({ meta }) {
  const t = meta?.totals
  return (
    <header style={S.header}>
      <div>
        <div style={S.eyebrow}>TRANSIT RANKED</div>
        <h1 style={S.h1}>Where bus delay lands in New York</h1>
        <p style={S.sub}>
          Every bus corridor in the city, ranked by the delay its riders absorb
          rather than the delay its buses absorb. Twenty days of GTFS-Realtime,
          weighted by how many people were actually on board.
        </p>
      </div>
      {t && (
        <div style={S.headStats}>
          <Stat v={compact(t.riders_20d)} l="riders carried" accent={ORANGE} />
          <Stat v={compact(t.passenger_delay_min)} l="passenger-minutes lost" />
          <Stat v={compact(t.bus_delay_min)} l="bus-minutes lost" />
          <Stat v={meta.corridors} l="corridors" />
        </div>
      )}
    </header>
  )
}

const Stat = ({ v, l, accent }) => (
  <div style={{ minWidth: 96 }}>
    <div style={{ ...S.statV, color: accent || INK }}>{v}</div>
    <div style={S.statL}>{l}</div>
  </div>
)

/* ---------------------------------------------------------------- controls */
function Controls({ metricId, setMetricId, boroughs, toggleBorough, allBoroughs,
                    topN, setTopN, query, setQuery, total }) {
  return (
    <section style={S.block}>
      <div style={S.label}>COLOUR AND RANK BY</div>
      <div style={S.metricGrid}>
        {METRICS.map((m) => (
          <button
            key={m.id}
            onClick={() => setMetricId(m.id)}
            style={{
              ...S.metricBtn,
              borderColor: metricId === m.id ? m.accent : LINE,
              background: metricId === m.id ? `${m.accent}14` : PAPER,
              color: metricId === m.id ? m.accent : INK,
              fontWeight: metricId === m.id ? 700 : 500,
            }}
          >{m.label}</button>
        ))}
      </div>
      <p style={S.blurb}>{METRICS.find((m) => m.id === metricId).blurb}</p>

      <div style={{ ...S.label, marginTop: 18 }}>BOROUGH</div>
      <div style={S.chips}>
        {allBoroughs.map((b) => (
          <button
            key={b}
            onClick={() => toggleBorough(b)}
            style={{
              ...S.chip,
              borderColor: boroughs.has(b) ? INK : LINE,
              background: boroughs.has(b) ? INK : PAPER,
              color: boroughs.has(b) ? PAPER : MUTED,
            }}
          >{b}</button>
        ))}
      </div>

      <div style={{ ...S.label, marginTop: 18 }}>
        SHOW TOP <span style={{ color: INK }}>{topN}</span> OF {total}
      </div>
      <input
        type="range" min="10" max={total || 303} step="1" value={topN}
        onChange={(e) => setTopN(Number(e.target.value))}
        style={S.range}
      />
      <div style={S.rangeTicks}>
        {[10, 50, 100, 200, total || 303].map((n) => (
          <button key={n} onClick={() => setTopN(n)} style={S.tick}>{n}</button>
        ))}
      </div>

      <input
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Search a street or a route (B41, Utica…)"
        style={S.search}
      />
    </section>
  )
}

/* ----------------------------------------------------------------- summary */
function Summary({ totals, metric }) {
  return (
    <section style={{ ...S.block, borderTop: `1px solid ${LINE}` }}>
      <div style={S.label}>WHAT IS ON SCREEN</div>
      <div style={S.sumGrid}>
        <SumCell v={fmt(totals.n)} l="corridors" />
        <SumCell v={compact(totals.riders)} l="riders" accent={ORANGE} />
        <SumCell v={compact(totals.pax)} l="passenger-min" />
        <SumCell v={compact(totals.bus)} l="bus-min" />
        <SumCell v={compact(totals.trips)} l="bus trips" />
        <SumCell v={totals.miles.toFixed(1)} l="miles" />
      </div>
      <p style={S.blurb}>
        Ranked by {metric.label.toLowerCase()}.
      </p>
    </section>
  )
}
const SumCell = ({ v, l, accent }) => (
  <div>
    <div style={{ ...S.sumV, color: accent || INK }}>{v}</div>
    <div style={S.sumL}>{l}</div>
  </div>
)

/* ------------------------------------------------------------------ legend */
function Legend({ metric, brk }) {
  return (
    <section style={{ ...S.block, borderTop: `1px solid ${LINE}` }}>
      <div style={S.label}>{metric.label.toUpperCase()} ({metric.unit})</div>
      {metric.ramp.map((c, i) => (
        <div key={i} style={S.legendRow}>
          <span style={{ ...S.legendSwatch, background: c,
                         height: 3 + i * 1.3 }} />
          <span style={S.legendLabel}>{CLASS_LABELS[i]}</span>
          <span style={S.legendVal}>
            {i === 0 ? `< ${compact(brk[0])}`
              : i === 4 ? `> ${compact(brk[3])}`
              : `${compact(brk[i - 1])} – ${compact(brk[i])}`}
          </span>
        </div>
      ))}
      <p style={{ ...S.blurb, marginTop: 10 }}>
        Classes are percentiles of what is on screen, because corridor intensity is
        log-normal. Equal intervals would put four-fifths of the network in one band.
      </p>
    </section>
  )
}

/* --------------------------------------------------------------- rank list */
function RankList({ rows, metric, selected, hovered, setHovered, onPick }) {
  return (
    <section style={{ ...S.block, borderTop: `1px solid ${LINE}`, paddingBottom: 40 }}>
      <div style={S.label}>RANKED LIST</div>
      <div>
        {rows.map((p, i) => {
          const on = selected?.corridor_id === p.corridor_id
          const hot = hovered === p.corridor_id
          return (
            <button
              key={p.corridor_id}
              onClick={() => onPick(p)}
              onMouseEnter={() => setHovered(p.corridor_id)}
              onMouseLeave={() => setHovered(null)}
              style={{
                ...S.row,
                background: on ? `${metric.accent}14` : hot ? '#f7f6f4' : 'transparent',
                borderLeft: `3px solid ${on ? metric.accent : 'transparent'}`,
              }}
            >
              <span style={{ ...S.rowRank, color: i < 10 ? metric.accent : MUTED }}>
                {i + 1}
              </span>
              <span style={S.rowName}>
                <span style={{ fontWeight: 600 }}>{p.name}</span>
                <span style={S.rowMeta}>
                  {p.miles} mi · {p.n_routes} routes · {compact(p.riders_20d)} riders
                </span>
              </span>
              <span style={S.rowVal}>{compact(p[metric.id])}</span>
            </button>
          )
        })}
        {!rows.length && (
          <p style={S.blurb}>Nothing matches that filter.</p>
        )}
      </div>
    </section>
  )
}

/* ------------------------------------------------------------------ detail */
function Detail({ p, metric, onClose }) {
  // a clicked feature arrives from MapLibre with arrays serialised to strings;
  // a row clicked in the list is the real object. Accept both.
  const asArray = (v) => Array.isArray(v) ? v
    : typeof v === 'string' ? (() => { try { return JSON.parse(v) } catch { return [] } })()
    : []
  const routes = asArray(p.routes)
  const hourly = asArray(p.hourly_pax)
  const maxH = Math.max(1, ...hourly)
  const periodMax = Math.max(...PERIODS.map((q) => p[`pax_${q.id}`] ?? 0), 1)

  return (
    <div style={S.detail}>
      <div style={S.detailHead}>
        <div>
          <div style={{ ...S.eyebrow, color: metric.accent }}>
            RANK {p.rank} OF 303 BY PASSENGER DELAY
          </div>
          <h2 style={S.detailH}>{p.name}</h2>
          <div style={S.detailSub}>
            {p.borough} · {p.miles} miles · {p.n_blocks} roadway blocks
          </div>
        </div>
        <button onClick={onClose} style={S.close} aria-label="Close">×</button>
      </div>

      <div style={S.detailGrid}>
        <Cell big v={fmt(p.riders_20d)} l="riders carried"
              sub="past an average point, 20 days" accent={ORANGE} />
        <Cell big v={fmt(p.pax_delay_min)} l="passenger-minutes lost" />
        <Cell v={fmt(p.veh_delay_min)} l="bus-minutes lost" />
        <Cell v={fmt(p.bus_trips_20d)} l="bus trips" sub="past an average point" />
        <Cell v={fmt(p.min_per_bus, 2)} l="minutes lost crossing it"
              sub="for the bus, and for a rider aboard" />
        <Cell v={fmt(p.riders_per_bus, 1)} l="riders per bus" sub="average load" />
        <Cell v={fmt(p.sec_per_rider)} l="seconds lost per rider" />
        <Cell v={fmt(p.riders_per_delayed_bus_min, 1)} l="riders per bus-minute lost" />
        <Cell v={fmt(p.riders_per_day)} l="riders per day" />
        <Cell v={fmt(p.buses_per_day)} l="buses per day" />
        <Cell v={`${fmt(p.share_of_city_delay_pct, 2)}%`} l="of all corridor delay" />
        <Cell v={fmt(p.pax_delay_per_mile)} l="passenger-min per mile" />
      </div>

      <div style={S.detailBlock}>
        <div style={S.label}>WHEN IT HAPPENS (WEEKDAY)</div>
        {PERIODS.map((q) => (
          <div key={q.id} style={S.periodRow}>
            <span style={S.periodName}>
              {q.label} <span style={{ color: MUTED, fontWeight: 400 }}>{q.hours}</span>
            </span>
            <span style={S.periodBarWrap}>
              <span style={{
                ...S.periodBar,
                width: `${((p[`pax_${q.id}`] ?? 0) / periodMax) * 100}%`,
                background: p.peak_period === q.id ? metric.accent : '#d8d6d2',
              }} />
            </span>
            <span style={S.periodVal}>{p[`share_${q.id}_pct`] ?? 0}%</span>
          </div>
        ))}
        {hourly.length === 24 && (
          <>
            <div style={S.spark}>
              {hourly.map((v, h) => (
                <span key={h} title={`${h}:00 — ${fmt(v)} passenger-min`}
                      style={{
                        ...S.sparkBar,
                        height: `${Math.max(2, (v / maxH) * 46)}px`,
                        background: (h >= 6 && h <= 9) || (h >= 15 && h <= 18)
                          ? metric.accent : '#d8d6d2',
                      }} />
              ))}
            </div>
            <div style={S.sparkAxis}><span>00</span><span>06</span><span>12</span>
              <span>18</span><span>23</span></div>
          </>
        )}
      </div>

      <div style={S.detailBlock}>
        <div style={S.label}>{routes.length} ROUTES USE THIS CORRIDOR</div>
        <div style={S.routeWrap}>
          {routes.map((r) => <span key={r} style={S.route}>{r}</span>)}
        </div>
      </div>

      <p style={S.footnote}>
        Both directions are combined, because an intervention is scoped for the
        street rather than one side of it. Delay is clipped at the source cell, so a
        bus recovering time is not counted as negative delay.
      </p>
    </div>
  )
}

const Cell = ({ v, l, sub, accent, big }) => (
  <div style={S.cell}>
    <div style={{ ...S.cellV, color: accent || INK, fontSize: big ? 22 : 18 }}>{v}</div>
    <div style={S.cellL}>{l}</div>
    {sub && <div style={S.cellSub}>{sub}</div>}
  </div>
)

/* ------------------------------------------------------------------ styles */
const S = {
  page: { fontFamily: '"Segoe UI", system-ui, -apple-system, sans-serif',
          color: INK, background: PAPER, height: '100vh', display: 'flex',
          flexDirection: 'column', overflow: 'hidden' },
  header: { padding: '18px 26px 16px', borderBottom: `1px solid ${LINE}`,
            display: 'flex', gap: 30, alignItems: 'flex-start',
            justifyContent: 'space-between', flexWrap: 'wrap' },
  eyebrow: { fontSize: 11, fontWeight: 700, letterSpacing: '.12em',
             color: ORANGE, marginBottom: 6 },
  h1: { margin: 0, fontSize: 25, fontWeight: 700, letterSpacing: '-.01em' },
  sub: { margin: '7px 0 0', color: MUTED, fontSize: 13.5, maxWidth: 660,
         lineHeight: 1.5 },
  headStats: { display: 'flex', gap: 26, alignItems: 'flex-start' },
  statV: { fontSize: 25, fontWeight: 700, lineHeight: 1.05 },
  statL: { fontSize: 11, color: MUTED, marginTop: 3 },

  body: { flex: 1, display: 'flex', minHeight: 0 },
  panel: { width: 390, minWidth: 340, borderRight: `1px solid ${LINE}`,
           overflowY: 'auto', background: '#fcfbfa' },
  block: { padding: '16px 20px' },
  label: { fontSize: 10.5, fontWeight: 700, letterSpacing: '.1em', color: MUTED,
           marginBottom: 9 },
  blurb: { fontSize: 12, color: MUTED, lineHeight: 1.45, margin: '9px 0 0' },

  metricGrid: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 },
  metricBtn: { padding: '8px 9px', fontSize: 12, borderRadius: 7,
               border: `1.5px solid ${LINE}`, cursor: 'pointer',
               fontFamily: 'inherit', textAlign: 'left' },
  chips: { display: 'flex', flexWrap: 'wrap', gap: 5 },
  chip: { padding: '5px 10px', fontSize: 11.5, borderRadius: 999,
          border: `1px solid ${LINE}`, cursor: 'pointer', fontFamily: 'inherit' },
  range: { width: '100%', accentColor: ORANGE, marginTop: 2 },
  rangeTicks: { display: 'flex', gap: 6, marginTop: 4 },
  tick: { fontSize: 11, color: MUTED, background: 'none', border: 'none',
          cursor: 'pointer', padding: '2px 4px', fontFamily: 'inherit' },
  search: { width: '100%', marginTop: 16, padding: '9px 11px', fontSize: 13,
            border: `1px solid ${LINE}`, borderRadius: 7, fontFamily: 'inherit',
            boxSizing: 'border-box' },

  sumGrid: { display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '12px 8px' },
  sumV: { fontSize: 17, fontWeight: 700, lineHeight: 1.1 },
  sumL: { fontSize: 10.5, color: MUTED, marginTop: 2 },

  legendRow: { display: 'flex', alignItems: 'center', gap: 9, padding: '3px 0' },
  legendSwatch: { width: 30, borderRadius: 2, flexShrink: 0 },
  legendLabel: { fontSize: 12, flex: 1 },
  legendVal: { fontSize: 11, color: MUTED, fontVariantNumeric: 'tabular-nums' },

  row: { display: 'flex', alignItems: 'center', gap: 10, width: '100%',
         padding: '7px 8px', border: 'none', cursor: 'pointer', textAlign: 'left',
         fontFamily: 'inherit', borderRadius: 5 },
  rowRank: { fontSize: 12, fontWeight: 700, width: 24,
             fontVariantNumeric: 'tabular-nums' },
  rowName: { flex: 1, display: 'flex', flexDirection: 'column', gap: 1,
             minWidth: 0, fontSize: 12.5 },
  rowMeta: { fontSize: 10.5, color: MUTED },
  rowVal: { fontSize: 12.5, fontWeight: 600, fontVariantNumeric: 'tabular-nums' },

  mapWrap: { flex: 1, position: 'relative', minWidth: 0 },
  map: { position: 'absolute', inset: 0 },
  loading: { position: 'absolute', top: 18, left: 18, background: PAPER,
             padding: '8px 13px', borderRadius: 7, fontSize: 13, color: MUTED,
             border: `1px solid ${LINE}` },

  detail: { position: 'absolute', top: 14, right: 14, bottom: 14, width: 396,
            background: PAPER, borderRadius: 11, border: `1px solid ${LINE}`,
            boxShadow: '0 10px 34px rgba(0,0,0,.13)', overflowY: 'auto',
            padding: '16px 18px 22px' },
  detailHead: { display: 'flex', justifyContent: 'space-between', gap: 10 },
  detailH: { margin: '2px 0 0', fontSize: 19, fontWeight: 700, lineHeight: 1.2 },
  detailSub: { fontSize: 12, color: MUTED, marginTop: 4 },
  close: { background: 'none', border: 'none', fontSize: 26, lineHeight: 1,
           color: MUTED, cursor: 'pointer', padding: 0, height: 28 },
  detailGrid: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '13px 12px',
                margin: '17px 0 4px' },
  cell: {},
  cellV: { fontWeight: 700, lineHeight: 1.12, fontVariantNumeric: 'tabular-nums' },
  cellL: { fontSize: 11, color: MUTED, marginTop: 2, lineHeight: 1.3 },
  cellSub: { fontSize: 10, color: '#a9a7a3', marginTop: 1 },
  detailBlock: { marginTop: 20, paddingTop: 15, borderTop: `1px solid ${LINE}` },

  periodRow: { display: 'flex', alignItems: 'center', gap: 9, padding: '3px 0' },
  periodName: { fontSize: 11.5, width: 108, fontWeight: 600 },
  periodBarWrap: { flex: 1, height: 8, background: '#f0efed', borderRadius: 4 },
  periodBar: { display: 'block', height: 8, borderRadius: 4 },
  periodVal: { fontSize: 11, color: MUTED, width: 38, textAlign: 'right',
               fontVariantNumeric: 'tabular-nums' },
  spark: { display: 'flex', alignItems: 'flex-end', gap: 2, height: 48,
           marginTop: 15 },
  sparkBar: { flex: 1, borderRadius: '1px 1px 0 0' },
  sparkAxis: { display: 'flex', justifyContent: 'space-between', fontSize: 10,
               color: MUTED, marginTop: 4 },

  routeWrap: { display: 'flex', flexWrap: 'wrap', gap: 4 },
  route: { fontSize: 11, padding: '3px 7px', background: '#f2f1ef',
           borderRadius: 4, fontVariantNumeric: 'tabular-nums' },
  footnote: { fontSize: 10.5, color: MUTED, lineHeight: 1.45, marginTop: 20,
              paddingTop: 13, borderTop: `1px solid ${LINE}` },

  errorWrap: { padding: 40, fontFamily: '"Segoe UI", system-ui, sans-serif' },
}
