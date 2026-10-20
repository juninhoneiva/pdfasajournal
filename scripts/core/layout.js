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

/**
 * Text set vertically one letter per line (side tabs such as "S/E/R/P/E/N/T") shows up as a
 * stack of single-character spans sharing the same x center. Like rotated text, it is decoration
 * that would read as noise in the journal, so it is removed. This runs on spans, before lines are
 * built, so a tab letter sitting next to a heading is not glued to it.
 */
function dropStackedLetters(spans) {
  const singles = spans.filter(s => s.str.trim().length === 1);
  if (singles.length < 4) return spans;
  singles.sort((a, b) => a.top - b.top);
  const stacks = [];
  for (const span of singles) {
    const cx = (span.x0 + span.x1) / 2;
    const stack = stacks.find(st => {
      const last = st.at(-1);
      const lastCx = (last.x0 + last.x1) / 2;
      return Math.abs(cx - lastCx) < 0.6 * span.size && span.top - last.bottom < 1.5 * span.size && span.top > last.top;
    });
    if (stack) stack.push(span);
    else stacks.push([span]);
  }
  const drop = new Set(stacks.filter(st => st.length >= 4).flat());
  return drop.size ? spans.filter(s => !drop.has(s)) : spans;
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
  // Capped so a large title does not swallow the small gap above the text that follows it.
  const pad = INFLATE * Math.min(line.size, 10);
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

  // A heading set tight above columns (box titles) hides their gutter: peel the top lines off when
  // that reveals columns below.
  if (!cols) {
    const sorted = [...boxes].sort((a, b) => a.top - b.top);
    for (let k = 1; k <= 3 && k < sorted.length - 1; k++) {
      const top = sorted.slice(0, k);
      const rest = sorted.slice(k);
      const topBottom = Math.max(...top.map(b => b.top));
      if (rest.some(b => b.top < topBottom)) continue;
      const split = verticalSplit(rest, emOf(rest));
      if (!split) continue;
      // Only real columns: every part runs along most of the block (not a short table column).
      const restTop = Math.min(...rest.map(b => b.top));
      const restHeight = Math.max(...rest.map(b => b.bottom)) - restTop;
      const tall = split.groups.every(g => Math.max(...g.map(b => b.bottom)) - Math.min(...g.map(b => b.top)) >= 0.6 * restHeight);
      if (tall) {
        // Keep the whole heading together: following lines set in the same large size join it.
        const size = Math.min(...top.map(b => b.size || Infinity));
        while (rest.length > 2 && rest[0].kind === "line" && rest[0].size >= size * 0.9 && size > emOf(rest) * 1.15) {
          const next = rest[0];
          if (rest.slice(1).some(b => b.top < next.top)) break;
          top.push(rest.shift());
        }
        return { type: "rows", children: [cut(top, depth + 1), cut(rest, depth + 1)] };
      }
    }
  }

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
  // An image touching the text (a frame or shadow reaching into the headings) blocks every cut.
  // Take the images out, place them before or after the text, and analyse the text on its own.
  const images = boxes.filter(b => b.kind === "image");
  const text = boxes.filter(b => b.kind !== "image");
  if (images.length && text.length > 1) {
    const middle = (Math.min(...text.map(b => b.top)) + Math.max(...text.map(b => b.bottom))) / 2;
    const before = images.filter(b => (b.top + b.bottom) / 2 < middle);
    const after = images.filter(b => (b.top + b.bottom) / 2 >= middle);
    const children = [];
    if (before.length) children.push({ type: "leaf", boxes: before });
    children.push(cut(text, depth + 1));
    if (after.length) children.push({ type: "leaf", boxes: after });
    return { type: "rows", children };
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
/* Tables (stat blocks, combat lines)                                         */
/* -------------------------------------------------------------------------- */

const TABLE_MAX_CHARS = 28; // median characters per line: table cells are short
const TABLE_NARROW = 0.28; // a column narrower than this share of the text width is not prose

/** Splits a line into cells where the gap between spans is wider than a few spaces. */
function cellChunks(line) {
  const chunks = [];
  let current = null;
  for (const span of line.spans) {
    if (current && span.x0 - current.x1 <= 0.6 * line.size) {
      current.spans.push(span);
      current.x1 = Math.max(current.x1, span.x1);
    } else {
      current = { spans: [span], x0: span.x0, x1: span.x1 };
      chunks.push(current);
    }
  }
  return chunks;
}

/**
 * Builds table rows from baseline bands (arrays of line segments). Cells are aligned on the x
 * positions shared by the rows; a band filling a single cell continues the cell above.
 */
function buildTable(bands, isShared) {
  const rowsChunks = bands.map(band => [...band].sort((x, y) => x.x0 - y.x0).flatMap(line => cellChunks(line).map(c => ({ ...c, line }))));
  const starts = rowsChunks.flat().map(c => c.x0).sort((x, y) => x - y);
  const anchors = [];
  for (const x of starts) {
    if (!anchors.length || x - anchors.at(-1).last > 6) anchors.push({ x, last: x });
    else anchors.at(-1).last = x;
  }
  const columnOf = x => {
    let index = 0;
    anchors.forEach((anchor, i) => {
      if (x >= anchor.x - 3) index = i;
    });
    return index;
  };
  const rows = [];
  rowsChunks.forEach((chunks, i) => {
    const cells = anchors.map(() => null);
    for (const chunk of chunks) {
      const col = columnOf(chunk.x0);
      const line = { ...chunk.line, spans: chunk.spans, x0: chunk.x0, x1: chunk.x1 };
      (cells[col] ??= { lines: [] }).lines.push(line);
    }
    const filled = cells.filter(Boolean);
    if (filled.length === 1 && rows.length && !isShared(i)) {
      const col = cells.findIndex(Boolean);
      const above = rows.at(-1).cells;
      (above[col] ??= { lines: [] }).lines.push(...cells[col].lines);
      return;
    }
    rows.push({ cells });
  });
  return { rows, columns: anchors.length };
}

function bandsOf(lines) {
  const sorted = [...lines].sort((a, b) => a.baseline - b.baseline || a.x0 - b.x0);
  const bands = [];
  for (const line of sorted) {
    const band = bands.at(-1);
    if (band && Math.abs(line.baseline - band.baseline) <= 0.45 * line.size) band.lines.push(line);
    else bands.push({ baseline: line.baseline, lines: [line] });
  }
  return bands;
}

/**
 * A "cols" node whose columns are narrow and hold short lines sharing baselines is a table, not
 * text columns: reading it column by column would scramble it ("FOR 55 / APA 70 / DX: 0 ...").
 * Lines before the first shared baseline (a name, "Combate") stay as paragraphs.
 */
function boxesIn(node) {
  if (node.type === "leaf") return node.boxes;
  return (node.children ?? []).flatMap(boxesIn);
}

function tableFromCols(node, textWidth) {
  const columnBoxes = node.children.map(boxesIn);
  if (node.children.some(c => c.type === "table") || columnBoxes.some(bs => bs.some(b => b.kind !== "line"))) return null;
  const columns = columnBoxes.map(bs => bs.map(b => b.item));
  const all = columns.flat();
  if (all.length < 4) return null;
  if (!node.children.some(c => c.box.x1 - c.box.x0 < textWidth * TABLE_NARROW)) return null;
  if (median(all.map(l => lineText(l).length)) > TABLE_MAX_CHARS) return null;

  const colOf = new Map();
  columns.forEach((lines, col) => lines.forEach(l => colOf.set(l, col)));
  const parts = splitRuns(bandsOf(all), band => new Set(band.lines.map(l => colOf.get(l))).size >= 2);
  if (!parts.some(p => p.table)) return null;

  const children = parts.map(part => {
    if (part.table) return { type: "table", ...part.table, box: node.box };
    const boxes = part.lines.map(lineBox);
    return { type: "leaf", boxes, box: extent(boxes) };
  });
  return children.length === 1 ? children[0] : { type: "rows", children, box: node.box };
}

/**
 * Splits baseline bands into text and table parts. A table is a run of at least two "shared"
 * bands (cells side by side); inside a run, a band holding a single segment indented under a value
 * continues the cell above, while one starting at the left edge ("Combate") ends the table.
 */
function splitRuns(bands, isShared) {
  const parts = [];
  let i = 0;
  while (i < bands.length) {
    if (!isShared(bands[i])) {
      parts.push({ lines: [...bands[i].lines] });
      i++;
      continue;
    }
    const leftEdge = Math.min(...bands[i].lines.map(l => l.x0));
    let j = i;
    let shared = 0;
    while (j < bands.length) {
      const band = bands[j];
      if (isShared(band)) shared++;
      else if (!(band.lines.length === 1 && band.lines[0].x0 > leftEdge + 2 * band.lines[0].size)) break;
      j++;
    }
    const run = bands.slice(i, j);
    const segments = run.flatMap(b => b.lines);
    if (shared >= 2 && median(segments.map(l => lineText(l).length)) <= TABLE_MAX_CHARS) {
      parts.push({ table: buildTable(run.map(b => b.lines), k => isShared(run[k])) });
      i = j;
    } else {
      parts.push({ lines: [...bands[i].lines] });
      i++;
    }
  }
  const merged = [];
  for (const part of parts) {
    const last = merged.at(-1);
    if (part.lines && last?.lines) last.lines.push(...part.lines);
    else merged.push(part);
  }
  return merged;
}

/** Tables inside a single text block ("Briga ...... 70% (35/14)"). */
function splitLeafTables(lines) {
  return splitRuns(bandsOf(lines), band => band.lines.length >= 2);
}

function detectTables(node, textWidth) {
  if (!node || node.type === "leaf") return node;
  if (node.type === "cols") {
    const table = tableFromCols(node, textWidth);
    if (table) return table;
  }
  if (node.children) node.children = node.children.map(c => detectTables(c, textWidth));
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

function segmentParagraphs(rawLines, obstacles = [], bodySize = 0) {
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

  // Lines running beside a floating image are narrower: measure them against the image edge.
  const beside = l => obstacles.filter(o => l.top < o.bottom && l.bottom > o.top);
  const leftOf = l => Math.max(leftEdge, ...beside(l).filter(o => o.x1 <= l.x0 + 2).map(o => o.x1));
  // Beside an image, the reference is the longest line running along that same image.
  const rightOf = l => {
    const right = beside(l).filter(o => o.x0 >= l.x1 - 2);
    if (!right.length) return rightEdge;
    const along = lines.filter(o => right.some(r => o.top < r.bottom && o.bottom > r.top));
    return Math.max(...along.map(o => o.x1));
  };
  const indented = (line, prev) =>
    line.x0 > leftOf(line) + 0.8 * em && prev.x0 <= leftOf(prev) + 0.5 * em && line.size <= em * 1.15;
  // Books that mark paragraphs with a first-line indent do not end them with short lines: a line
  // that happens to end early inside a justified paragraph must not split it.
  let indentBreaks = 0;
  for (let i = 1; i < lines.length; i++) if (indented(lines[i], lines[i - 1])) indentBreaks++;
  const indentStyle = indentBreaks >= 2;
  // Body text is the smallest text of the block; larger lines are headings, which may wrap after
  // a colon without ending a paragraph.
  const smallest = Math.min(bodySize || Infinity, ...lines.map(l => l.size));

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
      const weightChange = line.bold !== prev.bold || line.italic !== prev.italic;
      const gap = line.baseline - prev.baseline;
      // Line spacing grows with font size: a two-line heading is not a paragraph break.
      const expected = pitch ? pitch * Math.max(1, line.size / em) : line.size * 1.25;
      const bigGap = gap > expected * 1.45;
      const indent = !current.list && indented(line, prev);
      // Short lines ending a sentence close body paragraphs; headings may break after a colon.
      const slack = beside(prev).length ? 1.2 * em : 2 * em;
      const prevShort =
        !indentStyle &&
        prev.size <= smallest * 1.15 &&
        prev.x1 < rightOf(prev) - slack &&
        SENTENCE_END_RE.test(lineText(prev));
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

/**
 * An image with text running beside it (a portrait the text wraps around) floats on that side, so
 * the paragraph it interrupts in the book stays whole in the journal.
 */
function wrapSide(image, lines, box) {
  const width = box.x1 - box.x0;
  if (!(width > 0) || image.x1 - image.x0 > width * 0.6) return null;
  const beside = lines.filter(
    l => l.top < image.bottom && l.bottom > image.top && (l.x1 <= image.x0 + 2 || l.x0 >= image.x1 - 2)
  );
  if (beside.length < 2) return null;
  return (image.x0 + image.x1) / 2 > (box.x0 + box.x1) / 2 ? "right" : "left";
}

/** Turns a leaf into an ordered list of paragraphs, tables and figures. */
function buildBlocks(leaf, bodySize) {
  const items = [...leaf.boxes].sort((a, b) => a.top - b.top || a.x0 - b.x0);
  const lines = items.filter(b => b.kind === "line").map(b => b.item);
  const obstacles = items.filter(b => b.kind === "image" && wrapSide(b.item, lines, leaf.box)).map(b => b.item);
  const floats = [];
  const blocks = [];
  let pending = [];
  const flush = () => {
    for (const part of pending.length ? splitLeafTables(pending) : []) {
      if (part.table) blocks.push({ kind: "table", ...part.table });
      else blocks.push(...segmentParagraphs(part.lines, obstacles, bodySize));
    }
    pending = [];
  };
  for (const box of items) {
    if (box.kind === "image") {
      const side = wrapSide(box.item, lines, leaf.box);
      if (side) {
        floats.push({ kind: "image", image: box.item, float: side });
        continue;
      }
      flush();
      blocks.push({ kind: "image", image: box.item });
    } else {
      pending.push(box.item);
    }
  }
  flush();

  // A floating image goes right before the first paragraph that runs beside it.
  for (const figure of floats) {
    const { image } = figure;
    const index = blocks.findIndex(
      b => b.kind === "para" && b.lines.some(l => l.bottom > image.top && l.top < image.bottom)
    );
    if (index < 0) blocks.push(figure);
    else blocks.splice(index, 0, figure);
  }
  return blocks;
}

function attachBlocks(node, bodySize) {
  if (node.type === "leaf") node.blocks = buildBlocks(node, bodySize);
  else if (node.children) node.children.forEach(child => attachBlocks(child, bodySize));
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

/** True when the image overlaps a good part of at least one text line. */
function touchesText(image, lines) {
  return lines.some(l => {
    const w = Math.min(l.x1, image.x1) - Math.max(l.x0, image.x0);
    const h = Math.min(l.bottom, image.bottom) - Math.max(l.top, image.top);
    return w > 0 && h > 0 && (w * h) / ((l.x1 - l.x0) * (l.bottom - l.top)) > 0.2;
  });
}

/** True when the image is the background of a text box: several lines sit entirely inside it. */
function isBackdrop(image, lines) {
  let inside = 0;
  let touching = 0;
  for (const l of lines) {
    const overlaps = l.x0 < image.x1 && l.x1 > image.x0 && l.top < image.bottom && l.bottom > image.top;
    if (!overlaps) continue;
    touching++;
    if (l.x0 >= image.x0 - 1 && l.x1 <= image.x1 + 1 && l.top >= image.top - 1 && l.bottom <= image.bottom + 1) inside++;
  }
  return inside >= 2 && inside >= touching * 0.6;
}

/**
 * @param {object} page   output of extractPage, with `drop` flags and `src` on images
 * @returns {{number, width, height, tree, bounds, underlays}}
 */
export function layoutPage(page) {
  const spans = page.spans.filter(s => !s.drop);
  const lines = buildLines(dropStackedLetters(spans));
  const images = page.images.filter(i => !i.drop && i.src);

  // Images with lots of text printed over them (textures, maps behind text) cannot take part in the
  // cut: they would block every gutter. They are rendered separately, before the page content.
  // Full-page artwork is shown after the page text (titles are usually printed over it).
  const underlays = [];
  const inline = [];
  const fullPage = [];
  for (const image of images) {
    if (image.art || image.background) fullPage.push(image);
    else if (touchesText(image, lines)) {
      // Images reaching into the text (box ornaments, cut-outs with text wrapped around) cannot take
      // part in the column analysis. Wide, flat ones are the borders of a boxed sidebar: dropped.
      const w = image.x1 - image.x0;
      const h = image.bottom - image.top;
      if (w / Math.max(h, 1) < 5 && !image.faint && !isBackdrop(image, lines)) underlays.push(image);
    } else if (textCoverage(image, lines) > 0.08) {
      // A faded decoration printed behind the text is part of the page design, not an illustration;
      // so is the backdrop of a boxed sidebar (text set entirely inside the image).
      if (!image.faint && !isBackdrop(image, lines)) underlays.push(image);
    } else inline.push(image);
  }

  const boxes = [...lines.map(lineBox), ...inline.map(imageBox)];
  let tree = boxes.length ? simplify(cut(boxes)) : null;
  if (tree) tree = detectTables(tree, tree.box.x1 - tree.box.x0);
  // Body size of the page: the font size carrying most characters.
  const sizes = new Map();
  for (const l of lines) sizes.set(l.size, (sizes.get(l.size) ?? 0) + l.chars);
  let bodySize = 0;
  let most = -1;
  for (const [size, chars] of sizes) if (chars > most) [bodySize, most] = [size, chars];
  if (tree) attachBlocks(tree, bodySize);
  return {
    number: page.number,
    width: page.width,
    height: page.height,
    bounds: tree?.box ?? { x0: 0, x1: page.width, top: 0, bottom: page.height },
    tree,
    underlays,
    fullPage
  };
}
