// TODO maybe make a deployment branch which can be rebased from main, wich changes this const
//change for deployment
const BACKEND = "http://35.193.16.110:5001";

const WS_LINK = "ws://35.193.16.110:5001";

// consts for path display number of points and time interval for path display
export const PATH_LOCATIONS_LIMIT = 30;
export const PATH_TIME_INTERVAL = 15; // in minutes

// Fading of stale markers
export const STALE_AFTER_MS = 30 * 1000;

// MAX Debug log entries
export const DEBUG_LOG_MAX_ENTRIES = 300;

// "now" ticker used for fade calculations
export const NOW_UPDATE_INTERVAL_MS = 5000;
// Batch flush interval for taxi position updates
export const TAXI_UPDATE_FLUSH_INTERVAL_MS = 3000;
