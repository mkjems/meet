// Where the tiles go. Two layouts: a grid where every tile is the same size, and a stage with one big tile (a
// shared screen, or a pinned person) and the rest in a strip beside or below it.

export type Rect = { x: number; y: number; w: number; h: number };

const WIDE = 16 / 9;
const TALL = 9 / 16;

/** n tiles in a W × H box, as big as they can be, with aspects between 9:16 and 16:9; rows centred. */
export function grid(n: number, W: number, H: number, gap: number): Rect[] {
  if (n === 0) return [];
  let best = { area: -1, cols: 1, w: 0, h: 0 };
  for (let cols = 1; cols <= n; cols++) {
    const rows = Math.ceil(n / cols);
    let w = (W - gap * (cols - 1)) / cols, h = (H - gap * (rows - 1)) / rows;
    if (w <= 0 || h <= 0) continue;
    if (w / h > WIDE) w = h * WIDE;
    else if (w / h < TALL) h = w / TALL;
    if (w * h > best.area * 1.02) best = { area: w * h, cols, w, h };
  }
  const { cols, w, h } = best;
  const rows = Math.ceil(n / cols);
  const y0 = (H - (rows * h + (rows - 1) * gap)) / 2;
  const out: Rect[] = [];
  for (let r = 0; r < rows; r++) {
    const count = Math.min(cols, n - r * cols);
    const x0 = (W - (count * w + (count - 1) * gap)) / 2;
    for (let c = 0; c < count; c++) out.push({ x: x0 + c * (w + gap), y: y0 + r * (h + gap), w, h });
  }
  return out;
}

/** One main tile and n others in a strip: on the right when the box is wide, at the bottom when it's tall. */
export function stage(n: number, W: number, H: number, gap: number): { main: Rect; strip: Rect[] } {
  if (n === 0) return { main: { x: 0, y: 0, w: W, h: H }, strip: [] };
  const strip: Rect[] = [];
  if (W > H * 1.1) {
    const sw = Math.min(260, Math.max(150, W * 0.2));
    const th = Math.min(sw / WIDE, (H - gap * (n - 1)) / n), tw = Math.min(sw, th * WIDE);
    const y0 = (H - (n * th + (n - 1) * gap)) / 2;
    for (let i = 0; i < n; i++) strip.push({ x: W - sw + (sw - tw) / 2, y: y0 + i * (th + gap), w: tw, h: th });
    return { main: { x: 0, y: 0, w: W - sw - gap, h: H }, strip };
  }
  const sh = Math.min(150, Math.max(90, H * 0.18));
  const tw = Math.min(sh * WIDE, (W - gap * (n - 1)) / n), th = Math.min(sh, tw / WIDE * 1.4);
  const x0 = (W - (n * tw + (n - 1) * gap)) / 2;
  for (let i = 0; i < n; i++) strip.push({ x: x0 + i * (tw + gap), y: H - sh + (sh - th) / 2, w: tw, h: th });
  return { main: { x: 0, y: 0, w: W, h: H - sh - gap }, strip };
}
