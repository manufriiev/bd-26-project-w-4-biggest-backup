import { useMemo, useState } from "react";
import "./App.css";
import "leaflet/dist/leaflet.css";

import { WS_LINK } from "./config.js";
import { useDebugLog } from "./hooks/UseDebugLog.js";
import { useNow } from "./hooks/UseNow";
import { useTaxiPath } from "./hooks/UseTaxiPath";
import { useTaxiSocket } from "./hooks/UseTaxiSocket";

import { MapView } from "./components/MapView.jsx";
import { TaxiSearchBox } from "./components/TaxiSearchBox.jsx";
import { DebugAlerts } from "./components/DebugAlerts.jsx";

import { getOpacity, normalizeAlarmTaxi } from "./utils/helper.js";

const LATENCY_TREND_STYLES = {
  up: { background: "#FAECE7", color: "#993C1D", border: "#F3B5A1", arrow: "↑" },
  down: { background: "#E6F6ED", color: "#1F7A43", border: "#8FD5AE", arrow: "↓" },
  stable: { background: "#F3F4F6", color: "#555", border: "#D1D5DB", arrow: "→" },
};

function App() {
  const now = useNow();
  const debugLog = useDebugLog();
  const [selectedTaxiId, setSelectedTaxiId] = useState(null);
  const { pathLocations, pathError, appendLiveUpdate } =
    useTaxiPath(selectedTaxiId);

  // Wire socket events -> debug log + path trail. useTaxiSocket only owns
  // its own state; side effects like these are handled by the callbacks.
  const {
    taxiMap,
    lastSeen,
    speedingIncidents,
    areaViolations,
    status,
    latency,
    latencyTrend,
    heatmapCells,
    totalDistanceAll,
  } = useTaxiSocket(WS_LINK, {
    onSnapshot: () => {
      // Position updates are no longer logged to the alerts panel; only
      // speeding and area violations appear there.
    },
    onTaxiUpdate: (t) => {
      // Handle speeding state transitions
      if (t.speedingStateChanged) {
        if (t.isSpeeding) {
          debugLog.addEntry(
            "speeding",
            `⚡ ${t.taxi_id} STARTED speeding at ${t.speed?.toFixed(1)} km/h`,
            t.taxi_id,
          );
        } else {
          debugLog.addEntry(
            "speeding",
            `✅ ${t.taxi_id} STOPPED speeding`,
            t.taxi_id,
          );
        }
      }

      appendLiveUpdate(t);
    },
    onAreaViolation: () => {},
    onOoaNotification: ({ trigger, taxiId }) => {
      const label = trigger === "entered" ? "🚨 left area" : "✅ returned";
      debugLog.addEntry("area", `taxi ${taxiId} — ${label}`, taxiId);
    },
  });

  // filtering
  const [activeFilters, setActiveFilters] = useState({
    speeding: false,
    area: false,
  });

  function toggleViolationFilter(type) {
    setActiveFilters((prev) => ({ ...prev, [type]: !prev[type] }));
  }

  function selectTaxiFromAlert(taxi_id) {
    setSelectedTaxiId((prev) =>
      String(prev) === String(taxi_id) ? null : taxi_id,
    );
  }

  // Used both by the search box and by clicking a marker/alert.
  function selectTaxi(taxi_id) {
    setSelectedTaxiId(taxi_id);
  }

  function clearSelection() {
    setSelectedTaxiId(null);
  }

  const allTaxis = Object.values(taxiMap);

  const violatingTaxiIds = useMemo(
    () => new Set(areaViolations.map((v) => String(v.taxi_id))),
    [areaViolations],
  );

  const visibleTaxis = useMemo(
    () =>
      allTaxis
        .map((t) => ({ ...t, _opacity: getOpacity(lastSeen[t.taxi_id], now) }))
        .filter((t) => t._opacity > 0)
        .filter((t) => !violatingTaxiIds.has(String(t.taxi_id))),
      [allTaxis, lastSeen, now, violatingTaxiIds],
  );

  const hasActiveFilter = activeFilters.speeding || activeFilters.area;

  const filteredByViolation = useMemo(() => {
    if (!hasActiveFilter) return visibleTaxis;
    const violatorMap = {};
    if (activeFilters.speeding) {
      speedingIncidents.forEach((i) => {
        violatorMap[i.taxi_id] = {
          ...taxiMap[i.taxi_id],
          ...normalizeAlarmTaxi(i),
        };
      });
    }
    if (activeFilters.area) {
      areaViolations.forEach((v) => {
        violatorMap[v.taxi_id] = {
          ...violatorMap[v.taxi_id],
          ...normalizeAlarmTaxi(v),
        };
      });
    }
    return Object.values(violatorMap);
  }, [
    hasActiveFilter,
    activeFilters,
    visibleTaxis,
    speedingIncidents,
    areaViolations,
    taxiMap
  ]);

  const taxis = useMemo(
    () =>
      selectedTaxiId === null
        ? filteredByViolation
        : filteredByViolation.filter(
            (t) => String(t.taxi_id) === String(selectedTaxiId),
          ),
    [selectedTaxiId, filteredByViolation],
  );

  const isConnected = status.includes("active") || status.includes("aktiv");

  const pathPositions = useMemo(
    () =>
      pathLocations
        .map((p) => [Number(p.latitude), Number(p.longitude)])
        .filter(([lat, lng]) => Number.isFinite(lat) && Number.isFinite(lng)),
    [pathLocations],
  );

  const latencyStyle = LATENCY_TREND_STYLES[latencyTrend] ?? LATENCY_TREND_STYLES.stable;

  return (
    <div
      style={{
        padding: 0,
        fontFamily: "sans-serif",
        height: "100vh",
        display: "flex",
        flexDirection: "column",
      }}
    >
      {/* Header */}
      <header
        style={{
          padding: "10px 16px",
          display: "flex",
          alignItems: "center",
          gap: 12,
          borderBottom: "1px solid #e5e7eb",
          flexShrink: 0,
          background: "#fff",
        }}
      >
        <h1 style={{ margin: 0, fontSize: 18 }}>🚖 Taxi Live-Tracker</h1>
        <span style={{ fontSize: 13, color: "#555" }}>
          <strong>Status:</strong>{" "}
          <span style={{ color: isConnected ? "#16a34a" : "#dc2626" }}>
            {status}
          </span>
        </span>
        <span style={{ fontSize: 13, color: "#555" }}>
          <strong>Active:</strong> {visibleTaxis.length}
        </span>
        <span style={{ fontSize: 13, color: "#555" }}>
          <strong>Total distance travelled:</strong>{" "}
          {totalDistanceAll != null
            ? `${totalDistanceAll.toFixed(1)} km`
            : "N/A"}
        </span>

        <TaxiSearchBox
          onSelect={selectTaxi}
          onClear={clearSelection}
          selectedTaxiId={selectedTaxiId}
        />

        {selectedTaxiId !== null && (
          <span
            style={{
              fontSize: 12,
              background: "#EFF6FF",
              color: "#1D4ED8",
              padding: "2px 8px",
              borderRadius: 4,
              fontWeight: 500,
            }}
          >
            focused taxi: {selectedTaxiId}
          </span>
        )}
        {speedingIncidents.length > 0 && (
          <button
            onClick={() => toggleViolationFilter("speeding")}
            style={{
              fontSize: 12,
              fontWeight: 500,
              borderRadius: 4,
              cursor: "pointer",
              border: "1px solid #1F9D55",
              padding: "2px 8px",
              background: activeFilters.speeding ? "#993C1D" : "#FAECE7",
              color: activeFilters.speeding ? "#fff" : "#993C1D",
            }}
          >
            ⚠️ {speedingIncidents.length} speeding
          </button>
        )}
        {areaViolations.length > 0 && (
          <button
            onClick={() => toggleViolationFilter("area")}
            style={{
              fontSize: 12,
              fontWeight: 500,
              borderRadius: 4,
              cursor: "pointer",
              border: "1px solid #1F9D55",
              padding: "2px 8px",
              background: activeFilters.area ? "#1F7A43" : "#E6F6ED",
              color: activeFilters.area ? "#fff" : "#1F7A43",
            }}
          >
            🗺️ {areaViolations.length} area violations
          </button>
        )}
        <span
          style={{
            fontSize: 13,
            fontWeight: 500,
            borderRadius: 4,
            padding: "2px 8px",
            display: "inline-flex",
            alignItems: "center",
            gap: 4,
            border: `1px solid ${latencyStyle.border}`,
            background: latencyStyle.background,
            color: latencyStyle.color,
          }}
        >
          <strong>Latency:</strong>
          {latency !== null ? `${latency.toFixed(2)}s` : "N/A"}
          {latencyTrend && <span style={{ fontWeight: 700 }}>{latencyStyle.arrow}</span>}
        </span>
        {pathError && (
          <span
            style={{
              fontSize: 12,
              background: "#FAECE7",
              color: "#993C1D",
              padding: "2px 8px",
              borderRadius: 4,
            }}
          >
            {pathError}
          </span>
        )}
      </header>

      {/* Main content */}
      <div style={{ flex: 1, display: "flex", overflow: "hidden" }}>
        {/* Map */}
        <div style={{ flex: 1, overflow: "hidden" }}>
          <MapView
            taxiMap={taxiMap}
            taxis={taxis}
            selectedTaxiId={selectedTaxiId}
            violatingTaxiIds={violatingTaxiIds}
            pathPositions={pathPositions}
            onSelectTaxi={selectTaxi}
            heatmapCells={heatmapCells}
          />
        </div>

        {/* Debug panel */}
        <DebugAlerts
          entries={debugLog.entries}
          counts={debugLog.counts}
          filters={debugLog.filters}
          onToggleFilter={debugLog.toggleFilter}
          onClear={debugLog.clear}
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
