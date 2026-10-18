/**
 * Dev tool: converts a PDF with the same core used in Foundry and writes an HTML preview.
 *   node tools/preview.mjs file.pdf out-dir [pages]
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import { createCanvas } from "@napi-rs/canvas";
import { convertPdf } from "../scripts/core/convert.js";
import { hashBytes } from "../scripts/core/util.js";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const [file, outDir, pages = ""] = process.argv.slice(2);
if (!file || !outDir) {
  console.error("usage: node tools/preview.mjs file.pdf out-dir [pages]");
  process.exit(1);
}
fs.mkdirSync(path.join(outDir, "img"), { recursive: true });
const pdfjsDir = path.join(root, "node_modules/pdfjs-dist");

const result = await convertPdf(pdfjs, new Uint8Array(fs.readFileSync(file)), {
  pages,
  documentParams: {
    standardFontDataUrl: path.join(pdfjsDir, "standard_fonts/"),
    cMapUrl: path.join(pdfjsDir, "cmaps/"),
    cMapPacked: true,
    wasmUrl: path.join(pdfjsDir, "wasm/"),
    verbosity: 0
  },
  createCanvas,
  saveImage: async canvas => {
    const bytes = await canvas.encode("webp", 90);
    const key = hashBytes(bytes);
    fs.writeFileSync(path.join(outDir, "img", `${key}.webp`), bytes);
    return { src: `img/${key}.webp`, key };
  },
  onProgress: p => process.stderr.write(`\r${p.stage} ${p.current}/${p.total}   `)
});
process.stderr.write("\n");

const css = fs.readFileSync(path.join(root, "styles/pdf-as-journal.css"), "utf8");
const body = result.pages
  .map(p => `<article class="journal-page"><h1 class="page-title">${p.name}</h1>${p.html}</article>`)
  .join("\n");
fs.writeFileSync(
  path.join(outDir, "index.html"),
  `<!doctype html><meta charset="utf-8"><title>${result.title ?? path.basename(file)}</title>
<style>body{font-family:Georgia,serif;background:#e8e2d6;margin:0;padding:20px}
.journal-page{background:#fdfaf3 url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='16' height='16'%3E%3Crect width='8' height='8' fill='%23f1e9d6'/%3E%3Crect x='8' y='8' width='8' height='8' fill='%23f1e9d6'/%3E%3C/svg%3E");max-width:900px;margin:0 auto 30px;padding:24px 32px;container-type:inline-size;box-shadow:0 2px 8px #0003}
.page-title{border-bottom:2px solid #7a2;margin-top:0}
${css}</style>
${body}`
);
fs.writeFileSync(path.join(outDir, "result.json"), JSON.stringify(result.pages, null, 2));
console.log(`${result.pages.length} page(s), body ${result.stats.bodySize}pt -> ${path.join(outDir, "index.html")}`);
