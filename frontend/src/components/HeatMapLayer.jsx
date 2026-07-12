import { useEffect, useRef } from "react";
import { useMap } from "react-leaflet";
import L from "leaflet";
import "leaflet.heat";
import { decodeCellId } from "../utils/heatmap_helper.js";

export function HeatMapLayer({
  cells,
  radius = 70,
  blur = 45,
  maxZoom = 5,
  max = 600,
  opacity = 0.1,
}) {
  const map = useMap();
  const layerRef = useRef(null);

  // create the layer once
  useEffect(() => {
    const heatLayer = L.heatLayer([], {
      radius,
      blur,
      maxZoom,
      max,
      opacity,
    }).addTo(map);

    const originalRedraw = heatLayer._redraw.bind(heatLayer);
    heatLayer._redraw = () => {
      if (!heatLayer._map) return;
      originalRedraw();
    };

    layerRef.current = heatLayer;

    return () => {
      map.removeLayer(heatLayer);
      layerRef.current = null;
    };
  }, [map]);

  // update points in place
  useEffect(() => {
    const layer = layerRef.current;
    if (!layer || !layer._map) return; // not attached (yet, or anymore)

    const points = Object.values(cells).map((cell) => {
      const [lat, lon] = decodeCellId(cell.cellId);
      return [lat, lon, cell.taxiCount];
    });
    layer.setLatLngs(points);
  }, [cells]);

  // update options in place
  useEffect(() => {
    const layer = layerRef.current;
    if (!layer || !layer._map) return;

    layer.setOptions({ radius, blur, maxZoom, max, opacity });
  }, [radius, blur, maxZoom, max, opacity]);

  return null;
}
