import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import { createCanvas } from "@napi-rs/canvas";
import { convertPdf } from "../scripts/core/convert.js";
import { parsePageRange } from "../scripts/core/util.js";
import { removeBackground } from "../scripts/core/raster.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const pdfjsDir = path.join(here, "../node_modules/pdfjs-dist");

async function convert(name, options = {}) {
  const images = [];
  const result = await convertPdf(pdfjs, new Uint8Array(fs.readFileSync(path.join(here, "fixtures", name))), {
    documentParams: {
      standardFontDataUrl: path.join(pdfjsDir, "standard_fonts/"),
      cMapUrl: path.join(pdfjsDir, "cmaps/"),
      cMapPacked: true,
      verbosity: 0
    },
    createCanvas,
    saveImage: async (canvas, info) => {
      const ctx = canvas.getContext("2d");
      const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      let transparent = 0;
      for (let i = 3; i < data.length; i += 4) if (data[i] === 0) transparent++;
      const id = images.length;
      images.push({ ...info, width: canvas.width, height: canvas.height, transparentRatio: transparent / (data.length / 4) });
      return { src: `img/${id}.webp`, key: `k${id}` };
    },
    ...options
  });
  return { result, images };
}

test("two-column pages keep two columns and reading order", async () => {
  const { result } = await convert("two-columns.pdf");
  assert.equal(result.pages.length, 3);
  const page = result.pages[0];
  assert.equal(page.name, "Capitulo 1: A Jornada");
  assert.match(page.html, /^<div class="pdfj-page"><h1>Capitulo 1: A Jornada<\/h1><div class="pdfj-cols pdfj-cols-2"/);
  assert.equal((page.html.match(/class="pdfj-col"/g) ?? []).length, 2);
  assert.match(page.html, /<h2>Secao de Regras<\/h2>/);
  // Left column starts with "Lorem", right column ends with the reversed first paragraph.
  const [left, right] = page.html.split('<div class="pdfj-col">').slice(1);
  assert.match(left, /^<p>Lorem ipsum/);
  assert.match(right, /<h2>Secao de Regras<\/h2><p>Lorem ipsum/);
});

test("running headers and page numbers are removed", async () => {
  const { result } = await convert("two-columns.pdf");
  for (const page of result.pages) {
    assert.doesNotMatch(page.html, /Manual do Aventureiro/);
    assert.doesNotMatch(page.html, /<p>\d+<\/p>/);
  }
});

test("three columns are detected", async () => {
  const { result } = await convert("three-columns.pdf");
  const html = result.pages[0].html;
  assert.match(html, /pdfj-cols pdfj-cols-3/);
  assert.match(html, /<h1>Bestiario<\/h1>/);
  assert.match(html, /<em>Criaturas das terras do norte<\/em>/);
  for (const n of [1, 2, 3]) assert.match(html, new RegExp(`<h\\d>Criatura ${n}</h\\d>`));
});

test("images: alpha kept, flat background removed, photo untouched", async () => {
  const { images } = await convert("two-columns.pdf");
  const { images: photos } = await convert("three-columns.pdf");
  const alpha = images.find(i => i.page === 1);
  const flat = images.find(i => i.page === 2);
  assert.ok(alpha.transparentRatio > 0.15, "PNG alpha preserved");
  assert.ok(flat.transparentRatio > 0.3, "white background removed");
  assert.equal(photos[0].transparentRatio, 0, "photo kept rectangular");
});

test("images can be disabled", async () => {
  const { result, images } = await convert("two-columns.pdf", { images: false });
  assert.equal(images.length, 0);
  assert.doesNotMatch(result.pages.map(p => p.html).join(""), /<img/);
});

test("page ranges", () => {
  assert.deepEqual(parsePageRange("", 3), [1, 2, 3]);
  assert.deepEqual(parsePageRange("2-4, 7", 10), [2, 3, 4, 7]);
  assert.deepEqual(parsePageRange("8-", 10), [8, 9, 10]);
});

test("removeBackground keeps enclosed areas", () => {
  const w = 20;
  const h = 20;
  const data = new Uint8ClampedArray(w * h * 4).fill(255);
  // Black ring with a white hole in the middle.
  for (let y = 5; y < 15; y++) {
    for (let x = 5; x < 15; x++) {
      const inner = x >= 8 && x < 12 && y >= 8 && y < 12;
      if (!inner) data.set([0, 0, 0, 255], (y * w + x) * 4);
    }
  }
  assert.equal(removeBackground({ data, width: w, height: h }), true);
  assert.equal(data[3], 0, "corner is transparent");
  assert.equal(data[(10 * w + 10) * 4 + 3], 255, "hole inside the drawing stays opaque");
});
