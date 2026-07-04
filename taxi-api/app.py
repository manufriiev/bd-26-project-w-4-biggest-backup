import json
import logging
import os
import threading
from datetime import datetime
from contextlib import contextmanager

import psycopg2
import psycopg2.extras
import psycopg2.pool
from fastapi import FastAPI, HTTPException, Query
from kafka import KafkaConsumer

logging.basicConfig(level=logging.INFO)
log = logging.getLogger("taxi-api")

DATABASE_URL = os.environ["DATABASE_URL"]
KAFKA_BOOTSTRAP = os.environ.get("KAFKA_BOOTSTRAP", "kafka:9092")
KAFKA_TOPIC = os.environ.get("KAFKA_TOPIC", "taxi-processed")
KAFKA_GROUP_ID = os.environ.get("KAFKA_GROUP_ID", "taxi-api-consumer")

app = FastAPI(title="Taxi Fleet API")

# Connection pool: the consumer writes an event on every Kafka message and the
# API reads on every request. Opening a fresh psycopg2 connection each time is
# slow and leaks under load, so share a small pool instead.
_pool = psycopg2.pool.ThreadedConnectionPool(minconn=1, maxconn=10, dsn=DATABASE_URL)


@contextmanager
def get_conn():
    conn = _pool.getconn()
    try:
        yield conn
    finally:
        _pool.putconn(conn)


INSERT_SQL = """
INSERT INTO taxi_speed (
    taxi_id, event_timestamp, longitude, latitude, speed,
    average_speed, total_distance, is_speeding, is_out_of_area,
    last_moved, is_parking, ingested_at
) VALUES (
    %(taxiId)s, %(timestamp)s, %(longitude)s, %(latitude)s, %(speed)s,
    %(averageSpeed)s, %(totalDistance)s, %(isSpeeding)s, %(isOutOfArea)s,
    %(lastMoved)s, %(isParking)s, %(ingestedAt)s
)
"""


def store_event(record: dict) -> None:
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(INSERT_SQL, record)
        conn.commit()


def consume_loop() -> None:
    consumer = KafkaConsumer(
        KAFKA_TOPIC,
        bootstrap_servers=KAFKA_BOOTSTRAP,
        group_id=KAFKA_GROUP_ID,
        value_deserializer=lambda v: json.loads(v.decode("utf-8")),
        auto_offset_reset="earliest",
        enable_auto_commit=True,
    )
    log.info("Kafka-Consumer gestartet fuer Topic '%s'", KAFKA_TOPIC)
    for message in consumer:
        try:
            store_event(message.value)
        except Exception:
            log.exception("Konnte Event nicht speichern: %s", message.value)


@app.on_event("startup")
def start_consumer_thread() -> None:
    thread = threading.Thread(target=consume_loop, daemon=True)
    thread.start()

@app.get("/taxis/{taxi_id}/locations")
def get_last_locations(taxi_id: int, limit: int = Query(5, le=1000)):
    """Letzte `limit` Standorte eines Taxis, sortiert nach event_timestamp
    (neuester zuerst)."""
    sql = """
        SELECT taxi_id, event_timestamp, longitude, latitude, speed,
               average_speed, total_distance, is_speeding, is_out_of_area,
               is_parking
        FROM taxi_speed
        WHERE taxi_id = %s
        ORDER BY event_timestamp DESC
        LIMIT %s
    """
    with get_conn() as conn, conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
        cur.execute(sql, (taxi_id, limit))
        rows = cur.fetchall()
        if not rows:
            raise HTTPException(status_code=404, detail="Keine Standorte fuer dieses Taxi gefunden")
        return rows
    
