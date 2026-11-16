// Owner-approved Option B/A/C/D tokens, 2026-11-13. Zoning always uses B.
export const STYLES = {
  atlas: {
    name: "아틀라스형", bg: "#F7F5F0", building: "#DDD8CE", figure: "#2C2A29",
    site: "#C84B31", road: "#FFFFFF", water: "#A8C8D8", green: "#C5D8B6", trees: "#7D9D74",
    use6: ["#E29578", "#D1495B", "#669BBC", "#83C5BE", "#9E7B9B", "#B8B3A8"],
    warm: ["#F4E8C1", "#E6C280", "#D48C46", "#B55233", "#7A2820"],
    cool: ["#E6EEF2", "#B8D0DC", "#7FA6B8", "#4A748C", "#244357"],
    sun: ["#669BBC", "#A8DADC", "#F4E285", "#E09F3E", "#9E2A2B"],
    diverging: ["#5C8D89", "#E6E2D8", "#C84B31"],
    zoning: ["#F4A6A0", "#F9D08B", "#F2E6B6", "#C2DEC2"],
    heritage: "#6D3B47",
    isochrone: ["#B55233", "#D48C46", "#E6C280", "#A3B899"],
    aspect8: ["#4A748C", "#6B9AA0", "#88B083", "#C2C97F", "#E6C280", "#D48C46", "#B55233", "#8C6D8E"]
  },
  dutch: {
    name: "데이터형", bg: "#FFFFFF", building: "#E5E7EB", figure: "#111111",
    site: "#FF0055", road: "#D1D5DB", water: "#00AEEF", green: "#7AC943", trees: "#009245",
    use6: ["#FFCC00", "#FF3366", "#0099FF", "#00CC66", "#9933CC", "#9CA3AF"],
    warm: ["#FFF3B0", "#FFD166", "#F77F00", "#D62828", "#6A040F"],
    cool: ["#E0F7FA", "#80DEEA", "#00ACC1", "#006064", "#002535"],
    sun: ["#1D4ED8", "#38BDF8", "#FDE047", "#FB923C", "#DC2626"],
    diverging: ["#0099FF", "#E5E7EB", "#FF0055"],
    zoning: ["#FF3366", "#FF9900", "#FFDE00", "#00CC66"],
    heritage: "#7C3AED",
    isochrone: ["#FF0055", "#FF7700", "#FFCC00", "#00CC66"],
    aspect8: ["#2563EB", "#06B6D4", "#10B981", "#84CC16", "#EAB308", "#F97316", "#EF4444", "#8B5CF6"]
  },
  minimal: {
    name: "미니멀", bg: "#FAFAFA", building: "#E0E0E0", figure: "#141414",
    site: "#E62E25", road: "#FFFFFF", water: "#D0D7DE", green: "#EAEAEA", trees: "#B8B8B8",
    use6: ["#D4D4D4", "#E62E25", "#8C8C8C", "#F0ABA6", "#525252", "#EBEBEB"],
    warm: ["#F5E6E6", "#F0B8B5", "#E6736D", "#E62E25", "#80130E"],
    cool: ["#EDEDED", "#C7C7C7", "#949494", "#575757", "#1F1F1F"],
    sun: ["#D4D4D4", "#A3A3A3", "#F2A6A2", "#E62E25", "#7A110C"],
    diverging: ["#737373", "#E5E5E5", "#E62E25"],
    zoning: ["#8C8C8C", "#E62E25", "#D9D9D9", "#BFBFBF"],
    heritage: "#141414",
    isochrone: ["#7A110C", "#E62E25", "#F08A84", "#C7C7C7"],
    aspect8: ["#262626", "#525252", "#8C8C8C", "#D9827E", "#E62E25", "#B84B46", "#737373", "#404040"]
  },
  eco: {
    name: "생태형", bg: "#F4F1EA", building: "#E2DCD0", figure: "#263028",
    site: "#C85A32", road: "#EAE5DC", water: "#4A8B9C", green: "#8FB372", trees: "#3D6B43",
    use6: ["#D99B66", "#C85A32", "#5B7FA6", "#6A994E", "#8C7A6B", "#C7C0B3"],
    warm: ["#EFE6D5", "#DFC295", "#C98E55", "#A85832", "#693018"],
    cool: ["#E3EFEA", "#A8CFC2", "#68A392", "#367062", "#194037"],
    sun: ["#4A8B9C", "#92B690", "#E9C46A", "#E07A5F", "#9B2226"],
    diverging: ["#4D7C5D", "#E2DCD0", "#C85A32"],
    zoning: ["#D48C70", "#E3B76B", "#DCE09B", "#7DA66D"],
    heritage: "#7F3D27",
    isochrone: ["#3D6B43", "#7DA66D", "#C2D18A", "#E9C46A"],
    aspect8: ["#356070", "#4A8B9C", "#6A994E", "#A7C957", "#E9C46A", "#E07A5F", "#BC4749", "#5E6472"]
  }
};

