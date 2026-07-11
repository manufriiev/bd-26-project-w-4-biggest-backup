const express = require("express");
const { WebSocketServer } = require("ws");
const cors = require("cors");
const Redis = require("ioredis");
const { Kafka } = require("kafkajs");
const TAXI_API_URL = process.env.TAXI_API_URL || "http://taxi-api:8000";

const app = express();
app.use(cors());

const redis = new Redis({ host: "redis", port: 6379 });
const server = app.listen(5001, () =>
  console.log("Backend running on port 5001"),
);
const wss = new WebSocketServer({ server });

const kafka = new Kafka({ brokers: ["kafka:9092"] });

let speedingIncidents = [];
let areaViolations = [];
const areaViolationIndex = new Set();
// taxi_Id -> violation

// this is just for performance testing (dillutes this file a little bit but works)
const ACTIVE_WINDOW_MS = 10000; // a taxi counts as "active" if seen in the last 10s
const lastSeen = new Map(); // taxi_id -> timestamp

function markActive(taxiId, ts) {
  lastSeen.set(taxiId, ts);
}

function activeTaxiCount(now = Date.now()) {
  for (const [id, ts] of lastSeen) {
    if (now - ts > ACTIVE_WINDOW_MS) lastSeen.delete(id);
  }
  return lastSeen.size;
}

// ---- CSV logging (one row per stats interval, not per event) ----
const fs = require("fs");
const path = require("path");

const LOAD_LEVEL = process.env.LOAD_LEVEL || null;
const LOGGING_ENABLED = LOAD_LEVEL !== null;
const RUN_ID = process.env.RUN_ID || new Date().toISOString().replace(/[:.]/g, "-");

const csvPath = path.join(__dirname, "logs", `latency_avg_${RUN_ID}.csv`);

if (LOGGING_ENABLED) {
  fs.mkdirSync(path.dirname(csvPath), { recursive: true });
  fs.writeFileSync(
    csvPath,
    "timestamp_ms,avg_latency_ms,p95_latency_ms,active_taxi_count,sample_count,load_level\n"
  );
}

function appendStatsRow(row) {
  if (!LOGGING_ENABLED) return;
  fs.appendFile(csvPath, row, (err) => {
    if (err) console.error("[CSV] write failed:", err);
  });
}

process.on("SIGINT", () => process.exit(0));

// Rolling window of recent end-to-end latencies (ms) for the dashboard health panel.
const recentLatencies = [];
const LATENCY_WINDOW = 500;

function recordLatency(ms, taxiId, ts = Date.now()) {
  if (!Number.isFinite(ms) || ms < 0) return;
  recentLatencies.push(ms);
  if (recentLatencies.length > LATENCY_WINDOW) recentLatencies.shift();
  markActive(taxiId, ts);
}

function latencyStats() {
  if (recentLatencies.length === 0)
    return { avgLatencyMs: null, p95LatencyMs: null };
  const sum = recentLatencies.reduce((a, b) => a + b, 0);
  const avg = Math.round(sum / recentLatencies.length);
  const sorted = [...recentLatencies].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95));
  return { avgLatencyMs: avg, p95LatencyMs: sorted[idx] };
}

// Broadcast aggregated latency to all clients every 5s, and log it to CSV.
setInterval(() => {
  const stats = latencyStats();
  if (stats.avgLatencyMs !== null) {
    broadcast({ type: "latencyStats", stats });
    console.log(
      `[Latency] avg ${stats.avgLatencyMs}ms p95 ${stats.p95LatencyMs}ms (n=${recentLatencies.length})`,
    );

    const now = Date.now();
    appendStatsRow(
      `${now},${stats.avgLatencyMs},${stats.p95LatencyMs},${activeTaxiCount(now)},${recentLatencies.length},${LOAD_LEVEL}\n`
    );
  }
}, 5000);
// DEBUG ENDPOINT - remove before production
app.get("/debug", async (req, res) => {
  const keys = await redis.keys("taxi:speed:*");
  const result = {};
  for (const key of keys) {
    result[key] = await redis.hgetall(key);
  }
  res.json(result);
});
// Wrapper for taxi-api
app.get("/taxis/:id/locations", async (req, res) => {
  const { id } = req.params;

  const timeInterval = Number(req.query.time_interval) || 15;
  const number = Number(req.query.number) || 10;

  try {
    const upstream = await fetch(
      `${TAXI_API_URL}/taxis/${encodeURIComponent(id)}/times?time_interval=${encodeURIComponent(timeInterval)}&number=${encodeURIComponent(number)}`,
    );

    const body = await upstream.json().catch(() => null);

    if (!upstream.ok) {
      return res.status(upstream.status).json(
        body || {
          error: "taxi-api error",
        },
      );
    }

    res.json(body);
  } catch (err) {
    console.error("Error calling taxi-api:", err);
    res.status(502).json({
      error: "taxi-api unreachable",
    });
  }
});

function broadcast(payload) {
  const msg = JSON.stringify(payload);
  wss.clients.forEach((client) => {
    if (client.readyState === 1) client.send(msg);
  });
}

