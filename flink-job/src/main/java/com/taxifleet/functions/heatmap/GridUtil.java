package com.taxifleet.functions.heatmap;

public class GridUtil {
    // Must match heatmap_helper.js in the frontend
    private static final double CELL_SIZE = 0.0025;

    public static String cellFor(double latitude, double longitude) {
        long latCell = (long) Math.floor(latitude / CELL_SIZE);
        long lonCell = (long) Math.floor(longitude / CELL_SIZE);
        return latCell + "_" + lonCell;
    }
}