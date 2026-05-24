package com.taxifleet.helper;

import redis.clients.jedis.Jedis;
import redis.clients.jedis.JedisPool;
import redis.clients.jedis.JedisPoolConfig;
import java.io.Serializable;

public class RedisSink implements Serializable {
    private static final long serialVersionUID = 1L;
    private transient JedisPool jedisPool; // Mark as transient to exclude from serialization
    private final String host;
    private final int port;

    public RedisSink(String host, int port) {
        this.host = host;
        this.port = port;
    }

    // Lazy initialization of JedisPool (not serialized)
    private JedisPool getJedisPool() {
        if (jedisPool == null) {
            JedisPoolConfig poolConfig = new JedisPoolConfig();
            poolConfig.setMaxTotal(10);
            poolConfig.setMaxIdle(5);
            poolConfig.setMinIdle(1);
            poolConfig.setTestOnBorrow(true);
            poolConfig.setBlockWhenExhausted(true);
            poolConfig.setMaxWaitMillis(5000);
            this.jedisPool = new JedisPool(poolConfig, host, port);
        }
        return jedisPool;
    }

    public void storeTaxiSpeed(com.taxifleet.models.TaxiSpeed speed) {
        try (Jedis jedis = getJedisPool().getResource()) {
            String taxiKey = "taxi:speed:" + speed.taxiId;
            jedis.hset(taxiKey, "speed", String.valueOf(speed.speed));
            jedis.hset(taxiKey, "distance", String.valueOf(speed.totalDistance));
            jedis.hset(taxiKey, "timestamp", String.valueOf(speed.timestamp));
            jedis.hset(taxiKey, "latitude", String.valueOf(speed.latitude));
            jedis.hset(taxiKey, "longitude", String.valueOf(speed.longitude));
            jedis.hset(taxiKey, "isSpeeding", String.valueOf(speed.isSpeeding));
            jedis.hset(taxiKey, "isOutOfArea", String.valueOf(speed.isOutOfArea));

            // Emit an alert event when a taxi is outside the operating area so the
            // dashboard backend can pick it up without scanning every taxi hash.
            if (speed.isOutOfArea) {
                String alert = String.format(
                    "{\"taxi_id\":%d,\"timestamp\":\"%s\",\"latitude\":%s,\"longitude\":%s,\"type\":\"out_of_area\"}",
                    speed.taxiId,
                    speed.timestamp,
                    String.valueOf(speed.latitude),
                    String.valueOf(speed.longitude)
                );
                jedis.lpush("alerts:out-of-area", alert);
                jedis.ltrim("alerts:out-of-area", 0, 199); // keep last 200 alerts
            }
        } catch (Exception e) {
            System.err.println("Failed to store data in Redis: " + e.getMessage());
            e.printStackTrace();
        }
    }
}