const colours = x => x.split(" ").map(c => "#" + c);
const ZONING = colours("E05A47 B565A7 E8C564 6BA368");
const SUN = colours("2B83BA 80CDC1 F4E285 E08244 9E1B32");
const SYNTAX = colours("2563EB 38BDF8 FACC15 F97316 DC2626");
[
["swiss","스위스 아틀라스","atlas","F6F2E9 DED8CA 231F20 FFFFFF B83B2A 689ec2 C2D4B2 6E8F64","D98A6C C0392B 4A748C 689F8E 8E6C88 B5B0A4","F3E5AB E2B86B C87D3B 9E472A 5C1D18","4A6B82 DED8CA B83B2A","244357 4A748C 7FA6B8 B8D0DC E6EEF2"],
["paris","파리 카다스트르","atlas","ECEEF1 D4D8DF 1E242B FFFFFF D9381E 7FAAC9 B8D0B5 5E8C61","E59866 D9534F 5B84B1 529E8A 9B6B9E A6ACAF","E8EEF5 B5C7DE 7B9BC4 436B9E 1B3B6F","3B7A9E D4D8DF D9381E","1B3B6F 436B9E 7B9BC4 B5C7DE E8EEF5"],
["datascape","더치 데이터","dutch","FFFFFF E5E7EB 0A0A0A D1D5DB FF0055 00AEEF 7AC943 009245","FFCC00 FF0055 0099FF 00CC66 9933CC 9CA3AF","FFF3B0 FFB703 FB8500 D62828 5F0F40","0099FF E5E7EB FF0055"],
["nocturne","다크 스펙트럼","dutch","16191E 262B33 F3F4F6 0D0F12 FF3366 1E6091 1E3F2E 388E6C","FDE047 FB7185 38BDF8 34D399 C084FC 64748B","FEE090 FDAE61 F46D43 D73027 A50026","38BDF8 262B33 FB7185"],
["poche","미니멀 포셰","minimal","F7F7F5 E2E2DF 111111 FFFFFF D62828 C8D3DC E6E8E3 9CA399","CCCCCC D62828 777777 E89894 333333 E5E5E5","EBEBEB C4C4C4 8F8F8F 525252 171717","737373 E2E2DF D62828"],
["critical","지질·생태","eco","E6E8E1 CFD3C8 1B261E F4F5F0 C85A17 2C6E8A 84A970 2D5A3C","D49A6A B84A39 4B7F8C 5E8C5A 7E6B8F B0B5A8","E9E2D0 C2B280 8A9A68 4A7856 1E4631","2C6E8A CFD3C8 C85A17","194037 367062 68A392 A8CFC2 E3EFEA"]
].forEach(([id,name,parent,base,use,warm,diverging,cool]) => {
  STYLES[id] = {
    name,
    ...Object.fromEntries(
      ["bg","building","figure","road","site","water","green","trees"]
        .map((key,i) => [key,colours(base)[i]])
    ),
    use6:colours(use), warm:colours(warm), cool:colours(cool || warm),
    diverging:colours(diverging), sun:[...SUN], zoning:[...ZONING],
    heritage:"#7A2048", syntax:[...SYNTAX],
    isochrone:[...STYLES[parent].isochrone],
    aspect8:[...STYLES[parent].aspect8]
  };
});

// Standard theme (owner 2026-11-16): each plate uses the colour convention most used for that kind of map,
// verified at the source rather than invented:
//  03 use      APA LBCS 1-digit Function/Structure codes (2001): residential FFFF00, sales/services FF0000,
//              institutional 0000FF, manufacturing A020F0, transport/other BEBEBE; office = light tint of the
//              2000 red because LBCS files offices under 2000
//  22/23/24    Ladybug Tools default "original" colorset (ladybug/color.py _colors[0]), blue -> yellow -> red
//  25 syntax   depthmapX default AXMANESQUE scale (salalib/pafcolor.cpp g_nicecolor), blue 3333DD -> red DD3333
//  15 walk     green 5 / orange 10 / red 15 min, as in the Stadia Maps and MapAtlas isochrone tutorials
//  18 terrain  conventional hypsometric tints, green lowlands -> yellow -> brown highlands
//  19 slope    ColorBrewer RdYlGn reversed; 04 year YlOrBr; 05 height / 17 density YlOrRd (ColorBrewer)
//  base        white page, neutral grey buildings, OSM-carto water AAD3DF and park C8FACC
const LADYBUG = colours("4B6BA9 AAC8F7 F5EF67 EF9C15 EA2600");
STYLES.standard = {
  name: "표준", bg: "#FFFFFF", building: "#D9D9D9", figure: "#1A1A1A",
  road: "#FFFFFF", site: "#E41A1C", water: "#AAD3DF", green: "#C8FACC", trees: "#6FA35F",
  use6: colours("FFFF00 FF0000 FF8080 0000FF A020F0 BEBEBE"),
  warm: colours("FFFFD4 FED98E FE9929 D95F0E 993404"),
  cool: colours("EFF3FF BDD7E7 6BAED6 3182BD 08519C"),
  diverging: colours("2C7BB6 F7F7F7 D7191C"),
  sun: [...LADYBUG], zoning: [...ZONING], heritage: "#7A2048",
  syntax: colours("3333DD 22CCDD 88DD22 DD8833 DD3333"),
  isochrone: colours("33CC33 FF9900 CC3300 BEBEBE"),
  aspect8: colours("E41A1C FF7F00 FFFF33 4DAF4A 1B9E77 377EB8 984EA3 F781BF"),
  sem: {
    height: colours("FFFFB2 FECC5C FD8D3C F03B20 BD0026"),
    density: colours("FFFFB2 FECC5C FD8D3C F03B20 BD0026"),
    terrain: colours("71A65A B9D486 F2E8A0 D9B377 A47448"),
    slope: colours("1A9850 91CF60 FEE08B FC8D59 D73027"),
    sun: [...LADYBUG], svf: [...LADYBUG], wind: [...LADYBUG],
    syntax: colours("3333DD 22CCDD 88DD22 DD8833 DD3333"),
    isoRamp: colours("33CC33 FF9900 CC3300")
  }
};

