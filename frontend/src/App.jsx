import { useState, useEffect, useRef } from 'react';
import { MapContainer, TileLayer, Marker, Popup, Polyline, CircleMarker, useMap } from 'react-leaflet';
import L from 'leaflet';
import './App.css';
import 'leaflet/dist/leaflet.css';
import MarkerClusterGroup from 'react-leaflet-cluster';

const wsLink = 'ws://localhost:5001';
// const wsLink = 'ws://34.28.224.202:5001';
// Todo: Refactor panels in seperate components
// Todo maybe make a deployment branch which can be rebased from main, wich changes this const
//change for deployment
// const API_BASE = 'http://34.28.224.202:5001';
const API_BASE = 'http://localhost:5001';

// consts for path display
const PATH_LOCATIONS_LIMIT = 30;
const TIME_INTERVAL = 15; // in minutes

// create icons per taxi
function createDotIcon({ color, size = 14, variant = 'default', ring = false, ringColor }) {
  return L.divIcon({
    className: `taxi-dot-icon dot-${variant}`,
    html: `<div class="taxi-dot" style="width:${size}px;height:${size}px;background:${color};${ring ? `box-shadow:0 0 0 3px ${ringColor}, 0 1px 3px rgba(0,0,0,0.4);` : ''}"></div>`,
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
    popupAnchor: [0, -size / 2 - 6],
  });
}

const defaultIcon = createDotIcon({ color: '#378ADD', variant: 'default' });
const speedingIcon = createDotIcon({ color: '#E2462F', size: 16, variant: 'speeding' });
const ooaIcon = createDotIcon({ color: '#1F9D55', size: 16, variant: 'area' });
const parkingIcon = createDotIcon({ color: '#9CA3AF', variant: 'parking' });
const selectedIcon = createDotIcon({ color: '#1D4ED8', size: 20, variant: 'selected', ring: true, ringColor: 'rgba(29,78,216,0.35)' });

const TAG_STYLES = {
  speeding: { bg: '#FAECE7', color: '#993C1D', dot: '#D85A30' },
  area: { bg: '#E6F6ED', color: '#1F7A43', dot: '#1F9D55' },
  taxiUpdate: { bg: '#E6F1FB', color: '#185FA5', dot: '#378ADD' },
};

// Small pill used inside the taxi popup to show status at a glance.
function StatusBadge({ label, color, bg }) {
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center',
      fontSize: 11, fontWeight: 600, lineHeight: 1.4,
      padding: '1px 7px', borderRadius: 999,
      background: bg, color,
    }}>
      {label}
    </span>
  );
}

