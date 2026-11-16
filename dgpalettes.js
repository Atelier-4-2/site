// Base-map tokens only. Data colours are resolved by dgsemantic.js.
import { STYLES } from "./dgsemantic_v02.js?v=20261116p";

export const PALETTE_ORDER = ["standard","swiss","paris","datascape","nocturne","poche","critical","atlas","dutch","minimal","eco"];
export const PALETTES = Object.fromEntries(PALETTE_ORDER.map(id => {
  const s = STYLES[id];
  return [id, {
    id, name: s.name, dark: id === "nocturne", bg: s.bg, text: s.figure, figure: s.figure,
    building: s.building, buildingLine: s.figure, edge: id === "nocturne" ? "#8B95A5" : s.figure,
    site: s.site, siteLine: s.site, road: s.road, roadLine: s.road
  }];
}));
