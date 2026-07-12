import { useEffect } from "react";
import {
  MapContainer,
  TileLayer,
  Marker,
  Popup,
  Polyline,
  useMap,
} from "react-leaflet";
import MarkerClusterGroup from "react-leaflet-cluster";

import { pickTaxiIcon, createClusterIcon } from "../utils/taxiIcons.js";
import { HeatMapControl } from "./HeatMapControl.jsx";

const BEIJING_CENTER = [39.9042, 116.4074];
const DEFAULT_ZOOM = 12;

function RecenterMap({ selectedTaxi }) {
  const map = useMap();

  useEffect(() => {
    if (!selectedTaxi) return;

    map.setView(
      [selectedTaxi.latitude, selectedTaxi.longitude],
      map.getZoom(),
      {
        animate: true,
      },
    );
  }, [map, selectedTaxi]);

  return null;
}

// Compact status card shown in a taxi's popup.
function TaxiPopup({ taxi, isSpeeding, isOutOfArea }) {
  // Prefer totalDistance (the field the backend sends); fall back to distance.
  const distanceKm = taxi.totalDistance ?? taxi.distance;

  const badges = [];
  if (isSpeeding) badges.push(["Speeding", "#993C1D", "#FAECE7"]);
  if (isOutOfArea) badges.push(["Out of area", "#B45309", "#FEF3E2"]);
  if (taxi.isParking) badges.push(["Parked", "#4B5563", "#F1F2F4"]);
  if (badges.length === 0) badges.push(["Active", "#185FA5", "#E6F1FB"]);

  const rows = [
    ["Speed", taxi.speed != null ? `${taxi.speed.toFixed(1)} km/h` : "—"],
    [
      "Avg speed",
      taxi.averageSpeed != null ? `${taxi.averageSpeed.toFixed(1)} km/h` : "—",
    ],
    ["Distance", distanceKm != null ? `${distanceKm.toFixed(2)} km` : "—"],
    ["Updated", taxi.timestamp ?? "—"],
  ];

  return (
    <div style={{ fontSize: 13, minWidth: 190, fontFamily: "sans-serif" }}>
      <div
        style={{
          fontSize: 15,
          fontWeight: 700,
          color: "#111",
          marginBottom: 6,
          paddingBottom: 6,
          borderBottom: "1px solid #eef0f2",
        }}
      >
        🚖 Taxi {taxi.taxi_id}
      </div>

      <div
        style={{ display: "flex", flexWrap: "wrap", gap: 5, marginBottom: 8 }}
      >
        {badges.map(([label, color, bg]) => (
          <span
            key={label}
            style={{
              fontSize: 11,
              fontWeight: 600,
              padding: "1px 7px",
              borderRadius: 999,
              background: bg,
              color,
            }}
          >
            {label}
          </span>
        ))}
      </div>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "auto 1fr",
          rowGap: 4,
          columnGap: 10,
        }}
      >
        {rows.map(([label, value]) => (
          <div key={label} style={{ display: "contents" }}>
            <span style={{ color: "#8a8f98", fontSize: 12 }}>{label}</span>
            <span
              style={{ color: "#1f2328", fontWeight: 500, textAlign: "right" }}
            >
              {value}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

// Renders the full live map: base tiles, clustered taxi markers, the
// selected taxi's recent path, and auto-recentering on selection.
export function MapView({
  taxiMap,
  taxis,
  selectedTaxiId,
  violatingTaxiIds,
  pathPositions,
  onSelectTaxi,
  heatmapCells,
}) {
  return (
    <MapContainer
      center={BEIJING_CENTER}
      zoom={DEFAULT_ZOOM}
      style={{ height: "100%", width: "100%" }}
    >
      <RecenterMap
        selectedTaxi={selectedTaxiId === null ? null : taxiMap[selectedTaxiId]}
      />
      <TileLayer
        attribution='&copy; <a href="https://openstreetmap.org">OpenStreetMap</a> contributors'
        url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
      />
      {<HeatMapControl cells={heatmapCells} />}
      <MarkerClusterGroup
        chunkedLoading
        iconCreateFunction={createClusterIcon}
        maxClusterRadius={60}
        spiderfyOnMaxZoom={true}
        disableClusteringAtZoom={20}
        showCoverageOnHover={false}
      >
        {selectedTaxiId !== null && pathPositions.length > 1 && (
          <Polyline
            key={`poly-${selectedTaxiId}`}
            positions={pathPositions}
            pathOptions={{ color: "#1D4ED8", weight: 3, opacity: 0.7 }}
          />
        )}

        {taxis.map((taxi) => {
          const isSpeeding = taxi.isSpeeding;
          const isOutOfArea = violatingTaxiIds.has(String(taxi.taxi_id));
          const icon = pickTaxiIcon({
            isSelected:
              selectedTaxiId !== null &&
              String(taxi.taxi_id) === String(selectedTaxiId),
            isSpeeding,
            isOutOfArea,
            isParking: taxi.isParking,
          });

          return (
            <Marker
              key={taxi.taxi_id}
              position={[taxi.latitude, taxi.longitude]}
              opacity={taxi._opacity}
              icon={icon}
              eventHandlers={{ click: () => onSelectTaxi(taxi.taxi_id) }}
            >
              <Popup>
                <TaxiPopup
                  taxi={taxi}
                  isSpeeding={isSpeeding}
                  isOutOfArea={isOutOfArea}
                />
              </Popup>
            </Marker>
          );
        })}
      </MarkerClusterGroup>
    </MapContainer>
  );
}
