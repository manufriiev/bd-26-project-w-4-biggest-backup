package com.taxifleet;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.taxifleet.functions.*;
import com.taxifleet.functions.alarms.OOAAlarmsSweepFunction;
import com.taxifleet.functions.alarms.SpeedingAlarmsSweepFunction;
import com.taxifleet.functions.heatmap.HeatmapPipeline;
import com.taxifleet.functions.ooa.OutOfAreaProcess;
import com.taxifleet.functions.ooa.OutOfAreaProcessFunction;
import com.taxifleet.functions.speed.SpeedCalculatorProcess;
import com.taxifleet.functions.speed.SpeedCalculatorProcessFunction;
import com.taxifleet.models.TaxiLocation;
import com.taxifleet.models.TaxiSpeed;

import java.time.Duration;
import org.apache.flink.api.common.eventtime.WatermarkStrategy;
import org.apache.flink.api.common.serialization.*;
import org.apache.flink.connector.kafka.sink.KafkaRecordSerializationSchema;
import org.apache.flink.connector.kafka.sink.KafkaSink;
import org.apache.flink.connector.kafka.source.KafkaSource;
import org.apache.flink.connector.kafka.source.enumerator.initializer.OffsetsInitializer;
import org.apache.flink.streaming.api.datastream.DataStream;
import org.apache.flink.streaming.api.datastream.SingleOutputStreamOperator;
import org.apache.flink.streaming.api.environment.StreamExecutionEnvironment;
import org.apache.flink.streaming.api.windowing.assigners.TumblingProcessingTimeWindows;

import com.taxifleet.models.HeatmapCell;

public class TaxiJob {
        private static final String BOOTSTRAP_SERVERS = "kafka:9092";
        private static final Duration WINDOW_DURATION = Duration.ofSeconds(5);
        private static final Duration WATERMARK_BOUND = Duration.ofSeconds(2);

        private static KafkaSink<String> createKafkaSink(String topic) {
                return KafkaSink.<String>builder()
                                .setBootstrapServers(BOOTSTRAP_SERVERS)
                                .setRecordSerializer(KafkaRecordSerializationSchema.builder()
                                                .setTopic(topic)
                                                .setValueSerializationSchema(new SimpleStringSchema())
                                                .build())
                                .build();
        }

        private static DataStream<String> createKafkaSource(StreamExecutionEnvironment env) {
                KafkaSource<String> source = KafkaSource.<String>builder()
                                .setBootstrapServers(BOOTSTRAP_SERVERS)
                                .setTopics("taxi-locations")
                                .setGroupId("flink-taxi-consumer")
                                .setStartingOffsets(OffsetsInitializer.earliest())
                                .setValueOnlyDeserializer(new SimpleStringSchema())
                                .build();
                return env.fromSource(
                        source,
                                WatermarkStrategy.noWatermarks(),
                                "Kafka Taxi Source");
        }

        private static DataStream<TaxiLocation> parseLocations(DataStream<String> rawStream) {
                return rawStream
                        .flatMap(new LocationParser())
                        .name("Parse JSON and Filter Invalid Locations")
                        .assignTimestampsAndWatermarks(
                                        WatermarkStrategy.<TaxiLocation>forBoundedOutOfOrderness(WATERMARK_BOUND)
                                                .withTimestampAssigner((loc,recordTimestamp) -> loc.eventTimeMillis));                            
        }

        private static DataStream<TaxiLocation> throttleLocations(DataStream<TaxiLocation> locations) {
                return locations
                        .keyBy(location -> location.taxi_id)
                        .window(TumblingProcessingTimeWindows.of(WINDOW_DURATION))
                        .maxBy("timestamp");
        }

        private static SingleOutputStreamOperator<TaxiSpeed> calculateSpeed(DataStream<TaxiLocation> filteredLocationStream) {
                return filteredLocationStream
                                .keyBy(location -> location.taxi_id)
                                .process(new SpeedCalculatorProcessFunction())
                                .name("Calculate Speed and Detect Speeding");
        }

        private static void storeToRedis(SingleOutputStreamOperator<TaxiSpeed> speedStream) {
               speedStream
                        .process(new RedisSinkFunction())
                        .name("Store Information to Redis");
        }