const mix = (a, b, t) => "#" + [1, 3, 5].map(i =>
  Math.round(parseInt(a.slice(i, i + 2), 16) * (1 - t) +
    parseInt(b.slice(i, i + 2), 16) * t).toString(16).padStart(2, "0")).join("");
const desaturate = c => {
  const rgb = [1, 3, 5].map(i => parseInt(c.slice(i, i + 2), 16));
  const grey = Math.round(rgb[0] * .2126 + rgb[1] * .7152 + rgb[2] * .0722)
    .toString(16).padStart(2, "0").repeat(3);
  return mix(c, "#" + grey, .3);
};

export const ROAD_COLOURS = ["#222222", "#444444", "#666666", "#888888", "#AAAAAA", "#CCCCCC"];
export const ROAD_WIDTHS = [2.2, 1.6, 1.2, .8, .5, .4]; // card px, at 255 px map width
export const STOP_COLOUR = "#222222";
export const ISO_ALPHA = { 5: "4D", 10: "33", 15: "1A" };

// Compatibility fields for existing renderers are resolved here, never in base palettes.
// v02 (2026-11-14): the sequential ramps always run light -> dark. The swiss / paris / critical tokens
// list `cool` dark-first, so height, plot size, D/H, sky view, visibility and the wind tints read the
// other way round in those themes than in atlas / dutch / minimal / eco. STYLES itself is unchanged.
const lum = c => parseInt(c.slice(1, 3), 16) * .2126 + parseInt(c.slice(3, 5), 16) * .7152 + parseInt(c.slice(5, 7), 16) * .0722;
const lightFirst = r => lum(r[0]) < lum(r[r.length - 1]) ? [...r].reverse() : [...r];
export function semanticPalette(pal) {
  const raw = STYLES[pal.id] || STYLES.atlas;
  const s = { ...raw, cool: lightFirst(raw.cool), warm: lightFirst(raw.warm) };
  const wind = [.7, .5, .3, .15, 0].map(t => mix(s.cool[3], "#FFFFFF", t));
  return {
    ...pal,
    // dark theme: context buildings were almost the background colour (#262B33 on #16191E)
    ...(pal.dark ? { building: mix(pal.building, "#FFFFFF", .17) } : {}),
    cat6: s.use6, seq5: s.cool, water: s.water, green: s.green,
    waterLine: mix(s.water, "#141414", .5), greenLine: mix(s.green, "#141414", .45),
    year: [...s.warm].reverse(), height: s.cool, high: s.diverging[2], low: s.diverging[0],
    zoning: [...ZONING],
    protection: ["#7A2048", s.warm[3], s.cool[3], s.cool[2], s.cool[2], s.cool[2]],
    planned: s.diverging[2], treeRow: s.trees, tree: mix(s.trees, "#FFFFFF", .25),
    isochrone: s.isochrone[0], blocks: s.warm[3], density: s.warm,
    terrain: s.warm, slope: s.warm, parcel: s.warm[1], plot: s.cool, sun: [...SUN],
    svf: [...s.cool].reverse(), syntax: [...SYNTAX], visibility: [s.cool[1], s.cool[2], s.cool[4]],
    dh: s.cool, aspect: s.aspect8.map(desaturate),
    wind, windSeason: wind.map(c => mix(c, "#FFFFFF", .2)),
    // per-plate conventions of a theme (STYLES.standard.sem) override the derived ramps
    ...(raw.sem || {}),
    ...(raw.sem?.wind ? { windSeason: raw.sem.wind.map(c => mix(c, "#FFFFFF", .2)) } : {})
  };
}
