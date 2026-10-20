/**
 * Turns page layouts into journal HTML.
 *
 * Columns become CSS grids whose tracks keep the proportions of the PDF columns ("grid" mode), or
 * CSS multi-column boxes ("flow" mode, lets text reflow when the journal window is resized).
 * Headings are inferred from font size relative to the body text of the whole document.
 */

import { escapeHtml, weightedMode } from "./util.js";
import { BULLET_RE, needsSpace } from "./layout.js";

/* -------------------------------------------------------------------------- */
/* Document statistics                                                        */
/* -------------------------------------------------------------------------- */

function* paragraphsOf(node) {
  if (!node) return;
  if (node.type === "leaf") {
    for (const block of node.blocks) if (block.kind === "para") yield block;
  } else {
    for (const child of node.children ?? []) yield* paragraphsOf(child);
  }
}

/** Body size = the font size carrying most characters. Larger sizes map to h1..h4. */
export function computeStats(layouts) {
  const histogram = new Map();
  for (const layout of layouts) {
    for (const p of paragraphsOf(layout.tree)) {
      const key = Math.round(p.size * 2) / 2;
      histogram.set(key, (histogram.get(key) ?? 0) + p.chars);
    }
  }
  const bodySize = weightedMode(histogram) ?? 10;

  const headingSizes = new Set();
  for (const layout of layouts) {
    for (const p of paragraphsOf(layout.tree)) {
      if (p.size >= bodySize * 1.18 && p.chars <= 200) headingSizes.add(Math.round(p.size * 2) / 2);
    }
  }
  // Cluster sizes closer than 6% so that 13.9pt and 14pt share a level.
  const sorted = [...headingSizes].sort((a, b) => b - a);
  const clusters = [];
  for (const size of sorted) {
    const last = clusters.at(-1);
    if (last && (last.at(-1) - size) / last.at(-1) < 0.06) last.push(size);
    else clusters.push([size]);
  }
  const levels = new Map();
  clusters.forEach((cluster, i) => cluster.forEach(size => levels.set(size, Math.min(i + 1, 4))));
  return { bodySize, levels };
}

export function headingLevel(paragraph, stats) {
  if (paragraph.chars > 200 || paragraph.size < stats.bodySize * 1.18) return 0;
  return stats.levels.get(Math.round(paragraph.size * 2) / 2) ?? 4;
}

/* -------------------------------------------------------------------------- */
/* Inline text                                                                */
/* -------------------------------------------------------------------------- */

function isSuperscript(span, line) {
  return span.size < line.size * 0.85 && span.baseline < line.baseline - 0.15 * line.size;
}

function buildRuns(paragraph, { joinHyphens = true } = {}) {
  const runs = [];
  const push = (text, style) => {
    const last = runs.at(-1);
    if (last && last.bold === style.bold && last.italic === style.italic && last.sup === style.sup) last.text += text;
    else runs.push({ text, ...style });
  };

  paragraph.lines.forEach((line, lineIndex) => {
    if (lineIndex > 0 && runs.length) {
      const last = runs.at(-1);
      const nextText = line.spans[0]?.str.trimStart() ?? "";
      if (last.text.endsWith("­")) last.text = last.text.slice(0, -1);
      else if (joinHyphens && /\p{L}-$/u.test(last.text) && /^\p{Ll}/u.test(nextText)) last.text = last.text.slice(0, -1);
      else last.text += " ";
    }
    let prev = null;
    for (const span of line.spans) {
      const style = { bold: span.bold, italic: span.italic, sup: isSuperscript(span, line) };
      if (prev && needsSpace(prev, span, line.size)) push(" ", { ...style, bold: prev.bold && span.bold, italic: prev.italic && span.italic });
      push(span.str, style);
      prev = span;
    }
  });

  for (const run of runs) run.text = run.text.replace(/\s+/g, " ");
  if (runs.length) {
    runs[0].text = runs[0].text.trimStart();
    runs.at(-1).text = runs.at(-1).text.trimEnd();
  }
  return runs.filter(r => r.text);
}

