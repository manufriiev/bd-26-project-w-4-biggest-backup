package com.taxifleet.helper;

/**
 * GeoFence for the taxi operating area.
 *
 * The T-Drive dataset tracks taxis in Beijing, so the default fence is a
 * bounding box that comfortably covers the city's metropolitan area
 * (roughly the area inside the 6th Ring Road). A taxi reporting a
 * position outside this box is considered to have "left the area" and
 * triggers an alert downstream.
 *
 * Bounds are intentionally generous; they are constants here so the team
 * can tighten them later without touching the calculator code.
 */
public final class GeoFence {

    // Beijing metropolitan bounding box (covers the 6th Ring Road area).
    public static final double MIN_LAT = 39.60;
    public static final double MAX_LAT = 40.20;
    public static final double MIN_LON = 116.10;
    public static final double MAX_LON = 116.80;

    private GeoFence() {
        // utility class
    }

    /**
     * Returns true when (latitude, longitude) sits outside the operating
     * area defined by the constants above.
     */
    public static boolean isOutOfArea(double latitude, double longitude) {
        return latitude  < MIN_LAT || latitude  > MAX_LAT
            || longitude < MIN_LON || longitude > MAX_LON;
    }
}
