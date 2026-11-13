import { contours } from "https://cdn.jsdelivr.net/npm/d3-contour@4.0.2/+esm";
import { clipRingRect } from "./dgcore.js?v=20261113p";

// Cell-centred, row-major samples, south to north. Each result is a set of
// rings for even-odd filling of [threshold[i], threshold[i + 1]).
export function bands(grid, nx, ny, x0, y0, step, thresholds) {
  const rings = contourRings(grid, nx, ny, x0, y0, step, thresholds);
  return rings.map((r, i) => r.concat(rings[i + 1] || []));
}

export function contourRings(grid, nx, ny, x0, y0, step, thresholds) {
  // Replicate the boundary before contouring, so exterior padding cannot
  // create artificial low-value bands along the edge of a constant field.
  const padded = [];
  for (let j = -1; j <= ny; j++) for (let i = -1; i <= nx; i++) {
    padded.push(grid[Math.max(0, Math.min(ny - 1, j)) * nx + Math.max(0, Math.min(nx - 1, i))]);
  }
  return contours().size([nx + 2, ny + 2]).thresholds(thresholds)(padded)
    .map(g => g.coordinates.flat().map(r => clipRingRect(r.map(([x, y]) =>
      [x0 + (x - 1) * step, y0 + (y - 1) * step]),
    x0, y0, x0 + nx * step, y0 + ny * step)).filter(r => r.length > 2));
}

// Extend the surrounding ground colours under the vector building footprints.
// A multi-source grid walk fills masked building samples for drawing only.
export function extendGround(grid, nx, ny) {
  const values = Float32Array.from(grid);
  const queue = new Int32Array(values.length);
  let head = 0, tail = 0;
  for (let i = 0; i < values.length; i++) if (Number.isFinite(values[i])) queue[tail++] = i;
  while (head < tail) {
    const i = queue[head++], x = i % nx;
    const visit = j => {
      if (!Number.isFinite(values[j])) {
        values[j] = values[i];
        queue[tail++] = j;
      }
    };
    if (x > 0) visit(i - 1);
    if (x + 1 < nx) visit(i + 1);
    if (i >= nx) visit(i - nx);
    if (i + nx < nx * ny) visit(i + nx);
  }
  return values;
}

export function gaussian(grid, nx, ny, sigma) {
  const radius = Math.ceil(3 * sigma);
  const weights = Array.from({ length: 2 * radius + 1 }, (_, i) =>
    Math.exp(-.5 * ((i - radius) / sigma) ** 2));
  let values = Float64Array.from(grid);
  for (const axis of [0, 1]) {
    const out = new Float64Array(nx * ny);
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
      let sum = 0, weight = 0;
      for (let d = -radius; d <= radius; d++) {
        const x = i + (axis === 0 ? d : 0), y = j + (axis === 1 ? d : 0);
        if (x < 0 || x >= nx || y < 0 || y >= ny) continue;
        const w = weights[d + radius];
        sum += values[y * nx + x] * w; weight += w;
      }
      out[j * nx + i] = sum / weight;
    }
    values = out;
  }
  return values;
}
