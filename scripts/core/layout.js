/**
 * Page layout analysis.
 *
 * 1. Text spans are grouped into line segments. Spans on the same baseline are only joined when the
 *    horizontal gap is small, so two columns never melt into one line.
 * 2. Line segments and images become boxes and the page is sliced recursively along whitespace
 *    (recursive XY-cut). A vertical gutter produces a "cols" node, a horizontal gap a "rows" node.
 *    Line boxes are inflated vertically so that ordinary line spacing does not count as a gap; this
 *    avoids the classic XY-cut mistake of reading two aligned columns line by line.
 * 3. Each leaf (a block of a single column) is segmented into paragraphs using spacing, indentation,
 *    font size/weight changes and bullets.
 *
 * The output tree is consumed by html.js.
 */

import { median } from "./util.js";

const LINE_JOIN_GAP = 0.9; // em: max gap between spans of one line segment
const INFLATE = 0.35; // em: vertical inflation of line boxes (closes normal leading)
const STRONG_GAP = 1.2; // em: horizontal gap that is cut before looking for columns
const MIN_GUTTER = 0.9; // em: narrowest whitespace accepted as a column gutter

export const BULLET_RE = /^\s*[•●▪■◦○◆◇►▶✦✧‣⁃∙]\s*/u;

/* -------------------------------------------------------------------------- */
/* Lines                                                                      */
/* -------------------------------------------------------------------------- */

function makeLine(spans) {
  spans.sort((a, b) => a.x0 - b.x0);
  const sizeChars = new Map();
  let chars = 0;
  let boldChars = 0;
  let italicChars = 0;
  for (const s of spans) {
    const n = s.str.replace(/\s/g, "").length;
    chars += n;
    if (s.bold) boldChars += n;
    if (s.italic) italicChars += n;
    const key = Math.round(s.size * 2) / 2;
    sizeChars.set(key, (sizeChars.get(key) ?? 0) + n);
  }
  let size = spans[0].size;
  let best = -1;
  for (const [key, n] of sizeChars) {
    if (n > best || (n === best && key > size)) {
      best = n;
      size = key;
    }
  }
  const main = spans.reduce((a, b) => (Math.abs(b.size - size) < Math.abs(a.size - size) ? b : a));
  return {
    spans,
    x0: Math.min(...spans.map(s => s.x0)),
    x1: Math.max(...spans.map(s => s.x1)),
    top: Math.min(...spans.map(s => s.top)),
    bottom: Math.max(...spans.map(s => s.bottom)),
    baseline: main.baseline,
    size,
    chars,
    bold: chars > 0 && boldChars === chars,
    italic: chars > 0 && italicChars === chars
  };
}

/** Groups spans sharing a baseline. Returns arrays of spans (unsorted horizontally). */
function baselineBands(spans) {
  const sorted = [...spans].sort((a, b) => a.baseline - b.baseline || a.x0 - b.x0);
  const bands = [];
  for (const s of sorted) {
    const band = bands.at(-1);
    if (band) {
      const tol = 0.45 * Math.max(s.size, band.size);
      const overlaps = s.top < band.bottom && s.bottom > band.top;
      if (Math.abs(s.baseline - band.baseline) <= tol && overlaps) {
        band.spans.push(s);
        if (s.size > band.size) {
          band.size = s.size;
          band.baseline = s.baseline;
        }
        band.top = Math.min(band.top, s.top);
        band.bottom = Math.max(band.bottom, s.bottom);
        continue;
      }
    }
    bands.push({ spans: [s], baseline: s.baseline, size: s.size, top: s.top, bottom: s.bottom });
  }
  return bands.map(b => b.spans);
}

export function buildLines(spans) {
  const lines = [];
  for (const band of baselineBands(spans)) {
    band.sort((a, b) => a.x0 - b.x0);
    let segment = [];
    for (const s of band) {
      const prev = segment.at(-1);
      if (prev) {
        // Text drawn twice (fake bold, shadows) shows up as overlapping duplicates.
        if (s.str === prev.str && Math.abs(s.x0 - prev.x0) < 0.5 * s.size) continue;
        const gap = s.x0 - prev.x1;
        if (gap > LINE_JOIN_GAP * Math.max(s.size, prev.size)) {
          lines.push(makeLine(segment));
          segment = [];
        }
      }
      segment.push(s);
    }
    if (segment.length) lines.push(makeLine(segment));
  }
  return lines;
}

