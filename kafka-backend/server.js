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

const snapshot = {
  taxis: [],
  stats: {
    activeTaxiCount: 0,
    totalDistanceAll: 0,
    avgLatencyMs: null,
    p95LatencyMs: null,
  },
  speedingIncidents: [],
  areaViolations: [],
  heatmapCells: {},
};

const taxiMap = new Map(); // taxi_id -> taxi

//update from redice once
// Load initial taxi state from Redis (called once during startup)
async function loadInitialSnapshot() {
  const keys = await redis.keys("taxi:speed:*");

  let totalDistanceAll = 0;

  for (const key of keys) {
    const data = await redis.hgetall(key);

    if (!data.latitude || !data.longitude) continue;

    const taxi = {
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
    };

    taxiMap.set(taxi.taxi_id, taxi);
    totalDistanceAll += taxi.totalDistance || 0;
  }

  snapshot.taxis = [...taxiMap.values()];
  snapshot.stats.activeTaxiCount = snapshot.taxis.length;
  snapshot.stats.totalDistanceAll = totalDistanceAll;
}

async function startConsumers() {
  // Taxi updates
  const processedConsumer = kafka.consumer({ groupId: "backend-processed" });
  await processedConsumer.connect();
  await processedConsumer.subscribe({
    topic: "taxi-processed",
    fromBeginning: false,
  });

  await processedConsumer.run({
    eachMessage: async ({ message }) => {
      const event = JSON.parse(message.value.toString());

      if (event.ingested_at) {
        recordLatency(Date.now() - event.ingested_at);
      }

      const taxi = {
        taxi_id: String(event.taxi_id),
        latitude: event.latitude,
        longitude: event.longitude,
        speed: event.speed,
        distance: event.distance,
        timestamp: event.timestamp,
        isSpeeding: event.isSpeeding,
        averageSpeed: event.averageSpeed,
        totalDistance: event.totalDistance,
        lastMoved: event.lastMoved ?? "",
        isParking: event.isParking ?? false,
      };

      taxiMap.set(taxi.taxi_id, taxi);

      snapshot.taxis = [...taxiMap.values()];
      snapshot.stats.activeTaxiCount = snapshot.taxis.length;
      snapshot.stats.totalDistanceAll = snapshot.taxis.reduce(
        (sum, taxi) => sum + (taxi.totalDistance || 0),
        0,
      );
    },
  });

  // Speeding incidents
  const speedingConsumer = kafka.consumer({ groupId: "backend-speeding" });
  await speedingConsumer.connect();
  await speedingConsumer.subscribe({
    topic: "taxi-speeding",
    fromBeginning: false,
  });

  await speedingConsumer.run({
    eachMessage: async ({ message }) => {
      snapshot.speedingIncidents = JSON.parse(message.value.toString());
    },
  });

  // Area violations
  const violationsConsumer = kafka.consumer({ groupId: "backend-violations" });
  await violationsConsumer.connect();
  await violationsConsumer.subscribe({
    topic: "taxi-area-violations",
    fromBeginning: false,
  });

  await violationsConsumer.run({
    eachMessage: async ({ message }) => {
      snapshot.areaViolations = JSON.parse(message.value.toString());
    },
  });

  // Heatmap cells
  const cellConsumer = kafka.consumer({ groupId: "backend-cell" });
  await cellConsumer.connect();
  await cellConsumer.subscribe({
    topic: "taxi-heatmap",
    fromBeginning: false,
  });

  await cellConsumer.run({
    eachMessage: async ({ message }) => {
      const cell = JSON.parse(message.value.toString());

      if (cell.cellId) {
        snapshot.heatmapCells[cell.cellId] = cell;
      }
    },
  });
}
startConsumers().catch(console.error);
// Rolling window of recent end-to-end latencies (ms).
const recentLatencies = [];
const LATENCY_WINDOW = 500;

function recordLatency(ms) {
  if (!Number.isFinite(ms) || ms < 0) return;

  recentLatencies.push(ms);

  if (recentLatencies.length > LATENCY_WINDOW) {
    recentLatencies.shift();
  }
}

function updateLatencyStats() {
  if (recentLatencies.length === 0) {
    snapshot.stats.avgLatencyMs = null;
    snapshot.stats.p95LatencyMs = null;
    return;
  }

  const sum = recentLatencies.reduce((a, b) => a + b, 0);
  const sorted = [...recentLatencies].sort((a, b) => a - b);

  snapshot.stats.avgLatencyMs = Math.round(sum / recentLatencies.length);
  snapshot.stats.p95LatencyMs = sorted[Math.floor(0.95 * (sorted.length - 1))];
}

function broadcast(payload) {
  const msg = JSON.stringify(payload);
  wss.clients.forEach((client) => {
    if (client.readyState === 1) client.send(msg);
  });
}

// Periodically update latency stats and broadcast snapshot to all clients
setInterval(() => {
  updateLatencyStats();

  broadcast({
    type: "snapshot",
    ...snapshot,
  });

  console.log(
    `[Snapshot] ${snapshot.stats.activeTaxiCount} taxis | avg latency ${snapshot.stats.avgLatencyMs} ms | p95 ${snapshot.stats.p95LatencyMs} ms`,
  );
}, 5000);

// Send the current in-memory snapshot to newly connected clients.
wss.on("connection", (ws) => {
  ws.send(
    JSON.stringify({
      type: "snapshot",
      ...snapshot,
    }),
  );
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

async function main() {
  await loadInitialSnapshot();
  console.log(
    `[Startup] Loaded ${snapshot.stats.activeTaxiCount} taxis from Redis`,
  );
  await startConsumers();
}

main().catch(console.error);