        // TODO: currently we do not have parallelism since active alarmssweepfunction
        // cannot handle it
        private static DataStream<TaxiLocation> processOOAViolations(DataStream<TaxiLocation> locationStream,
                        KafkaSink<String> violationsSink, ObjectMapper mapper) {
                SingleOutputStreamOperator<TaxiLocation> inAreaStream = locationStream
                                .keyBy(loc -> loc.taxi_id)
                                .process(new OutOfAreaProcessFunction());

                DataStream<TaxiSpeed> outOfAreaStream = inAreaStream
                                .getSideOutput(OutOfAreaProcess.OUT_OF_AREA_TAG)
                                .map(loc -> {
                                        TaxiSpeed s = new TaxiSpeed();
                                        s.taxi_id = loc.taxi_id;
                                        s.timestamp = loc.timestamp;
                                        s.latitude = loc.latitude;
                                        s.longitude = loc.longitude;
                                        s.isOutOfArea = true;
                                        return s;
                                });

                DataStream<TaxiSpeed> ooaReturnedStream = inAreaStream
                        .getSideOutput(OutOfAreaProcess.OOA_RETURNED_TAG)
                        .map(loc -> {
                                TaxiSpeed s = new TaxiSpeed();
                                s.taxi_id = loc.taxi_id;
                                s.timestamp = loc.timestamp;
                                s.latitude = loc.latitude;
                                s.longitude = loc.longitude;
                                s.isOutOfArea = false;
                                return s;
                        });

                outOfAreaStream
                                .process(new RedisSinkFunction())
                                .name("Store OOA to Redis");

                DataStream<String> areaSnapshot = outOfAreaStream
                                .union(ooaReturnedStream)
                        .keyBy(speed -> 0)
                                .process(new OOAAlarmsSweepFunction())
                                .setParallelism(1)
                                .name("Area Active Alarms Snapshot");
                areaSnapshot.sinkTo(violationsSink).name("Notify Area Violation");

                return inAreaStream;
        }

        // TODO: currently we do not have parallelism since active alarmssweepfunction
        // cannot handle it
        private static void processSpeedingViolations(SingleOutputStreamOperator<TaxiSpeed> speedStream,
                        KafkaSink<String> speedingSink) {
                DataStream<TaxiSpeed> speedingStream = speedStream
                                .getSideOutput(SpeedCalculatorProcess.SPEEDING_TAG);
                DataStream<String> speedingSnapshot = speedingStream
                                .keyBy(speed -> 0)
                                .process(new SpeedingAlarmsSweepFunction())
                                .setParallelism(1)
                                .name("Speeding Active Alarms Snapshot");
                speedingSnapshot.sinkTo(speedingSink).name("Notify Speeding");
        }

        private static void propagateToDashboard(SingleOutputStreamOperator<TaxiSpeed> outOfAreaCheckedStream,

                        KafkaSink<String> processedSink, ObjectMapper mapper) {
                outOfAreaCheckedStream
                                .map(mapper::writeValueAsString)
                                .returns(String.class)
                                .sinkTo(processedSink)
                                .name("Propagate Location to Dashboard");
        }

        private static void processHeatmap(DataStream<TaxiSpeed> locationStream, KafkaSink<String> heatmapSink,
                        ObjectMapper mapper) {
                DataStream<HeatmapCell> heatmapStream = HeatmapPipeline.build(locationStream);

                heatmapStream
                                .map(mapper::writeValueAsString)
                                .returns(String.class)
                                .sinkTo(heatmapSink)
                                .name("Heatmap Distinct Taxi Count per Cell");
        }

        // ----------------- main function
        public static void main(String[] args) throws Exception {
                StreamExecutionEnvironment env = StreamExecutionEnvironment.getExecutionEnvironment();
                // set paralism, hast to be matched the partitions in kafka, otherwisekafka will
                // slow down as only so many patritions can be written to in parallel
                env.setParallelism(4);
                System.out.println("Flink Taxi Job starting - connecting to Kafka...");

                ObjectMapper mapper = new ObjectMapper();
                KafkaSink<String> violationsSink = createKafkaSink("taxi-area-violations");
                KafkaSink<String> processedSink = createKafkaSink("taxi-processed");
                KafkaSink<String> speedingSink = createKafkaSink("taxi-speeding");
                KafkaSink<String> heatmapSink = createKafkaSink("taxi-heatmap");

                // data source
                DataStream<String> kafkaStream = createKafkaSource(env);

                // reordering incomming data, filtering out invalid data, parsing the json into
                // TaxiLocation objects
                DataStream<TaxiLocation> locationStream = parseLocations(kafkaStream);
                // windowing, to only get one update per taxi per 5 seconds using the latest
                // location
                DataStream<TaxiLocation> filteredLocationStream = throttleLocations(locationStream);
                // now first parse in area/out of area
                DataStream<TaxiLocation> inAreaStream = processOOAViolations(filteredLocationStream, violationsSink, mapper);
                // only pass in area passed to speeding
                SingleOutputStreamOperator<TaxiSpeed> speedStream = calculateSpeed(inAreaStream);

                speedStream.keyBy(speed -> 0)
                        .process(new TotalDistanceFunction())
                        .setParallelism(1)
                        .name("Total Distance Function");

                storeToRedis(speedStream);
                processSpeedingViolations(speedStream, speedingSink);
                propagateToDashboard(speedStream, processedSink, mapper);

//                processHeatmap(speedStream, heatmapSink, mapper);

                env.execute("Taxi Fleet Monitoring");
        }

}