/** Re-joins line segments that share a baseline inside one block (e.g. "Name ...... value"). */
function mergeSameBaseline(lines) {
  const bands = baselineBands(lines.flatMap(l => l.spans));
  return bands.map(spans => makeLine(spans)).sort((a, b) => a.baseline - b.baseline);
}

export function lineText(line) {
  let text = "";
  let prev = null;
  for (const s of line.spans) {
    if (prev && needsSpace(prev, s, line.size)) text += " ";
    text += s.str;
    prev = s;
  }
  return text.replace(/\s+/g, " ").trim();
}

export function needsSpace(prev, next, size) {
  if (/\s$/.test(prev.str) || /^\s/.test(next.str)) return false;
  return next.x0 - prev.x1 > 0.12 * size;
}

/* -------------------------------------------------------------------------- */
/* Recursive XY-cut                                                           */
/* -------------------------------------------------------------------------- */

function lineBox(line) {
  const pad = INFLATE * line.size;
  return { kind: "line", x0: line.x0, x1: line.x1, top: line.top - pad, bottom: line.bottom + pad, size: line.size, item: line };
}

function imageBox(image) {
  return { kind: "image", x0: image.x0, x1: image.x1, top: image.top, bottom: image.bottom, size: 0, item: image };
}

function extent(boxes) {
  if (!boxes.length) return null;
  return {
    x0: Math.min(...boxes.map(b => b.x0)),
    x1: Math.max(...boxes.map(b => b.x1)),
    top: Math.min(...boxes.map(b => b.top)),
    bottom: Math.max(...boxes.map(b => b.bottom))
  };
}

function emOf(boxes) {
  const sizes = boxes.filter(b => b.kind === "line").map(b => b.size);
  return median(sizes) || 10;
}

function mergeIntervals(intervals) {
  intervals.sort((a, b) => a[0] - b[0]);
  const merged = [];
  for (const [a, b] of intervals) {
    const last = merged.at(-1);
    if (last && a <= last[1]) last[1] = Math.max(last[1], b);
    else merged.push([a, b]);
  }
  return merged;
}

/** Finds column gutters. Returns { groups, gutters } or null. */
function verticalSplit(boxes, em) {
  const merged = mergeIntervals(boxes.map(b => [b.x0, b.x1]));
  if (merged.length < 2) return null;
  const minGutter = Math.max(3, MIN_GUTTER * em);

  // Segments separated by gutters wide enough.
  let segments = [{ x0: merged[0][0], x1: merged[0][1] }];
  for (let i = 1; i < merged.length; i++) {
    const last = segments.at(-1);
    if (merged[i][0] - last.x1 >= minGutter) segments.push({ x0: merged[i][0], x1: merged[i][1] });
    else last.x1 = Math.max(last.x1, merged[i][1]);
  }
  if (segments.length < 2) return null;

  // Very narrow "columns" are usually bullets, numbers or icons: glue them to a neighbour.
  const regionWidth = segments.at(-1).x1 - segments[0].x0;
  const minWidth = Math.max(2.5 * em, 0.08 * regionWidth);
  let changed = true;
  while (changed && segments.length > 1) {
    changed = false;
    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i];
      if (seg.x1 - seg.x0 >= minWidth) continue;
      const gapLeft = i > 0 ? seg.x0 - segments[i - 1].x1 : Infinity;
      const gapRight = i < segments.length - 1 ? segments[i + 1].x0 - seg.x1 : Infinity;
      const j = gapLeft <= gapRight ? i - 1 : i + 1;
      const other = segments[j];
      other.x0 = Math.min(other.x0, seg.x0);
      other.x1 = Math.max(other.x1, seg.x1);
      segments.splice(i, 1);
      changed = true;
      break;
    }
  }
  if (segments.length < 2) return null;

  const groups = segments.map(() => []);
  for (const b of boxes) {
    const center = (b.x0 + b.x1) / 2;
    let idx = segments.findIndex(s => center >= s.x0 - 0.01 && center <= s.x1 + 0.01);
    if (idx < 0) idx = segments.findIndex(s => b.x0 < s.x1 && b.x1 > s.x0);
    groups[Math.max(0, idx)].push(b);
  }
  const gutters = [];
  for (let i = 1; i < segments.length; i++) gutters.push([segments[i - 1].x1, segments[i].x0]);
  return { groups: groups.filter(g => g.length), gutters };
}

