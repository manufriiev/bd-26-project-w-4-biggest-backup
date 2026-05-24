package com.taxifleet.functions;

import com.taxifleet.helper.Helper;
import com.taxifleet.models.TaxiLocation;
import com.taxifleet.models.TaxiSpeed;
import org.apache.flink.streaming.api.functions.windowing.ProcessWindowFunction;
import org.apache.flink.streaming.api.windowing.windows.TimeWindow;
import org.apache.flink.util.Collector;

import java.util.ArrayList;
import java.util.List;

public class TotalDistanceSpeedCalculator extends ProcessWindowFunction<TaxiLocation, TaxiSpeed, Integer, TimeWindow> {
    
    @Override
    public void process(Integer taxiId, 
                       Context context, 
                       Iterable<TaxiLocation> elements, 
                       Collector<TaxiSpeed> out) {
        
        List<TaxiLocation> locations = new ArrayList<>();
        for (TaxiLocation loc : elements) {
            locations.add(loc);
        }
        
        if (locations.size() < 2) {
            return;
        }
        
        double totalDistanceKm = 0.0;
        
        for (int i = 0; i < locations.size() - 1; i++) {
            TaxiLocation current = locations.get(i);
            TaxiLocation next = locations.get(i + 1);
            
            double segmentDistance = Helper.calculateDistance(
                current.latitude, current.longitude,
                next.latitude, next.longitude
            );
            
            totalDistanceKm += segmentDistance;
        }
        
        TaxiLocation first = locations.get(0);
        TaxiLocation last = locations.get(locations.size() - 1);
        
        double totalTimeHours = Helper.calculateTimeDifferenceHours(
            first.timestamp, 
            last.timestamp
        );
        
        double avgSpeed = 0.0;
        if (totalTimeHours > 0) {
            avgSpeed = totalDistanceKm / totalTimeHours;
        }

       out.collect(new TaxiSpeed(
            taxiId,
            last.timestamp,
            last.longitude,
            last.latitude,
            avgSpeed,
            totalDistanceKm
        ));
    }
}