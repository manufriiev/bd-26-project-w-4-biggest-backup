package com.taxifleet.functions;

import com.taxifleet.helper.Helper;
import com.taxifleet.models.TaxiLocation;
import com.taxifleet.models.TaxiSpeed;
import org.apache.flink.api.common.state.ValueState;
import org.apache.flink.api.common.state.ValueStateDescriptor;
import org.apache.flink.configuration.Configuration;
import org.apache.flink.streaming.api.functions.KeyedProcessFunction;
import org.apache.flink.util.Collector;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

public class SpeedCalculatorProcessFunction
                extends KeyedProcessFunction<Integer, TaxiLocation, TaxiSpeed> {

        private static final Logger LOG = LoggerFactory.getLogger(SpeedCalculatorProcessFunction.class);

        private static final double SPEED_LIMIT = 50.0;
        private static final double MAX_SPEED = 150.0;
        private static final double MOVING_MIN = 0.5; // km/h threshold to count as moving
        private static final double PARKING_SEC = 300.0; // 5 min stationary = parked
        private static final int WARMUP = 6;
        private static final int MAX_SPIKES = 3;
        private static final double EMA_ALPHA = 0.2;
        private static final double SPIKE_FACTOR = 3.5;
        private static final double KALMAN_Q = 10.0; // process noise (how fast speed changes)
        private static final double KALMAN_R = 30.0; // measurement noise (GPS inaccuracy)

        // State
        private transient ValueState<TaxiLocation> prevLocation;
        private transient ValueState<Integer> warmupCount;
        private transient ValueState<Integer> spikeStreak;
        private transient ValueState<Double> totalDistKm;
        private transient ValueState<Double> emaSpeed;
        private transient ValueState<Integer> emaSamples;
        private transient ValueState<Double> kalmanX;
        private transient ValueState<Double> kalmanP;
        private transient ValueState<String> lastMoved;

        @Override
        public void open(Configuration parameters) {
                prevLocation = getRuntimeContext()
                                .getState(new ValueStateDescriptor<>("prev-location", TaxiLocation.class));
                warmupCount = getRuntimeContext().getState(new ValueStateDescriptor<>("warmup-count", Integer.class));
                spikeStreak = getRuntimeContext().getState(new ValueStateDescriptor<>("spike-streak", Integer.class));
                totalDistKm = getRuntimeContext().getState(new ValueStateDescriptor<>("total-dist-km", Double.class));
                emaSpeed = getRuntimeContext().getState(new ValueStateDescriptor<>("ema-speed", Double.class));
                emaSamples = getRuntimeContext().getState(new ValueStateDescriptor<>("ema-samples", Integer.class));
                kalmanX = getRuntimeContext().getState(new ValueStateDescriptor<>("kalman-x", Double.class));
                kalmanP = getRuntimeContext().getState(new ValueStateDescriptor<>("kalman-p", Double.class));
                lastMoved = getRuntimeContext().getState(new ValueStateDescriptor<>("last-moved", String.class));
        }

        // ── Helpers ───────────────────────────────────────────────────────────────

        private double rawSpeed(TaxiLocation prev, TaxiLocation curr, double timeSec) {
                return Helper.calculateDistance(prev.latitude, prev.longitude,
                                curr.latitude, curr.longitude) * 3600.0 / timeSec;
        }

        private double kalmanUpdate(double measurement) throws Exception {
                double x = kalmanX.value() == null ? measurement : kalmanX.value();
                double P = kalmanP.value() == null ? KALMAN_R : kalmanP.value();

                double P_pred = P + KALMAN_Q;
                double K = P_pred / (P_pred + KALMAN_R);
                double x_new = x + K * (measurement - x);
                double P_new = (1.0 - K) * P_pred;

                kalmanX.update(x_new);
                kalmanP.update(P_new);
                return x_new;
        }

        private double emaUpdate(double speed) throws Exception {
                int n = emaSamples.value() == null ? 0 : emaSamples.value();
                double avg = emaSpeed.value() == null ? speed : emaSpeed.value();
                double next = n == 0 ? speed : EMA_ALPHA * speed + (1.0 - EMA_ALPHA) * avg;
                emaSpeed.update(next);
                emaSamples.update(n + 1);
                return next;
        }

        private void resetState(TaxiLocation anchor) throws Exception {
                prevLocation.update(anchor);
                warmupCount.update(1);
                spikeStreak.update(0);
                kalmanX.update(null);
                kalmanP.update(null);
        }

        private TaxiSpeed buildResult(TaxiLocation loc, double speed, boolean isParking) throws Exception {
                double dist = totalDistKm.value() == null ? 0.0 : totalDistKm.value();
                double avg = emaSpeed.value() == null ? 0.0 : emaSpeed.value();
                TaxiSpeed r = new TaxiSpeed(loc.taxiId, loc.timestamp,
                                loc.longitude, loc.latitude,
                                speed, dist, avg);
                r.lastMoved = lastMoved.value();
                r.isParking = isParking;
                return r;
        }

        // ── Main ──────────────────────────────────────────────────────────────────

        @Override
        public void processElement(TaxiLocation curr, Context ctx, Collector<TaxiSpeed> out) throws Exception {

                TaxiLocation prev = prevLocation.value();

                // First event
                if (prev == null) {
                        lastMoved.update(curr.timestamp);
                        resetState(curr);
                        out.collect(buildResult(curr, 0.0, false));
                        return;
                }

                double timeSec = Helper.calculateTimeDifferenceSeconds(prev.timestamp, curr.timestamp);

                // Invalid or stale timestamp
                if (timeSec <= 0) {
                        LOG.warn("DROP_INVALID_TIME taxiId={}", curr.taxiId);
                        return;
                }
                if (timeSec > 300) {
                        LOG.warn("GAP_RESET taxiId={} gap={}s", curr.taxiId, timeSec);
                        resetState(curr);
                        out.collect(buildResult(curr, 0.0, false));
                        return;
                }

                double raw = rawSpeed(prev, curr, timeSec);

                // Warmup: feed Kalman but don't emit real speeds yet
                int wc = warmupCount.value() == null ? 0 : warmupCount.value();
                if (wc < WARMUP) {
                        if (raw <= MAX_SPEED) {
                                kalmanUpdate(raw);
                                emaUpdate(raw);
                                prevLocation.update(curr);
                                warmupCount.update(wc + 1);
                        }
                        out.collect(buildResult(curr, 0.0, false));
                        return;
                }

                // Spike detection (hard limit + dynamic factor)
                double curEma = emaSpeed.value() == null ? 0.0 : emaSpeed.value();
                double dynamicMax = Math.max(MAX_SPEED, curEma * SPIKE_FACTOR);

                if (raw > dynamicMax) {
                        int streak = (spikeStreak.value() == null ? 0 : spikeStreak.value()) + 1;
                        LOG.warn("SPIKE taxiId={} raw={} dynamicMax={} streak={}", curr.taxiId, raw, dynamicMax,
                                        streak);
                        if (streak >= MAX_SPIKES) {
                                LOG.warn("SPIKE_RESET taxiId={}", curr.taxiId);
                                resetState(curr);
                        } else {
                                spikeStreak.update(streak);
                        }
                        return;
                }

                spikeStreak.update(0);
                double smoothed = kalmanUpdate(raw);
                double avgSpeed = emaUpdate(smoothed);

                // Parking state
                boolean isParking;
                if (smoothed > MOVING_MIN) {
                        lastMoved.update(curr.timestamp);
                        isParking = false;
                } else {
                        double parkedSec = Helper.calculateTimeDifferenceSeconds(lastMoved.value(), curr.timestamp);
                        isParking = parkedSec > PARKING_SEC;
                }

                // Distance
                double legKm = Helper.calculateDistance(prev.latitude, prev.longitude,
                                curr.latitude, curr.longitude);
                totalDistKm.update((totalDistKm.value() == null ? 0.0 : totalDistKm.value()) + legKm);

                TaxiSpeed result = buildResult(curr, smoothed, isParking);
                if (smoothed > SPEED_LIMIT)
                        ctx.output(SpeedCalculatorProcess.SPEEDING_TAG, result);
                out.collect(result);

                prevLocation.update(curr);
        }
}