function runsToHtml(runs, { plainBold = false } = {}) {
  let html = "";
  for (const run of runs) {
    // Keep surrounding spaces outside the formatting tags.
    const lead = run.text.match(/^\s*/)[0];
    const trail = run.text.slice(lead.length).match(/\s*$/)[0];
    const core = run.text.slice(lead.length, run.text.length - trail.length);
    let inner = escapeHtml(core);
    if (core) {
      if (run.sup) inner = `<sup>${inner}</sup>`;
      if (run.italic) inner = `<em>${inner}</em>`;
      if (run.bold && !plainBold) inner = `<strong>${inner}</strong>`;
    }
    html += (lead ? " " : "") + inner + (trail ? " " : "");
  }
  return html.replace(/ {2,}/g, " ").trim();
}

/* -------------------------------------------------------------------------- */
/* Blocks                                                                     */
/* -------------------------------------------------------------------------- */

function alignmentOf(paragraph, container) {
  const width = container.x1 - container.x0;
  if (!(width > 0)) return null;
  const em = paragraph.size;
  let centered = true;
  let right = true;
  for (const line of paragraph.lines) {
    const left = line.x0 - container.x0;
    const rightGap = container.x1 - line.x1;
    if (!(left > 1.5 * em && Math.abs(left - rightGap) <= Math.max(3, 0.06 * width))) centered = false;
    if (!(rightGap <= Math.max(2, 0.02 * width) && left > 0.3 * width)) right = false;
  }
  // Justified text inset on both sides (boxed sidebars) looks centered but is not: its lines share
  // the same width, while centered text has ragged lines.
  if (centered && paragraph.lines.length >= 3) {
    const widths = paragraph.lines.map(l => l.x1 - l.x0);
    const widest = Math.max(...widths);
    const full = widths.filter(w => w >= widest * 0.97).length;
    if (full >= Math.ceil(paragraph.lines.length * 0.6)) centered = false;
  }
  if (centered) return "center";
  if (right) return "right";
  return null;
}

function alignAttrs(align, extraClass = "") {
  const classes = [extraClass, align ? `pdfj-align-${align}` : ""].filter(Boolean).join(" ");
  const cls = classes ? ` class="${classes}"` : "";
  const style = align ? ` style="text-align: ${align}"` : "";
  return cls + style;
}

function renderParagraph(paragraph, container, stats, options) {
  const runs = buildRuns(paragraph, options);
  if (!runs.length) return "";
  const align = alignmentOf(paragraph, container);
  const level = headingLevel(paragraph, stats);
  if (level) return `<h${level}${alignAttrs(align)}>${runsToHtml(runs, { plainBold: true })}</h${level}>`;

  if (paragraph.list) {
    runs[0].text = runs[0].text.replace(BULLET_RE, "");
    return `<li>${runsToHtml(runs)}</li>`;
  }

  const small = paragraph.size <= stats.bodySize * 0.85 ? "pdfj-small" : "";
  let body = runsToHtml(runs);
  if (paragraph.dropcap) body = `<span class="pdfj-dropcap">${escapeHtml(paragraph.dropcap)}</span>${body}`;
  return `<p${alignAttrs(align, small)}>${body}</p>`;
}

function renderFigure(image, container, extraClass = "", float = null) {
  const width = container.x1 - container.x0;
  const imgWidth = image.x1 - image.x0;
  const pct = width > 0 ? Math.min(100, Math.max(5, (imgWidth / width) * 100)) : 100;
  const left = image.x0 - container.x0;
  const right = container.x1 - image.x1;
  let align = "left";
  if (Math.abs(left - right) <= 0.05 * width) align = "center";
  else if (left > right) align = "right";
  if (float) {
    // The figure takes the image's share of the column; the image fills the figure.
    const classes = ["pdfj-figure", `pdfj-float-${float}`, extraClass].filter(Boolean).join(" ");
    return `<figure class="${classes}" style="width: ${pct.toFixed(1)}%"><img src="${escapeHtml(image.src)}" alt="" style="width: 100%"></figure>`;
  }
  const classes = ["pdfj-figure", `pdfj-align-${align}`, extraClass].filter(Boolean).join(" ");
  return `<figure class="${classes}"><img src="${escapeHtml(image.src)}" alt="" style="width: ${pct.toFixed(1)}%"></figure>`;
}

