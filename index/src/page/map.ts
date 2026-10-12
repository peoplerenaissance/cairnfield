// The ground behind both pages: the contour map of the project's site, drawn from the
// same heights, so the index stands on the land the site shows. It is decoration. It
// reads nothing and writes no text and no number, so every text on a page is still a
// value of its endpoint or one of the page's own words (R13).
//
// The site draws its map once and makes it the page's background image, from a `data:`
// address. The pages' policy takes an image from the index's own origin alone, so here
// the map stays on the canvas it is drawn on, held still behind the page.

/** The side of one cell of the grid the heights are read on, in pixels. */
const CELL = 8;
/** The land repeats at this many pixels down the page, as it does on the site. */
const PERIOD = 2400;
/** The contour lines: this many each side of the middle one, this far apart in height. */
const LINES = 12;
const STEP = 0.24;
const MIDDLE = 0.07;
/** Every fifth line is an index line, drawn heavier. */
const LINE = { color: "#DAE0DC", width: 1 };
const INDEX_LINE = { color: "#C6CFCA", width: 1.5 };
/** A screen with more pixels to the point is drawn at no more than this many. */
const MAX_SCALE = 2;
/** A change of the window's size is drawn this long after the last one. */
const SETTLE_MS = 150;

type Point = readonly [x: number, y: number];
type Segment = readonly [from: Point, to: Point];

/** The height of the land at a point, as the site reads it. */
function height(x: number, y: number): number {
  const a = (2 * Math.PI * y) / PERIOD;
  return (
    Math.sin(a + x / 310) +
    0.7 * Math.sin(2 * a - x / 190 + 1.3) +
    0.5 * Math.sin(3 * a + x / 130 + 2.1) * Math.cos(x / 420) +
    0.6 * Math.cos(x / 260 + 0.5) +
    0.35 * Math.sin(5 * a + x / 90)
  );
}

/** Where a line at a level crosses the side between two corners, as a share of that side. */
const crossing = (from: number, to: number, level: number): number => (level - from) / (to - from);

/** The pieces of a contour line in one cell, from which of its four corners stand above the line. */
function pieces(above: number, top: Point, right: Point, bottom: Point, left: Point): readonly Segment[] {
  switch (above) {
    case 1:
    case 14:
      return [[left, bottom]];
    case 2:
    case 13:
      return [[bottom, right]];
    case 3:
    case 12:
      return [[left, right]];
    case 4:
    case 11:
      return [[top, right]];
    case 6:
    case 9:
      return [[top, bottom]];
    case 7:
    case 8:
      return [[top, left]];
    case 5:
      return [[top, right], [left, bottom]];
    case 10:
      return [[top, left], [bottom, right]];
    default:
      // Every corner above the line, or none: the line does not pass through.
      return [];
  }
}

/** Draws the map over the whole of the canvas, at the size the stylesheet gives it. */
function draw(canvas: HTMLCanvasElement): void {
  const width = canvas.clientWidth;
  const depth = canvas.clientHeight;
  const scale = Math.min(window.devicePixelRatio || 1, MAX_SCALE);
  canvas.width = width * scale;
  canvas.height = depth * scale;
  const pen = canvas.getContext("2d");
  if (pen === null) return;
  pen.scale(scale, scale);

  const columns = Math.ceil(width / CELL) + 1;
  const rows = Math.ceil(depth / CELL) + 1;
  const heights = new Float32Array(columns * rows);
  for (let row = 0; row < rows; row++) for (let column = 0; column < columns; column++) heights[row * columns + column] = height(column * CELL, row * CELL);
  const at = (row: number, column: number): number => heights[row * columns + column] ?? 0;

  for (let line = -LINES; line <= LINES; line++) {
    const level = line * STEP + MIDDLE;
    pen.beginPath();
    for (let row = 0; row < rows - 1; row++) {
      for (let column = 0; column < columns - 1; column++) {
        const [a, b, c, d] = [at(row, column), at(row, column + 1), at(row + 1, column + 1), at(row + 1, column)];
        const above = (a > level ? 8 : 0) | (b > level ? 4 : 0) | (c > level ? 2 : 0) | (d > level ? 1 : 0);
        if (above === 0 || above === 15) continue;
        const [x, y] = [column * CELL, row * CELL];
        const top: Point = [x + CELL * crossing(a, b, level), y];
        const right: Point = [x + CELL, y + CELL * crossing(b, c, level)];
        const bottom: Point = [x + CELL * crossing(d, c, level), y + CELL];
        const left: Point = [x, y + CELL * crossing(a, d, level)];
        for (const [from, to] of pieces(above, top, right, bottom, left)) {
          pen.moveTo(from[0], from[1]);
          pen.lineTo(to[0], to[1]);
        }
      }
    }
    const { color, width: weight } = line % 5 === 0 ? INDEX_LINE : LINE;
    pen.strokeStyle = color;
    pen.lineWidth = weight;
    pen.stroke();
  }
}

/** Puts the map behind the page, and draws it again when the window gives it another size. */
export function ground(): void {
  const canvas = document.createElement("canvas");
  canvas.className = "map";
  canvas.setAttribute("aria-hidden", "true");
  document.body.prepend(canvas);

  let drawn = "";
  const redraw = (): void => {
    const size = `${canvas.clientWidth}x${canvas.clientHeight}`;
    if (size === drawn) return;
    drawn = size;
    draw(canvas);
  };
  redraw();

  let settling: number | undefined;
  window.addEventListener("resize", () => {
    clearTimeout(settling);
    settling = setTimeout(redraw, SETTLE_MS);
  });
}
