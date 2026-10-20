/**
 * Conversion pipeline: PDF bytes -> [{ name, html }] journal pages.
 *
 * Environment-specific work is injected through options:
 *  - createCanvas(width, height): returns a 2D canvas (DOM, OffscreenCanvas or @napi-rs/canvas)
 *  - saveImage(canvas, info): persists the image and resolves to { src, key }
 *  - onProgress({ stage, current, total })
 */

import { extractPage } from "./extract.js";
import { layoutPage } from "./layout.js";
import { computeStats, firstHeading, renderPage } from "./html.js";
import { joinContinuations } from "./continuity.js";
import { applyMask, hasTransparency, placeImage, removeBackground, sourceToCanvas } from "./raster.js";
import { parsePageRange } from "./util.js";

export const DEFAULT_OPTIONS = {
  pages: "",
  images: true,
  transparentBackgrounds: true,
  backgroundTolerance: 40,
  includePageBackgrounds: false,
  skipRepeatedImages: true,
  removeHeadersFooters: true,
  columnMode: "grid",
  groupBy: "section",
  joinHyphens: true,
  joinContinuations: true,
  maxImageSize: 2048,
  pageLabel: "Page {n}",
  documentParams: {}
};

const BAND = 0.07; // top/bottom share of the page searched for running headers and footers
const ART_TEXT_LIMIT = 300; // max body characters over a full-page image still treated as artwork
const FLAT = Symbol("flat");
const PAGE_NUMBER_RE = /^(?:\d{1,4}|[ivxlcdm]{1,7})$/i;

/* -------------------------------------------------------------------------- */
/* Headers, footers and repeated ornaments                                    */
/* -------------------------------------------------------------------------- */

function runningKey(text) {
  return text.trim().toLowerCase().replace(/\d+/g, "#").replace(/\s+/g, " ");
}