@app.get("/taxis/{taxi_id}/times")
def get_last_location_timed(
    taxi_id: int,
    time_interval: int = Query(5, ge=1, le=1000),
    number: int = Query(20, ge=1, le=1000),
):
    """Return up to `number` evenly distributed samples from the last `time_interval` minutes."""

    sql = """
        SELECT taxi_id, event_timestamp, longitude, latitude, speed,
               average_speed, total_distance, is_speeding,
               is_out_of_area, is_parking
        FROM taxi_speed
        WHERE taxi_id = %s
          AND event_timestamp >= (
              SELECT MAX(event_timestamp) - (%s || ' minutes')::interval
              FROM taxi_speed
              WHERE taxi_id = %s
          )
        ORDER BY event_timestamp ASC
    """

    with get_conn() as conn, conn.cursor(
        cursor_factory=psycopg2.extras.RealDictCursor
    ) as cur:
        cur.execute(sql, (taxi_id, time_interval, taxi_id))
        rows = cur.fetchall()

    if not rows:
        raise HTTPException(
            status_code=404,
            detail="Keine Standorte fuer dieses Taxi gefunden",
        )

    if len(rows) <= number:
        return rows

    if number == 1:
        return [rows[-1]]

    last_index = len(rows) - 1

    # Evenly spaced indices including first and last
    indices = []
    for i in range(number):
        idx = round(i * last_index / (number - 1))
        if not indices or idx != indices[-1]:
            indices.append(idx)

    # Fill gaps if rounding produced duplicates
    current = 0
    while len(indices) < number:
        while current in indices:
            current += 1
        indices.append(current)

    indices.sort()

    return [rows[i] for i in indices]

@app.get("/health")
def health():
    return {"status": "ok"}


@app.get("/stats/summary")
def fleet_summary():
    """Fleet-wide totals for the dashboard: taxi count, total distance travelled,
    and how many taxis are currently speeding / out of area / parked. Distance is
    summed from each taxi's latest totalDistance so it is not double-counted."""
    sql = """
        WITH latest AS (
            SELECT DISTINCT ON (taxi_id) *
            FROM taxi_speed
            ORDER BY taxi_id, received_at DESC
        )
        SELECT
            COUNT(*)                                   AS taxi_count,
            COALESCE(SUM(total_distance), 0)           AS total_distance_km,
            COUNT(*) FILTER (WHERE is_speeding)        AS speeding_count,
            COUNT(*) FILTER (WHERE is_out_of_area)     AS out_of_area_count,
            COUNT(*) FILTER (WHERE is_parking)         AS parking_count
        FROM latest
    """
    with get_conn() as conn, conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
        cur.execute(sql)
        return cur.fetchone()


@app.get("/taxis")
def list_latest_positions():
    """Letzte bekannte Position pro Taxi."""
    sql = """
        SELECT DISTINCT ON (taxi_id) *
        FROM taxi_speed
        ORDER BY taxi_id, received_at DESC
    """
    with get_conn() as conn, conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
        cur.execute(sql)
        return cur.fetchall()


@app.get("/taxis/{taxi_id}")
def get_latest_position(taxi_id: int):
    sql = """
        SELECT * FROM taxi_speed
        WHERE taxi_id = %s
        ORDER BY received_at DESC
        LIMIT 1
    """
    with get_conn() as conn, conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
        cur.execute(sql, (taxi_id,))
        row = cur.fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Taxi nicht gefunden")
        return row


@app.get("/taxis/{taxi_id}/history")
def get_history(taxi_id: int, limit: int = Query(100, le=1000)):
    sql = """
        SELECT * FROM taxi_speed
        WHERE taxi_id = %s
        ORDER BY received_at DESC
        LIMIT %s
    """
    with get_conn() as conn, conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
        cur.execute(sql, (taxi_id, limit))
        return cur.fetchall()


@app.get("/taxis/speeding")
def list_speeding():
    sql = """
        SELECT DISTINCT ON (taxi_id) * FROM taxi_speed
        WHERE is_speeding
        ORDER BY taxi_id, received_at DESC
    """
    with get_conn() as conn, conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
        cur.execute(sql)
        return cur.fetchall()


@app.get("/taxis/out-of-area")
def list_out_of_area():
    sql = """
        SELECT DISTINCT ON (taxi_id) * FROM taxi_speed
        WHERE is_out_of_area
        ORDER BY taxi_id, received_at DESC
    """
    with get_conn() as conn, conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
        cur.execute(sql)
        return cur.fetchall()


@app.get("/stats/latency")
def latency_stats():
    """Durchschnittliche/max. End-to-End Pipeline-Latenz der letzten 5 Minuten,
    basierend auf dem ingestedAt-Feld aus TaxiSpeed."""
    sql = """
        SELECT
            AVG(EXTRACT(EPOCH FROM received_at) * 1000 - ingested_at) AS avg_latency_ms,
            MAX(EXTRACT(EPOCH FROM received_at) * 1000 - ingested_at) AS max_latency_ms,
            COUNT(*) AS sample_size
        FROM taxi_speed
        WHERE received_at > now() - interval '5 minutes'
    """
    with get_conn() as conn, conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
        cur.execute(sql)
        return cur.fetchone()