function widestHorizontalGap(boxes) {
  const merged = mergeIntervals(boxes.map(b => [b.top, b.bottom]));
  let best = null;
  for (let i = 1; i < merged.length; i++) {
    const size = merged[i][0] - merged[i - 1][1];
    if (size > 0 && (!best || size > best.size)) best = { size, pos: (merged[i][0] + merged[i - 1][1]) / 2 };
  }
  return best;
}

function sharesGutter(above, below, em) {
  const a = verticalSplit(above, em);
  const b = verticalSplit(below, em);
  if (!a || !b) return false;
  return a.gutters.some(([a0, a1]) => b.gutters.some(([b0, b1]) => a0 < b1 && b0 < a1));
}

function cut(boxes, depth = 0) {
  if (boxes.length <= 1 || depth > 80) return { type: "leaf", boxes };
  const em = emOf(boxes);
  const cols = verticalSplit(boxes, em);
  const gap = widestHorizontalGap(boxes);

  const splitRows = () => {
    const above = boxes.filter(b => b.top < gap.pos);
    const below = boxes.filter(b => b.top >= gap.pos);
    return [above, below];
  };

  if (gap && (!cols || gap.size >= STRONG_GAP * em)) {
    const [above, below] = splitRows();
    // A strong gap that runs *inside* a column layout (both halves share a gutter) is just a pause
    // in the column flow: keep reading column by column.
    if (!cols || !sharesGutter(above, below, em)) {
      return { type: "rows", children: [cut(above, depth + 1), cut(below, depth + 1)] };
    }
  }
  if (cols && cols.groups.length > 1) {
    return { type: "cols", children: cols.groups.map(g => cut(g, depth + 1)) };
  }
  if (gap) {
    const [above, below] = splitRows();
    return { type: "rows", children: [cut(above, depth + 1), cut(below, depth + 1)] };
  }
  return { type: "leaf", boxes };
}

/** Flattens nested rows, merges consecutive leaves and computes extents. */
function simplify(node) {
  if (node.type === "leaf") {
    node.box = extent(node.boxes);
    return node;
  }
  const children = [];
  for (const child of node.children.map(simplify)) {
    if (node.type === "rows" && child.type === "rows") children.push(...child.children);
    else children.push(child);
  }
  if (node.type === "rows") {
    const merged = [];
    for (const child of children) {
      const last = merged.at(-1);
      if (last?.type === "leaf" && child.type === "leaf") {
        last.boxes.push(...child.boxes);
        last.box = extent(last.boxes);
      } else merged.push(child);
    }
    if (merged.length === 1) return merged[0];
    node.children = merged;
  } else {
    node.children = children;
  }
  node.box = extent(node.children.map(c => c.box));
  return node;
}

/* -------------------------------------------------------------------------- */
/* Paragraphs                                                                 */
/* -------------------------------------------------------------------------- */