function markRunningText(pages) {
  const counts = new Map();
  const candidates = [];
  for (const page of pages) {
    const seen = new Set();
    for (const span of page.spans) {
      const center = (span.top + span.bottom) / 2;
      const inBand = center < page.height * BAND || center > page.height * (1 - BAND);
      if (!inBand) continue;
      const text = span.str.trim();
      if (PAGE_NUMBER_RE.test(text)) {
        span.drop = true;
        continue;
      }
      const key = runningKey(text);
      candidates.push([span, key]);
      if (!seen.has(key)) {
        seen.add(key);
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
    }
  }
  if (pages.length < 3) return;
  const threshold = Math.max(2, Math.ceil(pages.length * 0.25));
  for (const [span, key] of candidates) if (counts.get(key) >= threshold) span.drop = true;
}

function markRepeatedImages(pages) {
  if (pages.length < 3) return;
  const counts = new Map();
  for (const page of pages) {
    for (const key of new Set(page.images.map(i => i.key).filter(Boolean))) counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const threshold = Math.max(3, Math.ceil(pages.length * 0.4));
  for (const page of pages) for (const image of page.images) if (counts.get(image.key) >= threshold) image.drop = true;
}

/* -------------------------------------------------------------------------- */
/* Outline (PDF bookmarks) -> page names                                      */
/* -------------------------------------------------------------------------- */

async function outlineTitles(doc) {
  const titles = new Map();
  const outline = await doc.getOutline().catch(() => null);
  if (!outline) return titles;
  const visit = async (items, depth) => {
    for (const item of items) {
      try {
        let dest = item.dest;
        if (typeof dest === "string") dest = await doc.getDestination(dest);
        if (Array.isArray(dest) && dest[0]) {
          const index = typeof dest[0] === "number" ? dest[0] : await doc.getPageIndex(dest[0]);
          const number = index + 1;
          const existing = titles.get(number);
          if (!existing || depth < existing.depth) titles.set(number, { title: item.title?.trim(), depth });
        }
      } catch {
        // Broken destination: ignore the entry.
      }
      if (item.items?.length) await visit(item.items, depth + 1);
    }
  };
  await visit(outline, 0);
  return titles;
}

/* -------------------------------------------------------------------------- */
/* Images                                                                     */
/* -------------------------------------------------------------------------- */

/** Characters of body text (outside header/footer bands) whose center lies inside the box. */
function textCharsInside(page, box) {
  let chars = 0;
  for (const span of page.spans) {
    const cx = (span.x0 + span.x1) / 2;
    const cy = (span.top + span.bottom) / 2;
    if (cy < page.height * BAND || cy > page.height * (1 - BAND)) continue;
    if (cx >= box.x0 && cx <= box.x1 && cy >= box.top && cy <= box.bottom) chars += span.str.trim().length;
  }
  return chars;
}

/** Plain single-color images (masks, blank fills, translucent tints) carry nothing worth keeping. */
function isFlat(imageData) {
  const data = imageData.data;
  const total = data.length >> 2;
  const step = Math.max(1, Math.floor(total / 50000));
  let n = 0;
  let sum = 0;
  let sumSq = 0;
  let transparent = 0;
  let partial = 0;
  let sampled = 0;
  for (let i = 0; i < total; i += step) {
    const k = i * 4;
    const alpha = data[k + 3];
    sampled++;
    if (alpha <= 8) {
      transparent++;
      continue; // fully transparent pixels carry no color
    }
    if (alpha < 240) partial++;
    const lum = 0.299 * data[k] + 0.587 * data[k + 1] + 0.114 * data[k + 2];
    sum += lum;
    sumSq += lum * lum;
    n++;
  }
  if (!n) return true;
  const mean = sum / n;
  const std = Math.sqrt(Math.max(0, sumSq / n - mean * mean));
  if (std >= 4) return false;
  // One color. A crisp silhouette (icon, shaped shadow) is content; a blank fill or a translucent
  // tint (white haze behind a column) is not.
  const silhouette = transparent / sampled > 0.05 && partial / n < 0.3;
  return !silhouette;
}

/**
 * Full-page images are either backgrounds (paper textures, often spanning a two-page spread) or a
 * full-page illustration. An image counts as artwork when it fits the page and little body text is
 * printed over it; when several qualify, the one painted last (on top) wins.
 */
function classifyImages(page) {
  const pageArea = page.width * page.height;
  for (const image of page.images) {
    const w = Math.min(image.x1, page.width) - Math.max(image.x0, 0);
    const h = Math.min(image.bottom, page.height) - Math.max(image.top, 0);
    image.visibleArea = w > 0 && h > 0 ? w * h : 0;
    if (image.visibleArea < pageArea * 0.8) {
      image.role = "inline";
      continue;
    }
    const spread = image.x1 - image.x0 > page.width * 1.15 || image.bottom - image.top > page.height * 1.15;
    image.role = !spread && textCharsInside(page, image) < ART_TEXT_LIMIT ? "art" : "background";
  }
}

/** Decodes, places, masks and (optionally) cuts out the background of one image. */
function renderImage(image, options, isBackground) {
  const source = sourceToCanvas(image.source, options.createCanvas);
  const canvas = source && placeImage(source, image, options.createCanvas, { maxDimension: options.maxImageSize });
  if (!canvas) return null;
  let masked = false;
  for (const mask of image.masks ?? []) masked = applyMask(canvas, image, mask, options.createCanvas) || masked;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  const data = ctx.getImageData(0, 0, canvas.width, canvas.height);
  if (isFlat(data)) return FLAT;
  let transparent = masked || hasTransparency(data);
  if (options.transparentBackgrounds && !isBackground && !transparent) {
    if (removeBackground(data, { tolerance: options.backgroundTolerance })) {
      ctx.putImageData(data, 0, 0);
      transparent = true;
    }
  }
  // Masked artwork that stays mostly see-through is a faded decoration (engravings behind text).
  let faint = false;
  if (masked) {
    let alpha = 0;
    const step = Math.max(1, Math.floor(data.data.length / 4 / 50000));
    let n = 0;
    for (let k = 3; k < data.data.length; k += 4 * step, n++) alpha += data.data[k];
    faint = alpha / n < 0.3 * 255;
  }
  return { canvas, transparent, faint };
}

function cacheKeyOf(image) {
  if (!image.objId) return null;
  const m = image.matrix;
  const size = `${Math.round(image.x1 - image.x0)}x${Math.round(image.bottom - image.top)}`;
  const orientation = `${Math.sign(m[0])}${Math.sign(m[1])}${Math.sign(m[2])}${Math.sign(m[3])}`;
  const mask = (image.masks ?? []).map(m => m.layers.map(l => l.objId).join(",")).join("/");
  return `${image.objId}|${size}|${orientation}|${mask}`;
}

function overlapRatio(a, b) {
  const w = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0);
  const h = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
  if (w <= 0 || h <= 0) return 0;
  const smaller = Math.min((a.x1 - a.x0) * (a.bottom - a.top), (b.x1 - b.x0) * (b.bottom - b.top));
  return smaller > 0 ? (w * h) / smaller : 0;
}

/** Groups images that overlap on the page (fanned cards, a photo inside its frame). */
function overlapGroups(images) {
  const parent = images.map((_, i) => i);
  const find = i => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  for (let i = 0; i < images.length; i++) {
    for (let j = i + 1; j < images.length; j++) {
      if (overlapRatio(images[i], images[j]) >= 0.2) parent[find(j)] = find(i);
    }
  }
  const groups = new Map();
  images.forEach((image, i) => {
    const root = find(i);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(image);
  });
  return [...groups.values()];
}

/** Paints the rendered members of a group, in page order, on one canvas covering them all. */
function composite(members, options) {
  const box = {
    x0: Math.min(...members.map(m => m.x0)),
    x1: Math.max(...members.map(m => m.x1)),
    top: Math.min(...members.map(m => m.top)),
    bottom: Math.max(...members.map(m => m.bottom))
  };
  let scale = Math.max(...members.map(m => m.rendered.canvas.width / (m.x1 - m.x0)));
  const largest = Math.max(box.x1 - box.x0, box.bottom - box.top) * scale;
  if (largest > options.maxImageSize) scale *= options.maxImageSize / largest;
  const canvas = options.createCanvas(
    Math.max(1, Math.round((box.x1 - box.x0) * scale)),
    Math.max(1, Math.round((box.bottom - box.top) * scale))
  );
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.imageSmoothingEnabled = true;
  if ("imageSmoothingQuality" in ctx) ctx.imageSmoothingQuality = "high";
  for (const m of members) {
    ctx.drawImage(
      m.rendered.canvas,
      (m.x0 - box.x0) * scale,
      (m.top - box.top) * scale,
      (m.x1 - m.x0) * scale,
      (m.bottom - m.top) * scale
    );
  }
  return { ...box, canvas, transparent: true, faint: members.every(m => m.rendered.faint) };
}

async function processImages(page, options, cache) {
  const pageArea = page.width * page.height;
  classifyImages(page);
  let index = 0;

  // 1. Selection. Walk from the top layer down so the first usable "art" image is the visible one.
  const selected = [];
  let artKept = false;
  for (const image of [...page.images].reverse()) {
    const area = image.visibleArea;
    if (!(area > 0)) continue; // outside the page
    const w = Math.min(image.x1, page.width) - Math.max(image.x0, 0);
    const h = Math.min(image.bottom, page.height) - Math.max(image.top, 0);
    if (area < pageArea * 0.002 || Math.min(w, h) < 12) continue; // specks, rules, tiny ornaments
    if (image.role === "art" && artKept) continue;
    if (image.role === "background" && !options.includePageBackgrounds) continue;
    if (image.role === "art") {
      const rendered = renderImage(image, options, false);
      if (!rendered || rendered === FLAT) continue;
      image.rendered = rendered;
      artKept = true;
    }
    selected.push(image);
  }
  selected.reverse(); // back to painting order

  // The same image painted twice at the same place (a common trick for denser shadows) is one image.
  const seen = new Set();
  for (let i = selected.length - 1; i >= 0; i--) {
    const im = selected[i];
    const sig = im.objId ? `${im.objId}|${[im.x0, im.top, im.x1, im.bottom].map(Math.round).join(",")}` : null;
    if (sig && seen.has(sig)) selected.splice(i, 1);
    else if (sig) seen.add(sig);
  }

  // 2. Overlapping inline images are composed into a single figure. Images that overlap another one
  // are rendered first: faded decorations (engravings behind the text) must stay out of the group.
  const inline = selected.filter(i => i.role === "inline");
  const candidates = inline.filter(a => inline.some(b => a !== b && overlapRatio(a, b) >= 0.2));
  for (const image of candidates) {
    const rendered = renderImage(image, options, false);
    image.rendered = rendered;
  }
  const groupable = candidates.filter(i => i.rendered && i.rendered !== FLAT && !i.rendered.faint);
  const units = [];
  for (const image of selected) {
    if (image.role !== "inline") units.push([image]);
    else if (!groupable.includes(image) && image.rendered !== FLAT && image.rendered !== null) units.push([image]);
  }
  units.push(...overlapGroups(groupable));

  // 3. Save.
  const kept = [];
  for (const unit of units) {
    const isBackground = unit[0].role === "background";
    let saved;
    let box;
    if (unit.length === 1) {
      const image = unit[0];
      const key = cacheKeyOf(image);
      saved = key ? cache.get(key) : null;
      if (saved === FLAT) continue;
      if (!saved) {
        const rendered = image.rendered ?? renderImage(image, options, isBackground);
        if (!rendered || rendered === FLAT) {
          if (key && rendered === FLAT) cache.set(key, FLAT);
          continue;
        }
        saved = await options.saveImage(rendered.canvas, { page: page.number, index: index++, transparent: rendered.transparent });
        if (!saved?.src) continue;
        saved = { ...saved, faint: rendered.faint };
        if (key) cache.set(key, saved);
      }
      box = image;
    } else {
      const members = unit.filter(image => image.rendered && image.rendered !== FLAT);
      if (!members.length) continue;
      const result = members.length === 1 ? { ...members[0], ...members[0].rendered } : composite(members, options);
      saved = await options.saveImage(result.canvas, { page: page.number, index: index++, transparent: result.transparent });
      if (!saved?.src) continue;
      saved = { ...saved, faint: !!result.faint };
      box = result;
    }
    const first = unit[0];
    kept.push({
      x0: Math.max(box.x0, 0),
      x1: Math.min(box.x1, page.width),
      top: Math.max(box.top, 0),
      bottom: Math.min(box.bottom, page.height),
      src: saved.src,
      key: saved.key ?? saved.src,
      background: isBackground,
      faint: !!saved.faint,
      art: first.role === "art",
      order: page.images.indexOf(first)
    });
  }
  kept.sort((a, b) => a.order - b.order);
  page.images = kept;
}

/* -------------------------------------------------------------------------- */
/* Journal pages: one per PDF page, or one per book section                   */
/* -------------------------------------------------------------------------- */

const SECTION_LEAD = 150; // body characters allowed before a heading that still opens the page

function pageEntry(layout, stats, outline, options) {
  const heading = firstHeading(layout, stats);
  const name = outline.get(layout.number)?.title || heading?.text || options.pageLabel.replace("{n}", layout.number);
  return {
    number: layout.number,
    numbers: [layout.number],
    name,
    // When the name is the page's own first heading, showing the journal page title would repeat it.
    showTitle: name !== heading?.text,
    html: renderPage(layout, stats, options)
  };
}

/**
 * A new section starts on a page with a PDF bookmark, or whose first heading opens the page.
 * Pages without one are appended to the current section, so the journal follows the book's own
 * titles instead of page numbers. Headings in the middle of a page stay inside it and show up in
 * the page's table of contents.
 */
function groupSections(layouts, stats, outline, options) {
  const sections = [];
  for (const layout of layouts) {
    const heading = firstHeading(layout, stats);
    const bookmark = outline.get(layout.number)?.title;
    const opens = heading && heading.charsBefore <= SECTION_LEAD;
    const current = sections.at(-1);
    if (current && !bookmark && !opens) {
      current.numbers.push(layout.number);
      current.layouts.push(layout);
      continue;
    }
    const name = bookmark || (opens ? heading.text : null) || options.pageLabel.replace("{n}", layout.number);
    sections.push({
      number: layout.number,
      numbers: [layout.number],
      name,
      showTitle: !(opens && name === heading.text),
      untitled: !bookmark && !opens,
      layouts: [layout]
    });
  }
  // An untitled first page (a chapter's opening illustration, or a range starting mid-section)
  // belongs to the section that follows.
  if (sections.length > 1 && sections[0].untitled) {
    const [first, next] = sections;
    next.layouts.unshift(...first.layouts);
    next.numbers.unshift(...first.numbers);
    next.number = first.number;
    sections.shift();
  }
  return sections.map(({ layouts: pages, untitled, ...section }) => {
    if (options.joinContinuations) {
      joinContinuations(pages, stats, { acrossColumns: options.columnMode === "flow" });
    }
    return { ...section, html: pages.map(layout => renderPage(layout, stats, options)).join("") };
  });
}

/* -------------------------------------------------------------------------- */
/* Main entry                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * @param {object} pdfjs         the pdf.js module namespace
 * @param {Uint8Array} data      PDF bytes
 * @param {object} userOptions   see DEFAULT_OPTIONS plus createCanvas/saveImage/onProgress
 */
export async function convertPdf(pdfjs, data, userOptions = {}) {
  const options = { ...DEFAULT_OPTIONS, ...userOptions };
  if (options.images && (!options.createCanvas || !options.saveImage)) options.images = false;
  const progress = options.onProgress ?? (() => {});

  const task = pdfjs.getDocument({ data, isEvalSupported: false, disableFontFace: true, ...options.documentParams });
  const doc = await task.promise;
  try {
    const metadata = await doc.getMetadata().catch(() => null);
    const outline = await outlineTitles(doc);
    const numbers = parsePageRange(options.pages, doc.numPages);
    const pages = [];
    const imageCache = new Map();

    for (const [i, number] of numbers.entries()) {
      progress({ stage: "read", current: i + 1, total: numbers.length });
      const pdfPage = await doc.getPage(number);
      try {
        const page = await extractPage(pdfjs, pdfPage, { images: options.images });
        if (options.images) await processImages(page, options, imageCache);
        else page.images = [];
        pages.push(page);
      } finally {
        pdfPage.cleanup();
      }
    }

    progress({ stage: "layout", current: 0, total: pages.length });
    if (options.removeHeadersFooters) markRunningText(pages);
    if (options.skipRepeatedImages) markRepeatedImages(pages);

    const layouts = pages.map(layoutPage);
    const stats = computeStats(layouts);
    const result = options.groupBy === "page"
      ? layouts.map(layout => pageEntry(layout, stats, outline, options))
      : groupSections(layouts, stats, outline, options);

    const title = metadata?.info?.Title?.trim() || null;
    return { title, numPages: doc.numPages, stats, pages: result };
  } finally {
    await doc.destroy();
  }
}