// Per-taxi popup: header with id, status badges, and a compact stat grid.
function TaxiPopup({ taxi, isSpeeding, isOutOfArea }) {
  // Prefer totalDistance (the field the backend actually sends); fall back to
  // distance for older payloads so the value is never blank.
  const distanceKm = taxi.totalDistance ?? taxi.distance;
  const isParking = taxi.isParking;

  const rows = [
    ['Speed', taxi.speed != null ? `${taxi.speed.toFixed(1)} km/h` : '—'],
    ['Avg speed', taxi.averageSpeed != null ? `${taxi.averageSpeed.toFixed(1)} km/h` : '—'],
    ['Distance', distanceKm != null ? `${distanceKm.toFixed(2)} km` : '—'],
    ['Position', taxi.latitude != null && taxi.longitude != null
      ? `${taxi.latitude.toFixed(4)}, ${taxi.longitude.toFixed(4)}` : '—'],
    ['Updated', taxi.timestamp ?? '—'],
  ];

  return (
    <div style={{ fontSize: 13, minWidth: 200, fontFamily: 'sans-serif' }}>
      {/* Header */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 8,
        marginBottom: 8, paddingBottom: 6,
        borderBottom: '1px solid #eef0f2',
      }}>
        <span style={{ fontSize: 15, fontWeight: 700, color: '#111' }}>
          🚖 Taxi {taxi.taxi_id}
        </span>
      </div>

      {/* Status badges — only render what applies */}
      {(isSpeeding || isOutOfArea || isParking) ? (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5, marginBottom: 8 }}>
          {isSpeeding && <StatusBadge label="Speeding" color="#993C1D" bg="#FAECE7" />}
          {isOutOfArea && <StatusBadge label="Out of area" color="#1F7A43" bg="#E6F6ED" />}
          {isParking && <StatusBadge label="Parked" color="#4B5563" bg="#F1F2F4" />}
        </div>
      ) : (
        <div style={{ marginBottom: 8 }}>
          <StatusBadge label="Active" color="#185FA5" bg="#E6F1FB" />
        </div>
      )}

      {/* Stat grid */}
      <div style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', rowGap: 4, columnGap: 10 }}>
        {rows.map(([label, value]) => (
          <div key={label} style={{ display: 'contents' }}>
            <span style={{ color: '#8a8f98', fontSize: 12 }}>{label}</span>
            <span style={{ color: '#1f2328', fontWeight: 500, textAlign: 'right' }}>{value}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// const for fading
const STALE_AFTER_MS = 30 * 1000;

function getOpacity(lastSeenTime, now) {
  if (!lastSeenTime) return 1;
  const age = now - lastSeenTime;
  if (age >= STALE_AFTER_MS) return 0;
  return 1 - age / STALE_AFTER_MS;
}

function RecenterMap({ selectedTaxi }) {
  const map = useMap();

  useEffect(() => {
    if (!selectedTaxi) return;

    map.setView([selectedTaxi.latitude, selectedTaxi.longitude], map.getZoom(), {
      animate: true,
    });
  }, [map, selectedTaxi]);

  return null;
}
// Taxi search box to  display taxi path
function TaxiSearchBox({ onSelect, onClear, selectedTaxiId }) {
  const [value, setValue] = useState('');

  function handleSubmit(e) {
    e.preventDefault();
    const trimmed = value.trim();
    if (trimmed === '') return;
    onSelect(trimmed);
  }
  useEffect(() => {
    const handleKeyDown = (e) => {
      if (e.key === 'Escape' && selectedTaxiId !== null) {
        setValue('');
        onClear();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [selectedTaxiId, setValue, onClear]);

  return (
    <form onSubmit={handleSubmit} style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
      <input
        type="text"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder="select taxi"
        style={{
          padding: '4px 8px', fontSize: 13, border: '1px solid #d1d5db',
          borderRadius: 4, width: 120,
        }}
      />
      <button
        type="submit"
        style={{
          padding: '4px 10px', fontSize: 13, border: '1px solid #d1d5db',
          borderRadius: 4, background: '#fff', cursor: 'pointer',
        }}
      >
        Search
      </button>
      {selectedTaxiId !== null && (
        <button
          type="button"
          onClick={() => { setValue(''); onClear(); }}
          style={{
            padding: '4px 10px', fontSize: 13, border: '1px solid #d1d5db',
            borderRadius: 4, background: '#fff', cursor: 'pointer', color: '#555',
          }}
        >
          deselect
        </button>
      )}
    </form>
  );
}

function DebugAlerts({
  entries,
  counts,
  filters,
  onToggleFilter,
  onClear,
  selectedTaxiId,
  onSelectTaxi,
  activeFilters,
  speedingIncidents,
  areaViolations
}) {
  const logRef = useRef(null);

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = 0;
  }, [entries.length]);


  // Only show selected taxi allerts
  const visible = entries.filter(e => {
    if (!filters[e.type]) return false;
    if (selectedTaxiId !== null && String(e.taxiId) !== String(selectedTaxiId)) return false;
    return true;
  });

  return (
    <div style={{
      width: 320,
      flexShrink: 0,
      display: 'flex',
      flexDirection: 'column',
      background: '#fff',
      borderLeft: '1px solid #e5e7eb',
      fontFamily: 'monospace',
      fontSize: 12,
    }}>
      {(activeFilters.speeding || activeFilters.area) && (
        <div style={{ padding: '8px 12px', borderBottom: '1px solid #e5e7eb', background: '#FAFAFA' }}>
          <div style={{ fontWeight: 600, fontSize: 12, marginBottom: 6 }}>Current Violators</div>
          {activeFilters.speeding && speedingIncidents.map(i => (
            <div key={`s-${i.taxiId}`} onClick={() => onSelectTaxi(i.taxiId)}
              style={{ cursor: 'pointer', fontSize: 11, padding: '2px 0' }}>
              🚖 {i.taxiId} — {i.speed?.toFixed(1)} km/h
            </div>
          ))}
          {activeFilters.area && areaViolations.map(v => (
            <div key={`a-${v.taxiId}`} onClick={() => onSelectTaxi(v.taxiId)}
              style={{ cursor: 'pointer', fontSize: 11, padding: '2px 0' }}>
              🚖 {v.taxiId} — outside permitted area
            </div>
          ))}
        </div>
      )}
      {/* Header */}
      <div style={{ padding: '10px 12px', borderBottom: '1px solid #e5e7eb' }}>
        <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 8, color: '#111' }}>
          Alerts
        </div>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
          {['speeding', 'area', 'taxiUpdate'].map(type => {
            const s = TAG_STYLES[type];
            const label = type === 'taxiUpdate' ? 'updates' : type;
            return (
              <button
                key={type}
                onClick={() => onToggleFilter(type)}
                style={{
                  display: 'inline-flex', alignItems: 'center', gap: 4,
                  padding: '2px 8px', borderRadius: 4, fontSize: 11, fontWeight: 500,
                  cursor: 'pointer', border: `1px solid ${s.dot}`,
                  background: filters[type] ? s.bg : '#f3f4f6',
                  color: filters[type] ? s.color : '#888',
                  opacity: filters[type] ? 1 : 0.6,
                  transition: 'all 0.15s',
                }}
              >
                {label}
                <span style={{
                  background: 'rgba(0,0,0,0.12)', borderRadius: 999,
                  padding: '0 5px', fontSize: 10,
                }}>
                  {counts[type]}
                </span>
              </button>
            );
          })}
          <button
            onClick={onClear}
            style={{
              marginLeft: 'auto', padding: '2px 8px', fontSize: 11,
              border: '1px solid #d1d5db', borderRadius: 4,
              background: 'transparent', cursor: 'pointer', color: '#555',
            }}
          >
            clear
          </button>
        </div>
      </div>

      {/* Log */}
      <div ref={logRef} style={{ flex: 1, overflowY: 'auto', padding: '4px 0' }}>
        {visible.length === 0 ? (
          <div style={{ padding: '2rem 1rem', textAlign: 'center', color: '#aaa' }}>
            waiting for events…
          </div>
        ) : (
          visible.map((entry, i) => {
            const s = TAG_STYLES[entry.type];
            const clickable = entry.taxiId !== null && entry.taxiId !== undefined;
            const selected = clickable && String(entry.taxiId) === String(selectedTaxiId);
            return (
              <div
                key={i}
                onClick={() => clickable && onSelectTaxi(entry.taxiId)}
                style={{
                  display: 'flex', gap: 8, padding: '5px 12px',
                  borderBottom: '1px solid #f3f4f6', alignItems: 'flex-start',
                  cursor: clickable ? 'pointer' : 'default',
                  background: selected ? '#EFF6FF' : 'transparent',
                }}
              >
                <div style={{
                  width: 7, height: 7, borderRadius: '50%',
                  background: s.dot, marginTop: 4, flexShrink: 0,
                }} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div>
                    <span style={{
                      background: s.bg, color: s.color, fontSize: 10,
                      padding: '1px 5px', borderRadius: 3, marginRight: 5, fontWeight: 600,
                    }}>
                      {entry.type}
                    </span>
                    <span style={{ color: '#222', wordBreak: 'break-all' }}>{entry.text}</span>
                  </div>
                  <div style={{ color: '#aaa', fontSize: 10, marginTop: 2 }}>{entry.ts}</div>
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}

function App() {
  const [taxiMap, setTaxiMap] = useState({});
  const [speedingIncidents, setSpeedingIncidents] = useState([]);
  const [areaViolations, setAreaViolations] = useState([]);
  const [status, setStatus] = useState('Connecting...');
  const [selectedTaxiId, setSelectedTaxiId] = useState(null);
  const [totalDistanceAll, setTotalDistanceAll] = useState(null);
  // states for latency display
  const [latency, setLatency] = useState(null);
  const [latencyHistory, setLatencyHistory] = useState([]);
  const [latencyTrend, setLatencyTrend] = useState(null);
  const selectedTaxiIdRef = useRef(null);

  useEffect(() => {
    selectedTaxiIdRef.current = selectedTaxiId; // snychronizes ref to current state
  }, [selectedTaxiId]);

  //fadeout
  const [lastSeen, setLastSeen] = useState({});
  const [now, setNow] = useState(Date.now());

  // load last n locatoins per selected taxi
  const [pathLocations, setPathLocations] = useState([]);
  const [pathError, setPathError] = useState(null);

  useEffect(() => {
    const interval = setInterval(() => setNow(Date.now()), 5000);
    return () => clearInterval(interval);
  }, []);

  //batch updates
  const pendingUpdates = useRef({});
  useEffect(() => {
    const flush = setInterval(() => {
      const updates = pendingUpdates.current;
      if (Object.keys(updates).length === 0) return;
      pendingUpdates.current = {};
      const updateTime = Date.now();
      setTaxiMap(prev => ({ ...prev, ...updates }));
      setLastSeen(prev => {
        const next = { ...prev };
        Object.keys(updates).forEach(id => {
          next[id] = updateTime;
        });
        return next;
      });
    }, 3000);
    return () => clearInterval(flush);
  }, []);

  //get total distance travelled
  useEffect(() => {
    const total = Object.values(taxiMap).reduce(
      (sum, taxi) => sum + (taxi.totalDistance || 0),
      0
    );
    setTotalDistanceAll(total);
  }, [taxiMap]);

  // clusters for better overview  
  function createClusterIcon(cluster) {
    const childMarkers = cluster.getAllChildMarkers();
    const count = childMarkers.length;

    let hasSpeeding = false;
    let hasArea = false;
    childMarkers.forEach(m => {
      const cls = m.options.icon?.options?.className || '';
      if (cls.includes('dot-speeding')) hasSpeeding = true;
      else if (cls.includes('dot-area')) hasArea = true;
    });

    let variant = 'normal';
    if (hasSpeeding) variant = 'speeding';
    else if (hasArea) variant = 'area';

    let size, sizeTier;
    if (count < 10) { size = 36; sizeTier = 'sm'; }
    else if (count < 50) { size = 44; sizeTier = 'md'; }
    else { size = 52; sizeTier = 'lg'; }

    return L.divIcon({
      html: `<div class="cluster-inner">${count}</div>`,
      className: `taxi-cluster cluster-${variant} cluster-${sizeTier}`,
      iconSize: L.point(size, size),
    });
  }

  //filtering
  const [activeFilters, setActiveFilters] = useState({ speeding: false, area: false });

  function toggleViolationFilter(type) {
    setActiveFilters(prev => ({ ...prev, [type]: !prev[type] }));
  }

  function normalizeAlarmTaxi(a) {
    return {
      taxi_id: String(a.taxiId),
      latitude: a.latitude,
      longitude: a.longitude,
      speed: a.speed,
      averageSpeed: a.averageSpeed,
      distance: a.totalDistance,
      timestamp: a.timestamp,
      isSpeeding: a.isSpeeding,
      isParking: a.isParking,
      _opacity: 1,
    };
  }

  // Debug alerts state
  const [debugEntries, setDebugEntries] = useState([]);
  const [debugCounts, setDebugCounts] = useState({ speeding: 0, area: 0, taxiUpdate: 0 });
  const [debugFilters, setDebugFilters] = useState({ speeding: true, area: true, taxiUpdate: true });

  function addDebugEntry(type, text, taxiId = null) {
    const now = new Date();
    const ts = now.toTimeString().slice(0, 8) + '.' + String(now.getMilliseconds()).padStart(3, '0');
    setDebugEntries(prev => [{ type, text, ts, taxiId }, ...prev].slice(0, 300));
    setDebugCounts(prev => ({ ...prev, [type]: prev[type] + 1 }));
  }

  function toggleFilter(type) {
    setDebugFilters(prev => ({ ...prev, [type]: !prev[type] }));
  }

  function clearDebug() {
    setDebugEntries([]);
    setDebugCounts({ speeding: 0, area: 0, taxiUpdate: 0 });
  }

  function selectTaxiFromAlert(taxiId) {
    setSelectedTaxiId(prev => (String(prev) === String(taxiId) ? null : taxiId));
  }

  // Wird sowohl vom Suchfeld als auch vom Klick auf einen Marker/Alert genutzt.
  function selectTaxi(taxiId) {
    setSelectedTaxiId(taxiId);
  }

  function clearSelection() {
    setSelectedTaxiId(null);
  }

  // Laedt die letzten PATH_LOCATIONS_LIMIT Standorte des ausgewaehlten Taxis
  // aus der REST-API, sobald sich die Auswahl aendert.
  useEffect(() => {
    if (selectedTaxiId === null) {
      setPathLocations([]);
      setPathError(null);
      return;
    }

    let cancelled = false;
    setPathError(null);

    fetch(`${API_BASE}/taxis/${selectedTaxiId}/locations?time_interval=${TIME_INTERVAL}&number=${PATH_LOCATIONS_LIMIT}`)
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
      })
      .then((data) => {
        if (cancelled) return;
        setPathLocations([...data]);
      })
      .catch((err) => {
        if (cancelled) return;
        console.error('error loading path:', err);
        setPathLocations([]);
        setPathError('could not load');
      });

    return () => { cancelled = true; };
  }, [selectedTaxiId]);

  useEffect(() => {
    const socket = new WebSocket(wsLink);

    socket.onopen = () => setStatus('Connected – Live-Stream active');

    socket.onmessage = (event) => {
      console.log(event.data);
      try {
        const data = JSON.parse(event.data);

        if (data.type === 'snapshot') {
          const map = {};
          const seen = {};
          const receivedAt = Date.now();
          (data.taxis || []).forEach(t => {
            map[t.taxi_id] = t;
            seen[t.taxi_id] = receivedAt;
          });
          setTaxiMap(map);
          setLastSeen(seen);
          setSpeedingIncidents(data.speedingIncidents || []);
          setAreaViolations(data.areaViolations || []);
          addDebugEntry('taxiUpdate', `snapshot — ${data.taxis.length} taxis loaded`);

          // Extract latency from initial snapshot and convert ms to seconds
          if (data.stats && data.stats.avgLatencyMs) {
            const initialLatency = data.stats.avgLatencyMs / 1000;
            setLatency(initialLatency);
            setLatencyHistory([initialLatency]);
          }

        } else if (data.type === 'taxiUpdate') {
          const t = data.taxi;
          setTaxiMap(prev => ({ ...prev, [t.taxi_id]: t }));
          setLastSeen(prev => ({ ...prev, [t.taxi_id]: Date.now() }));
          addDebugEntry(
            'taxiUpdate',
            `taxi ${t.taxi_id} → (${t.latitude.toFixed(4)}, ${t.longitude.toFixed(4)}) ${t.speed.toFixed(1)} km/h${t.isSpeeding ? ' ⚡' : ''}${t.isParking ? ' 🅿' : ''}`,
            t.taxi_id
          );
          if (String(selectedTaxiIdRef.current) === String(data.taxi.taxi_id)) {
            setPathLocations(prev => {

              const updated = [

                ...prev,
                {
                  latitude: t.latitude,
                  longitude: t.longitude,
                  timestamp: t.timestamp,
                  speed: t.speed,
                  averageSpeed: t.averageSpeed,
                  totalDistance: t.totalDistance,
                  isSpeeding: t.isSpeeding,
                  isParking: t.isParking,
                },
              ];

              return updated.slice(-PATH_LOCATIONS_LIMIT);
            });
          }

        } else if (data.type === 'latencyStats') {
          const newLatency = data.stats.avgLatencyMs / 1000; // Convert ms to seconds
          setLatency(newLatency);

          // Track trend by comparing with last values
          setLatencyHistory(prev => {
            const newHistory = [...prev, newLatency].slice(-5); // Keep last 5 values
            if (newHistory.length >= 2) {
              const previous = newHistory[newHistory.length - 2];
              setLatencyTrend(newLatency > previous ? 'up' : newLatency < previous ? 'down' : null);
            }
            return newHistory;
          });



        } else if (data.type === 'speedingAlert') {
          const i = data.speedingIncidents;
          setSpeedingIncidents(data.speedingIncidents || []);
          i.forEach(i => {
            addDebugEntry(
              'speeding',
              `taxi ${i.taxiId} — ${i.speed.toFixed(1)} km/h`,
              i.taxiId
            );
          });

        } else if (data.type === 'areaViolation') {
          const v = data.areaViolations;
          setAreaViolations(data.areaViolations || []);
          v.forEach(violation => {
            addDebugEntry('area', `taxi ${violation.taxiId} outside permitted area`, violation.taxiId);
          });
        }

      } catch (error) {
        console.error('Error parsing WebSocket data:', error);
      }
    };

    socket.onclose = () => setStatus('Lost connection to backend');

    return () => socket.close();
  }, []);

  const allTaxis = Object.values(taxiMap);

  const violatingTaxiIds = new Set(areaViolations.map(v => String(v.taxiId)));
  const speedingTaxiIds = new Set(speedingIncidents.map(i => String(i.taxiId)));

  const visibleTaxis = allTaxis
    .map(t => ({ ...t, _opacity: getOpacity(lastSeen[t.taxi_id], now) }))
    .filter(t => t._opacity > 0);

  const hasActiveFilter = activeFilters.speeding || activeFilters.area;

  const violatorMap = {};
  if (activeFilters.speeding) {
    speedingIncidents.forEach(i => {
      violatorMap[i.taxiId] = normalizeAlarmTaxi(i);
    });
  }
  if (activeFilters.area) {
    areaViolations.forEach(v => {
      violatorMap[v.taxiId] = { ...violatorMap[v.taxiId], ...normalizeAlarmTaxi(v) };
    });
  }

  const filteredByViolation = !hasActiveFilter
    ? visibleTaxis
    : Object.values(violatorMap);

  const taxis = selectedTaxiId === null
    ? filteredByViolation
    : filteredByViolation.filter(t => String(t.taxi_id) === String(selectedTaxiId));
  const isConnected = status.includes('active') || status.includes('aktiv');

  const normalizedPathLocations = pathLocations
    .map((p) => ({
      ...p,
      latitude: Number(p.latitude),
      longitude: Number(p.longitude),
    }))
    .filter((p) => Number.isFinite(p.latitude) && Number.isFinite(p.longitude));

  const pathPositions = normalizedPathLocations.map((p) => [p.latitude, p.longitude]);

  return (
    <div style={{ padding: 0, fontFamily: 'sans-serif', height: '100vh', display: 'flex', flexDirection: 'column' }}>
      {/* Header */}
      <header style={{
        padding: '10px 16px', display: 'flex', alignItems: 'center',
        gap: 12, borderBottom: '1px solid #e5e7eb', flexShrink: 0,
        background: '#fff',
      }}>
        <h1 style={{ margin: 0, fontSize: 18 }}>🚖 Taxi Live-Tracker</h1>
        <span style={{ fontSize: 13, color: '#555' }}>
          <strong>Status:</strong>{' '}
          <span style={{ color: isConnected ? '#16a34a' : '#dc2626' }}>{status}</span>
        </span>
        <span style={{ fontSize: 13, color: '#555' }}>
          <strong>Active:</strong> {visibleTaxis.length}
        </span>
        <span style={{ fontSize: 13, color: '#555' }}>
          <strong>Total distance travelled:</strong> {totalDistanceAll != null ? `${totalDistanceAll.toFixed(1)} km` : 'N/A'}
        </span>

        <TaxiSearchBox onSelect={selectTaxi} onClear={clearSelection} selectedTaxiId={selectedTaxiId} />

        {selectedTaxiId !== null && (
          <span style={{
            fontSize: 12,
            background: '#EFF6FF',
            color: '#1D4ED8',
            padding: '2px 8px',
            borderRadius: 4,
            fontWeight: 500
          }}>
            focused taxi: {selectedTaxiId}
          </span>
        )}
        {speedingIncidents.length > 0 && (
          <button
            onClick={() => toggleViolationFilter('speeding')}
            style={{
              fontSize: 12, fontWeight: 500, borderRadius: 4, cursor: 'pointer',
              border: '1px solid #1F9D55', padding: '2px 8px',
              background: activeFilters.speeding ? '#993C1D' : '#FAECE7',
              color: activeFilters.speeding ? '#fff' : '#993C1D',
            }}
          >
            ⚠️ {speedingIncidents.length} speeding
          </button>
        )}
        {areaViolations.length > 0 && (
          <button
            onClick={() => toggleViolationFilter('area')}
            style={{
              fontSize: 12, fontWeight: 500, borderRadius: 4, cursor: 'pointer',
              border: '1px solid #1F9D55', padding: '2px 8px',
              background: activeFilters.area ? '#1F7A43' : '#E6F6ED',
              color: activeFilters.area ? '#fff' : '#1F7A43',
            }}
          >
            🗺️ {areaViolations.length} area violations
          </button>
        )}
        <span style={{ fontSize: 13, color: '#555' }}>
          <strong>Latency:</strong> {latency !== null ? `${latency.toFixed(2)}s` : 'N/A'}
          {latencyTrend === 'up' && <span style={{ color: '#dc2626', marginLeft: 4 }}>↑</span>}
          {latencyTrend === 'down' && <span style={{ color: '#16a34a', marginLeft: 4 }}>↓</span>}
        </span>
        {pathError && (
          <span style={{ fontSize: 12, background: '#FAECE7', color: '#993C1D', padding: '2px 8px', borderRadius: 4 }}>
            {pathError}
          </span>
        )}

      </header>

      {/* Main content */}
      <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>
        {/* Map */}
        <div style={{ flex: 1, overflow: 'hidden' }}>
          <MapContainer
            center={[39.9042, 116.4074]}
            zoom={12}
            style={{ height: '100%', width: '100%' }}
          >
            <RecenterMap selectedTaxi={selectedTaxiId === null ? null : taxiMap[selectedTaxiId]} />
            <TileLayer
              attribution='&copy; <a href="https://openstreetmap.org">OpenStreetMap</a> contributors'
              url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
            />
            <MarkerClusterGroup
              chunkedLoading
              iconCreateFunction={createClusterIcon}
              maxClusterRadius={60}
              spiderfyOnMaxZoom={true}
              disableClusteringAtZoom={16}
              showCoverageOnHover={false}
            >

              {selectedTaxiId !== null && pathPositions.length > 1 && (
                <Polyline
                  key={`poly-${selectedTaxiId}`}
                  positions={pathPositions}
                  pathOptions={{ color: '#1D4ED8', weight: 3, opacity: 0.7 }}
                />
              )}

              {selectedTaxiId !== null && normalizedPathLocations.map((p, idx) => (
                <CircleMarker
                  key={`path-${selectedTaxiId}-${idx}`}
                  center={[p.latitude, p.longitude]}
                  radius={4}
                  pathOptions={{ color: '#1D4ED8', fillColor: '#1D4ED8', fillOpacity: 0.6 }}
                >
                  <Popup>{p.timestamp}</Popup>
                </CircleMarker>
              ))}


              {taxis.map((taxi) => {
                const isSpeeding = taxi.isSpeeding;
                const isOutOfArea = violatingTaxiIds.has(String(taxi.taxi_id));

                let icon;
                if (selectedTaxiId !== null && String(taxi.taxi_id) === String(selectedTaxiId)) {
                  icon = selectedIcon;
                } else if (isSpeeding) {
                  icon = speedingIcon;
                } else if (isOutOfArea) {
                  icon = ooaIcon;
                } else if (taxi.isParking) {
                  icon = parkingIcon;
                } else {
                  icon = defaultIcon;
                }

                return (
                  <Marker
                    key={taxi.taxi_id}
                    position={[taxi.latitude, taxi.longitude]}
                    opacity={taxi._opacity}
                    icon={icon}
                    eventHandlers={{ click: () => selectTaxi(taxi.taxi_id) }}
                  >
                    <Popup>
                      <TaxiPopup taxi={taxi} isSpeeding={isSpeeding} isOutOfArea={isOutOfArea} />
                    </Popup>
                  </Marker>
                );
              })}
            </MarkerClusterGroup>
          </MapContainer>
        </div>

        {/* Debug panel */}
        <DebugAlerts
          entries={debugEntries}
          counts={debugCounts}
          filters={debugFilters}
          onToggleFilter={toggleFilter}
          onClear={clearDebug}
          selectedTaxiId={selectedTaxiId}
          onSelectTaxi={selectTaxiFromAlert}
          activeFilters={activeFilters}
          speedingIncidents={speedingIncidents}
          areaViolations={areaViolations}
        />
      </div>
    </div>
  );
}

export default App;