function renderLeaf(node, container, stats, options) {
  let html = "";
  let inList = false;
  for (const block of node.blocks) {
    const isItem = block.kind === "para" && block.list && !headingLevel(block, stats);
    if (isItem && !inList) {
      html += "<ul>";
      inList = true;
    } else if (!isItem && inList) {
      html += "</ul>";
      inList = false;
    }
    if (block.kind === "image") html += renderFigure(block.image, container, "", block.float);
    else if (block.kind === "table") html += renderTable(block, options);
    else html += renderParagraph(block, container, stats, options);
  }
  if (inList) html += "</ul>";
  return html;
}

function renderTable(node, options) {
  let html = `<table class="pdfj-table"><tbody>`;
  for (const row of node.rows) {
    html += "<tr>";
    for (let i = 0; i < node.columns; i++) {
      const cell = row.cells[i];
      html += `<td>${cell ? runsToHtml(buildRuns({ lines: cell.lines }, options)) : ""}</td>`;
    }
    html += "</tr>";
  }
  return `${html}</tbody></table>`;
}

function renderNode(node, container, stats, options) {
  if (!node) return "";
  if (node.type === "leaf") return renderLeaf(node, container, stats, options);
  if (node.type === "table") return renderTable(node, options);
  if (node.type === "rows") return node.children.map(c => renderNode(c, container, stats, options)).join("");

  // Columns
  const widths = node.children.map(c => Math.max(1, c.box.x1 - c.box.x0));
  const n = widths.length;
  const average = widths.reduce((a, b) => a + b, 0) / n;
  const even = widths.every(w => Math.abs(w - average) / average < 0.15);
  const childHtml = node.children.map(c => renderNode(c, { x0: c.box.x0, x1: c.box.x1 }, stats, options));

  if (options.columnMode === "flow" && even && n <= 4) {
    return `<div class="pdfj-flow" style="column-count: ${n}">${childHtml.join("")}</div>`;
  }
  const tracks = widths.map(w => `${(w / average).toFixed(3)}fr`).join(" ");
  const cols = childHtml.map(h => `<div class="pdfj-col">${h}</div>`).join("");
  return `<div class="pdfj-cols pdfj-cols-${n}" style="grid-template-columns: ${tracks}">${cols}</div>`;
}

/** HTML of one journal page. */
export function renderPage(layout, stats, options = {}) {
  const container = { x0: layout.bounds.x0, x1: layout.bounds.x1 };
  let html = "";
  // Images with text printed over or around them cannot sit inside a column: they go before the
  // page content when they start in its top half, after it otherwise.
  const middle = layout.height / 2;
  const before = layout.underlays.filter(i => (i.top + i.bottom) / 2 < middle);
  const after = layout.underlays.filter(i => (i.top + i.bottom) / 2 >= middle);
  for (const image of before) html += renderFigure(image, container, "pdfj-underlay");
  html += renderNode(layout.tree, container, stats, options);
  for (const image of after) html += renderFigure(image, container, "pdfj-underlay");
  const page = { x0: 0, x1: layout.width };
  for (const image of layout.fullPage ?? []) html += renderFigure(image, page, "pdfj-fullpage");
  return `<div class="pdfj-page" data-pdf-page="${layout.number}">${html}</div>`;
}

/**
 * First section heading of a page (levels 1-2), with how much body text comes before it.
 * `charsBefore` tells whether the heading opens the page or sits after text continued from the
 * previous section.
 */
export function firstHeading(layout, stats, maxLevel = 2) {
  let charsBefore = 0;
  for (const p of paragraphsOf(layout.tree)) {
    const level = headingLevel(p, stats);
    if (level && level <= maxLevel) {
      const text = buildRuns(p)
        .map(r => r.text)
        .join("")
        .replace(/\s+/g, " ")
        .replace(/[\s:;,.–—-]+$/u, "")
        .trim();
      // Ignore stray letters and numbers (decorations, drop caps, page furniture).
      if ((text.match(/\p{L}/gu) ?? []).length >= 3) {
        return { text: text.length > 80 ? `${text.slice(0, 77)}...` : text, level, charsBefore };
      }
    }
    charsBefore += p.chars;
  }
  return null;
}
