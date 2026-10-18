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
  joinHyphens: true,
  maxImageSize: 2048,
  pageLabel: "Page {n}",
  documentParams: {}
};

const BAND = 0.07; // top/bottom share of the page searched for running headers and footers
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
      const inBand = span.bottom < page.height * BAND || span.top > page.height * (1 - BAND);
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

async function processImages(page, options, cache) {
  const pageArea = page.width * page.height;
  const kept = [];
  let index = 0;
  for (const image of page.images) {
    const w = Math.min(image.x1, page.width) - Math.max(image.x0, 0);
    const h = Math.min(image.bottom, page.height) - Math.max(image.top, 0);
    if (!(w > 0 && h > 0)) continue; // outside the page
    const area = w * h;
    if (area < pageArea * 0.002 || Math.min(w, h) < 12) continue; // specks, rules, tiny ornaments
    const isBackground = area >= pageArea * 0.8;
    if (isBackground && !options.includePageBackgrounds) continue;

    const m = image.matrix;
    const cacheKey = image.objId
      ? `${image.objId}|${Math.round(image.x1 - image.x0)}x${Math.round(image.bottom - image.top)}|${Math.sign(m[0])}${Math.sign(m[1])}${Math.sign(m[2])}${Math.sign(m[3])}`
      : null;
    let saved = cacheKey ? cache.get(cacheKey) : null;
    if (!saved) {
      const source = sourceToCanvas(image.source, options.createCanvas);
      const canvas = source && placeImage(source, image, options.createCanvas, { maxDimension: options.maxImageSize });
      if (!canvas) continue;
      let transparent = false;
      if (options.transparentBackgrounds && !isBackground) {
        const ctx = canvas.getContext("2d", { willReadFrequently: true });
        const data = ctx.getImageData(0, 0, canvas.width, canvas.height);
        transparent = hasTransparency(data);
        if (!transparent && removeBackground(data, { tolerance: options.backgroundTolerance })) {
          ctx.putImageData(data, 0, 0);
          transparent = true;
        }
      }
      saved = await options.saveImage(canvas, { page: page.number, index: index++, transparent });
      if (!saved?.src) continue;
      if (cacheKey) cache.set(cacheKey, saved);
    }
    kept.push({
      x0: image.x0,
      x1: image.x1,
      top: image.top,
      bottom: image.bottom,
      src: saved.src,
      key: saved.key ?? saved.src,
      background: isBackground
    });
  }
  page.images = kept;
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
    const result = layouts.map(layout => {
      const heading = firstHeading(layout, stats);
      const name = outline.get(layout.number)?.title || heading || options.pageLabel.replace("{n}", layout.number);
      // When the name is the page's own first heading, showing the journal page title would repeat it.
      const showTitle = name !== heading;
      return { number: layout.number, name, showTitle, html: renderPage(layout, stats, options) };
    });

    const title = metadata?.info?.Title?.trim() || null;
    return { title, numPages: doc.numPages, stats, pages: result };
  } finally {
    await doc.destroy();
  }
}