function leftEdgeOf(lines) {
  const counts = new Map();
  for (const l of lines) {
    const key = Math.round(l.x0);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  let edge = Infinity;
  let best = 0;
  for (const [x, n] of counts) {
    if (n > best || (n === best && x < edge)) {
      best = n;
      edge = x;
    }
  }
  return Math.min(edge, ...lines.map(l => l.x0 + 0.5 * l.size));
}

function extractDropCap(lines) {
  if (lines.length < 2) return { lines, dropcap: null };
  const em = median(lines.map(l => l.size));
  const idx = lines.findIndex(l => /^\p{L}$/u.test(lineText(l)) && l.size >= 2.2 * em);
  if (idx < 0) return { lines, dropcap: null };
  const cap = lines[idx];
  const rest = lines.filter((_, i) => i !== idx);
  const target = rest.find(l => l.baseline > cap.top && l.x0 >= cap.x1 - 1);
  if (!target) return { lines, dropcap: null };
  return { lines: rest, dropcap: { letter: lineText(cap), line: target } };
}

const SENTENCE_END_RE = /[.!?:…"”’»)\]]$/u;

function segmentParagraphs(rawLines) {
  if (!rawLines.length) return [];
  const merged = mergeSameBaseline(rawLines);
  const { lines, dropcap } = extractDropCap(merged);
  const em = median(lines.map(l => l.size)) || 10;
  const leftEdge = leftEdgeOf(lines);
  const rightEdge = Math.max(...lines.map(l => l.x1));

  const pitches = [];
  for (let i = 1; i < lines.length; i++) {
    const a = lines[i - 1];
    const b = lines[i];
    const ratio = b.size / a.size;
    const diff = b.baseline - a.baseline;
    if (ratio > 0.9 && ratio < 1.1 && diff > 0) pitches.push(diff);
  }
  const pitch = median(pitches);

  const paragraphs = [];
  let current = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const prev = lines[i - 1];
    const text = lineText(line);
    const bullet = BULLET_RE.test(text);
    let newParagraph = !current;
    if (!newParagraph) {
      const ratio = line.size / current.size;
      const sizeChange = ratio > 1.15 || ratio < 0.87;
      const weightChange = line.bold !== prev.bold;
      const gap = line.baseline - prev.baseline;
      const expected = pitch || line.size * 1.25;
      const bigGap = gap > expected * 1.45;
      const indent =
        !current.list && line.x0 > leftEdge + 0.8 * em && prev.x0 <= leftEdge + 0.5 * em;
      const prevShort = prev.x1 < rightEdge - 2 * em && SENTENCE_END_RE.test(lineText(prev));
      newParagraph = sizeChange || weightChange || bigGap || bullet || indent || prevShort;
    }
    if (newParagraph) {
      current = { kind: "para", lines: [], size: line.size, list: bullet, dropcap: null };
      paragraphs.push(current);
    }
    current.lines.push(line);
    if (dropcap && dropcap.line === line && current.lines.length === 1) current.dropcap = dropcap.letter;
  }

  for (const p of paragraphs) {
    let chars = 0;
    let weighted = 0;
    for (const l of p.lines) {
      chars += l.chars;
      weighted += l.chars * l.size;
    }
    p.size = chars ? weighted / chars : p.lines[0].size;
    p.chars = chars;
    p.bold = p.lines.every(l => l.bold);
    p.italic = p.lines.every(l => l.italic);
    p.x0 = Math.min(...p.lines.map(l => l.x0));
    p.x1 = Math.max(...p.lines.map(l => l.x1));
  }
  return paragraphs;
}

/** Turns a leaf into an ordered list of paragraphs and figures. */
function buildBlocks(leaf) {
  const items = [...leaf.boxes].sort((a, b) => a.top - b.top || a.x0 - b.x0);
  const blocks = [];
  let pending = [];
  const flush = () => {
    if (pending.length) blocks.push(...segmentParagraphs(pending));
    pending = [];
  };
  for (const box of items) {
    if (box.kind === "image") {
      flush();
      blocks.push({ kind: "image", image: box.item });
    } else {
      pending.push(box.item);
    }
  }
  flush();
  return blocks;
}

function attachBlocks(node) {
  if (node.type === "leaf") node.blocks = buildBlocks(node);
  else node.children.forEach(attachBlocks);
}

/* -------------------------------------------------------------------------- */
/* Entry point                                                                */
/* -------------------------------------------------------------------------- */

function textCoverage(image, lines) {
  const area = (image.x1 - image.x0) * (image.bottom - image.top);
  if (!(area > 0)) return 0;
  let covered = 0;
  for (const l of lines) {
    const w = Math.min(l.x1, image.x1) - Math.max(l.x0, image.x0);
    const h = Math.min(l.bottom, image.bottom) - Math.max(l.top, image.top);
    if (w > 0 && h > 0) covered += w * h;
  }
  return covered / area;
}

/**
 * @param {object} page   output of extractPage, with `drop` flags and `src` on images
 * @returns {{number, width, height, tree, bounds, underlays}}
 */
export function layoutPage(page) {
  const spans = page.spans.filter(s => !s.drop);
  const lines = buildLines(spans);
  const images = page.images.filter(i => !i.drop && i.src);

  // Images with lots of text printed over them (textures, maps behind text) cannot take part in the
  // cut: they would block every gutter. They are rendered separately, before the page content.
  const underlays = [];
  const inline = [];
  for (const image of images) (textCoverage(image, lines) > 0.08 ? underlays : inline).push(image);

  const boxes = [...lines.map(lineBox), ...inline.map(imageBox)];
  const tree = boxes.length ? simplify(cut(boxes)) : null;
  if (tree) attachBlocks(tree);
  return {
    number: page.number,
    width: page.width,
    height: page.height,
    bounds: tree?.box ?? { x0: 0, x1: page.width, top: 0, bottom: page.height },
    tree,
    underlays
  };
}
