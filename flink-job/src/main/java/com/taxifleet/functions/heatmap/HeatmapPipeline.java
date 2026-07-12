package com.taxifleet.functions.heatmap;

import com.taxifleet.models.HeatmapCell;
import com.taxifleet.models.TaxiSpeed;
import org.apache.flink.streaming.api.datastream.DataStream;
import org.apache.flink.streaming.api.windowing.assigners.SlidingProcessingTimeWindows;

import java.time.Duration;

public class HeatmapPipeline {
    private static final Duration CHECK_INTERVAL = Duration.ofMinutes(2);
    private static final Duration WINDOW_SIZE = Duration.ofMinutes(10);

    public static DataStream<HeatmapCell> build(DataStream<TaxiSpeed> locationStream) {
        return locationStream
                // 1. Group by cell
                .keyBy(location -> GridUtil.cellFor(location.latitude, location.longitude))

                // 2. Sliding window to aggregate distinct taxi counts per cell
                .window(SlidingProcessingTimeWindows.of(WINDOW_SIZE, CHECK_INTERVAL))

                // 3. Zero-fill missing data for cells that have no activity in the current
                // window
                .aggregate(new DistinctTaxiCountAggregator(),
                        new HeatmapWindowProcessor())// 3. Nachgelagertes KeyedProcess, um Lücken mit Nullen aufzufüllen
                .keyBy(cell -> cell.cellId)
                .process(new ZeroFillProcessFunction(CHECK_INTERVAL, WINDOW_SIZE))
                .returns(HeatmapCell.class)
                .name("Smoothed Heatmap with Zero Fill");
    }
}