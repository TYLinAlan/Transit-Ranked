import React from 'react'
import ReactDOM from 'react-dom/client'
import { SpeedInsights } from '@vercel/speed-insights/react'
import CorridorsApp from './CorridorsApp'

/*  transitranked.com now opens on the bus-corridor map.
 *
 *  The original subway station ranker is untouched on disk at
 *  src/StationRankerApp.jsx. To put it back, swap the import and the element
 *  below; nothing else in the project depends on this file.
 *
 *      import StationRankerApp from './StationRankerApp'
 *      ...
 *      <StationRankerApp />
 */

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <SpeedInsights />
    <CorridorsApp />
  </React.StrictMode>
)