// Read full state from Redis — only called when a new client connects
//TODO: add a redis for taxi-heatmap and taxi-area-violations so we can send a snapshot of those too also figure out better parameter for the heatmap component ocpancy also make it togabl.
async function buildSnapshot() {
  const keys = await redis.keys("taxi:speed:*");
  const taxis = [];
  const totalDistanceAll = parseFloat(await redis.get("stats:total_distance")) || 0;
  for (const key of keys) {
    const data = await redis.hgetall(key);
    if (data && data.latitude && data.longitude) {
      taxis.push({
        taxi_id: key.split(":")[2],
        latitude: parseFloat(data.latitude),
        longitude: parseFloat(data.longitude),
        speed: parseFloat(data.speed),
        distance: parseFloat(data.distance),
        timestamp: data.timestamp,
        isSpeeding: data.isSpeeding === "true",
        averageSpeed: parseFloat(data.averageSpeed),
        totalDistance: parseFloat(data.totalDistance),
        lastMoved:
          data.lastMoved && data.lastMoved !== "null" ? data.lastMoved : "",
        isParking: data.isParking === "true",
      });
    }
  }
  return { taxis, totalDistanceAll };
}

// New client connects — send full snapshot from Redis so map is not empty
wss.on("connection", async (ws) => {
  const { taxis, totalDistanceAll } = await buildSnapshot();
  ws.send(
    JSON.stringify({
      type: "snapshot",
      taxis,
      stats: {
        activeTaxiCount: taxis.length,
        totalDistanceAll,
        ...latencyStats(),
      },
      speedingIncidents,
      areaViolations,
    }),
  );
});

// Start Kafka consumers for taxi-processed, taxi-speeding, and taxi-area-violations topics
// TODO why not use redice for taxi data?? isnt is double work to have both kafka and redis?
async function startConsumers() {
  // Consumer for taxi-processed — broadcast single taxi update, no Redis scan
  const processedConsumer = kafka.consumer({ groupId: "backend-processed" });
  await processedConsumer.connect();
  await processedConsumer.subscribe({
    topic: "taxi-processed",
    fromBeginning: false,
  });
  await processedConsumer.run({
    eachMessage: async ({ message }) => {
      const event = JSON.parse(message.value.toString());
      // End-to-end latency: now minus the provider ingestion timestamp.
      if (event.ingested_at) {
          const now = Date.now();
          const latencyMs = now - event.ingested_at;
          recordLatency(latencyMs, String(event.taxi_id), now);
        }
      broadcast({
        type: "taxiUpdate",
        taxi: {
          taxi_id: String(event.taxi_id),
          latitude: event.latitude,
          longitude: event.longitude,
          speed: event.speed,
          distance: event.totalDistance,
          timestamp: event.timestamp,
          isSpeeding: event.isSpeeding,
          averageSpeed: event.averageSpeed,
          totalDistance: event.totalDistance,
          speedingStateChanged: event.speedingStateChanged,
          lastMoved: event.lastMoved ?? "",
          isParking: event.isParking ?? false,
        },
      });
    },
  });

  // Consumer for taxi-speeding — immediate alert broadcast
  const speedingConsumer = kafka.consumer({ groupId: "backend-speeding" });
  await speedingConsumer.connect();
  await speedingConsumer.subscribe({
    topic: "taxi-speeding",
    fromBeginning: false,
  });
  await speedingConsumer.run({
    eachMessage: async ({ message }) => {
      speedingIncidents = JSON.parse(message.value.toString());
      broadcast({ type: "speedingAlert", speedingIncidents });
    },
  });

  // Consumer for taxi-area-violations — immediate alert broadcast
  const violationsConsumer = kafka.consumer({ groupId: "backend-violations" });
  await violationsConsumer.connect();
  await violationsConsumer.subscribe({
    topic: "taxi-area-violations",
    fromBeginning: false,
  });
  violationsConsumer.run({
    eachMessage: async ({ message }) => {
      const newList = JSON.parse(message.value.toString());
      const newIds = new Set(newList.map(v => String(v.taxi_id)));

      // detect transitions by diffing
      for (const id of newIds) {
        if (!areaViolationIndex.has(id)) {
          broadcast({ type: 'ooaNotification', trigger: 'entered', taxiId: id });
        }
      }
      for (const id of areaViolationIndex) {
        if (!newIds.has(id)) {
          broadcast({ type: 'ooaNotification', trigger: 'returned', taxiId: id });
        }
      }

      areaViolations = newList;
      areaViolationIndex.clear();
      newIds.forEach(id => areaViolationIndex.add(id));

      broadcast({ type: 'areaViolation', areaViolations });
    }
  });
  const cellConsumer = kafka.consumer({ groupId: "backend-cell" });
  await cellConsumer.connect();
  await cellConsumer.subscribe({
    topic: "taxi-heatmap",
    fromBeginning: false,
  });
  await cellConsumer.run({
    eachMessage: async ({ message }) => {
      const cellData = JSON.parse(message.value.toString());
      broadcast({ type: "heatmapUpdate", cellData });
    },
  });
}

startConsumers().catch(console.error);
