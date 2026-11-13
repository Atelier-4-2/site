// Base-map tokens only. Data colours are resolved by dgsemantic.js.
import { STYLES } from "./dgsemantic.js?v=20261113s";

export const PALETTE_ORDER = ["atlas", "dutch", "minimal", "eco"];
export const PALETTES = Object.fromEntries(PALETTE_ORDER.map(id => {
  const s = STYLES[id];
  return [id, {
    id, name: s.name, dark: false, bg: s.bg, text: s.figure, figure: s.figure,
    building: s.building, buildingLine: s.figure, edge: s.figure,
    site: s.site, siteLine: s.site, road: s.road, roadLine: s.road
  }];
}));
