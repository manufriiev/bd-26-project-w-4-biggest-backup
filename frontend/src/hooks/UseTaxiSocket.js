import { useEffect, useRef, useState } from "react";
import { WS_LINK } from "../config";

/**
 * Owns the WebSocket connection and all state driven by snapshots.
 *
 * The backend sends a complete snapshot every 5 seconds.
 * This hook replaces local state with the received snapshot.
 *
 * @param {string} wsUrl
 * @param {object} callbacks
 */
export function useTaxiSocket(wsUrl = WS_LINK, callbacks = {}) {
  const callbacksRef = useRef(callbacks);

  useEffect(() => {
    callbacksRef.current = callbacks;
  });

  const [taxiMap, setTaxiMap] = useState({});
  const [lastSeen, setLastSeen] = useState({});
  const [speedingIncidents, setSpeedingIncidents] = useState([]);
  const [areaViolations, setAreaViolations] = useState([]);
  const [heatmapCells, setHeatmapCells] = useState({});

  const [stats, setStats] = useState({
    activeTaxiCount: 0,
    totalDistanceAll: 0,
    avgLatencyMs: null,
    p95LatencyMs: null,
  });

  const [latencyHistory, setLatencyHistory] = useState([]);
  const [latencyTrend, setLatencyTrend] = useState(null);

  const [status, setStatus] = useState("Connecting...");

  useEffect(() => {
    const socket = new WebSocket(wsUrl);

    socket.onopen = () => {
      setStatus("Connected – Live-Stream active");
    };

    socket.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);

        if (data.type !== "snapshot") return;

        const receivedAt = Date.now();

        const map = {};
        const seen = {};

        (data.taxis || []).forEach((taxi) => {
          map[taxi.taxi_id] = taxi;
          seen[taxi.taxi_id] = receivedAt;
        });

        setTaxiMap(map);
        setLastSeen(seen);

        setSpeedingIncidents(data.speedingIncidents || []);
        setAreaViolations(data.areaViolations || []);
        setHeatmapCells(data.heatmapCells || {});

        if (data.stats) {
          setStats(data.stats);

          if (data.stats.avgLatencyMs !== null) {
            const latencySeconds = data.stats.avgLatencyMs / 1000;

            setLatencyHistory((prev) => {
              const next = [...prev, latencySeconds].slice(-5);

              if (next.length >= 2) {
                const oldValue = next[next.length - 2];

                setLatencyTrend(
                  latencySeconds > oldValue
                    ? "up"
                    : latencySeconds < oldValue
                      ? "down"
                      : null,
                );
              }

              return next;
            });
          }
        }

        callbacksRef.current.onSnapshot?.(data);
      } catch (error) {
        console.error("Error parsing WebSocket snapshot:", error);
      }
    };

    socket.onclose = () => {
      setStatus("Lost connection to backend");
    };

    return () => socket.close();
  }, [wsUrl]);

  return {
    taxiMap,
    lastSeen,
    speedingIncidents,
    areaViolations,
    heatmapCells,

    stats,
    latencyHistory,
    latencyTrend,

    status,
  };
}
