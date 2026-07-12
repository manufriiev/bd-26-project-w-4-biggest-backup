import { useEffect, useRef, useState } from "react";
import { TAXI_UPDATE_FLUSH_INTERVAL_MS, WS_LINK } from "../config";

/**
 * Owns the WebSocket connection and all state driven by it: taxi positions,
 * last-seen timestamps (for fade-out), speeding/area incidents, connection
 * status, and latency stats.
 *
 * Side-effecting concerns that other hooks care about (debug logging, path
 * trails) are NOT handled here — instead this hook accepts optional
 * callbacks (`onSnapshot`, `onTaxiUpdate`, `onSpeedingAlert`,
 * `onAreaViolation`, `onOoaNotification`) that fire on each relevant
 * message, so callers can wire it up to `useDebugLog` / `useTaxiPath`
 * themselves.
 *
 * @param {string} wsUrl
 * @param {object} callbacks
 * @param {(data: object) => void} [callbacks.onSnapshot]
 * @param {(taxi: object) => void} [callbacks.onTaxiUpdate]
 * @param {(incidents: object[]) => void} [callbacks.onSpeedingAlert]
 * @param {(violations: object[]) => void} [callbacks.onAreaViolation]
 * @param {(data: object) => void} [callbacks.onOoaNotification]
 */
export function useTaxiSocket(wsUrl = WS_LINK, callbacks = {}) {
  // Keep latest callbacks without re-opening the socket when they change
  // identity on every render.
  const callbacksRef = useRef(callbacks);
  useEffect(() => {
    callbacksRef.current = callbacks;
  });

  const [taxiMap, setTaxiMap] = useState({});
  const [lastSeen, setLastSeen] = useState({});
  const [speedingIncidents, setSpeedingIncidents] = useState([]);
  const [areaViolations, setAreaViolations] = useState([]);
  const [status, setStatus] = useState("Connecting...");

  const [latency, setLatency] = useState(null);
  // Rolling window of recent latency samples, used only to derive latencyTrend below.
  const [, setLatencyHistory] = useState([]);
  const [latencyTrend, setLatencyTrend] = useState(null);
  const [heatmapCells, setHeatmapCells] = useState({});
  const [totalDistanceAll, setTotalDistanceAll] = useState(null);

  // taxiUpdate messages are queued here and applied in one batch on the
  // interval below, instead of triggering a re-render per message.
  const pendingUpdates = useRef({});

  useEffect(() => {
    const flush = setInterval(() => {
      const updates = pendingUpdates.current;
      if (Object.keys(updates).length === 0) return;
      pendingUpdates.current = {};
      const updateTime = Date.now();
      setTaxiMap((prev) => ({ ...prev, ...updates }));
      setLastSeen((prev) => {
        const next = { ...prev };
        Object.keys(updates).forEach((id) => {
          next[id] = updateTime;
        });
        return next;
      });
    }, TAXI_UPDATE_FLUSH_INTERVAL_MS);
    return () => clearInterval(flush);
  }, []);

  useEffect(() => {
    const socket = new WebSocket(wsUrl);

    socket.onopen = () => setStatus("Connected – Live-Stream active");

    socket.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        const cb = callbacksRef.current;

        if (data.type === "snapshot") {
          const map = {};
          const seen = {};
          const receivedAt = Date.now();
          (data.taxis || []).forEach((t) => {
            map[t.taxi_id] = t;
            seen[t.taxi_id] = receivedAt;
          });
          setTaxiMap(map);
          setLastSeen(seen);
          setSpeedingIncidents(data.speedingIncidents || []);
          setAreaViolations(data.areaViolations || []);
          setTotalDistanceAll(data.stats?.totalDistanceAll ?? null);
          cb.onSnapshot?.(data);
          setHeatmapCells(data.heatmapCells || {});

          if (data.stats && data.stats.avgLatencyMs) {
            const initialLatency = data.stats.avgLatencyMs / 1000;
            setLatency(initialLatency);
            setLatencyHistory([initialLatency]);
          }
        } else if (data.type === "taxiUpdate") {
          const t = data.taxi;
          pendingUpdates.current[t.taxi_id] = t; // queued for the batched flush above
          cb.onTaxiUpdate?.(t);

        } else if (data.type === "latencyStats") {
          const newLatency = data.stats.avgLatencyMs / 1000; // ms -> s
          setLatency(newLatency);

          setLatencyHistory((prev) => {
            const newHistory = [...prev, newLatency].slice(-5);
            if (newHistory.length >= 2) {
              const previous = newHistory[newHistory.length - 2];
              const delta = newLatency - previous;
              const DELTA_THRESHOLD = 0.01;
              setLatencyTrend(
                Math.abs(delta) < DELTA_THRESHOLD
                  ? "stable"
                  : newLatency > previous
                    ? "up"
                    : newLatency < previous
                      ? "down"
                      : null,
              );
            }
            return newHistory;
          });

        } else if (data.type === "speedingAlert") {
          const incidents = data.speedingIncidents || [];
          setSpeedingIncidents(incidents);
          cb.onSpeedingAlert?.(incidents);

        } else if (data.type === "areaViolation") {
          const violations = data.areaViolations || [];
          setAreaViolations(violations);
          cb.onAreaViolation?.(violations);

        } else if (data.type === "heatmapUpdate") {
          const cells = data.cellData;
          setHeatmapCells(cells);

        } else if (data.type === "totalDistanceUpdate") {
          setTotalDistanceAll(data.totalDistanceAll);

        } else if (data.type === "ooaNotification") {
          cb.onOoaNotification?.(data);
        }
      } catch (error) {
        console.error("Error parsing WebSocket data:", error);
      }
    };

    socket.onclose = () => setStatus("Lost connection to backend");

    return () => socket.close();
  }, [wsUrl]);

  return {
    taxiMap,
    lastSeen,
    speedingIncidents,
    areaViolations,
    status,
    latency,
    latencyTrend,
    heatmapCells,
    totalDistanceAll,
  };
}
