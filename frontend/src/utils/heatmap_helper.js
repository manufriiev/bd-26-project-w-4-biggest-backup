const CELL_SIZE = 0.0025; // must match GridUtil.CELL_SIZE in the Flink job — verify!
//TODO: better send the center information right away instead of calculating it in the frontend
export function decodeCellId(cellId) {
  const [latCellStr, lonCellStr] = cellId.split("_");
  const latCell = Number(latCellStr);
  const lonCell = Number(lonCellStr);
  const lat = latCell * CELL_SIZE + CELL_SIZE / 2;
  const lon = lonCell * CELL_SIZE + CELL_SIZE / 2;
  return [lat, lon];
}
