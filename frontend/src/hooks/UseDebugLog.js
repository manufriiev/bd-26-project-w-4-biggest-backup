import { useCallback, useState } from "react";
import { DEBUG_LOG_MAX_ENTRIES } from "../config";

/**
 * Owns the debug/alerts log: entries, per-type counts, and per-type
 * visibility filters. Pure UI-side bookkeeping, no socket knowledge.
 *
 * Only violation types are tracked (speeding, area). Plain position updates are
 * not logged — they were high-volume noise and have been removed.
 */
export function useDebugLog(maxEntries = DEBUG_LOG_MAX_ENTRIES) {
  const [entries, setEntries] = useState([]);
  const [counts, setCounts] = useState({ speeding: 0, area: 0 });
  const [filters, setFilters] = useState({
    speeding: true,
    area: true,
  });

  const addEntry = useCallback(
    (type, text, taxi_id = null) => {
      // Ignore any type we no longer track (e.g. taxiUpdate).
      if (!(type in { speeding: 0, area: 0 })) return;
      const now = new Date();
      const ts =
        now.toTimeString().slice(0, 8) +
        "." +
        String(now.getMilliseconds()).padStart(3, "0");
      setEntries((prev) =>
        [{ type, text, ts, taxi_id }, ...prev].slice(0, maxEntries),
      );
      setCounts((prev) => ({ ...prev, [type]: prev[type] + 1 }));
    },
    [maxEntries],
  );

  const toggleFilter = useCallback((type) => {
        setFilters((prev) => {
            const onlyThisActive = prev[type] && Object.values(prev).filter(Boolean).length === 1;
            if (onlyThisActive) {
                return Object.fromEntries(Object.keys(prev).map(k => [k, true]));
            }
            return Object.fromEntries(Object.keys(prev).map(k => [k, k === type]));
        });}, []);

  const clear = useCallback(() => {
    setEntries([]);
    setCounts({ speeding: 0, area: 0 });
  }, []);

  return { entries, counts, filters, addEntry, toggleFilter, clear };
}
