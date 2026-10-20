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
import { hasTransparency, placeImage, removeBackground, sourceToCanvas } from "./raster.js";
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

/** Plain single-color images (masks, blank fills) carry nothing worth keeping. */
function isFlat(imageData) {
  const data = imageData.data;
  const total = data.length >> 2;
  const step = Math.max(1, Math.floor(total / 50000));
  let n = 0;
  let sum = 0;
  let sumSq = 0;
  let alphaMin = 255;
  let alphaMax = 0;
  for (let i = 0; i < total; i += step) {
    const k = i * 4;
    const lum = 0.299 * data[k] + 0.587 * data[k + 1] + 0.114 * data[k + 2];
    sum += lum;
    sumSq += lum * lum;
    alphaMin = Math.min(alphaMin, data[k + 3]);
    alphaMax = Math.max(alphaMax, data[k + 3]);
    n++;
  }
  const mean = sum / n;
  const std = Math.sqrt(Math.max(0, sumSq / n - mean * mean));
  return std < 4 && alphaMax - alphaMin < 16;
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

async function processImages(page, options, cache) {
  const pageArea = page.width * page.height;
  classifyImages(page);
  const kept = [];
  let index = 0;
  let artKept = false;

  // Walk from the top layer down so the first usable "art" image found is the visible one.
  for (const image of [...page.images].reverse()) {
    const area = image.visibleArea;
    if (!(area > 0)) continue; // outside the page
    const w = Math.min(image.x1, page.width) - Math.max(image.x0, 0);
    const h = Math.min(image.bottom, page.height) - Math.max(image.top, 0);
    if (area < pageArea * 0.002 || Math.min(w, h) < 12) continue; // specks, rules, tiny ornaments
    if (image.role === "art" && artKept) continue;
    const isBackground = image.role === "background";
    if (isBackground && !options.includePageBackgrounds) continue;

    const m = image.matrix;
    const cacheKey = image.objId
      ? `${image.objId}|${Math.round(image.x1 - image.x0)}x${Math.round(image.bottom - image.top)}|${Math.sign(m[0])}${Math.sign(m[1])}${Math.sign(m[2])}${Math.sign(m[3])}`
      : null;
    let saved = cacheKey ? cache.get(cacheKey) : null;
    if (saved === FLAT) continue;
    if (!saved) {
      const source = sourceToCanvas(image.source, options.createCanvas);
      const canvas = source && placeImage(source, image, options.createCanvas, { maxDimension: options.maxImageSize });
      if (!canvas) continue;
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      const data = ctx.getImageData(0, 0, canvas.width, canvas.height);
      if (isFlat(data)) {
        if (cacheKey) cache.set(cacheKey, FLAT);
        continue;
      }
      let transparent = hasTransparency(data);
      if (options.transparentBackgrounds && !isBackground && !transparent) {
        if (removeBackground(data, { tolerance: options.backgroundTolerance })) {
          ctx.putImageData(data, 0, 0);
          transparent = true;
        }
      }
      saved = await options.saveImage(canvas, { page: page.number, index: index++, transparent });
      if (!saved?.src) continue;
      if (cacheKey) cache.set(cacheKey, saved);
    }
    if (image.role === "art") artKept = true;
    kept.push({
      x0: Math.max(image.x0, 0),
      x1: Math.min(image.x1, page.width),
      top: Math.max(image.top, 0),
      bottom: Math.min(image.bottom, page.height),
      src: saved.src,
      key: saved.key ?? saved.src,
      background: isBackground,
      art: image.role === "art"
    });
  }
  page.images = kept.reverse();
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
    const html = renderPage(layout, stats, options);
    if (current && !bookmark && !opens) {
      current.numbers.push(layout.number);
      current.html += html;
      continue;
    }
    const name = bookmark || (opens ? heading.text : null) || options.pageLabel.replace("{n}", layout.number);
    sections.push({
      number: layout.number,
      numbers: [layout.number],
      name,
      showTitle: !(opens && name === heading.text),
      html
    });
  }
  return sections;
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
