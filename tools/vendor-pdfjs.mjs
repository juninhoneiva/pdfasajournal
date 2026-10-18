/** Copies the pdf.js runtime from node_modules into lib/pdfjs (shipped with the module). */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const src = path.join(root, "node_modules/pdfjs-dist");
const dest = path.join(root, "lib/pdfjs");
fs.rmSync(dest, { recursive: true, force: true });
fs.mkdirSync(dest, { recursive: true });
for (const file of ["build/pdf.min.mjs", "build/pdf.worker.min.mjs", "LICENSE"]) {
  fs.copyFileSync(path.join(src, file), path.join(dest, path.basename(file)));
}
for (const dir of ["cmaps", "standard_fonts", "wasm"]) {
  fs.cpSync(path.join(src, dir), path.join(dest, dir), { recursive: true });
}
const version = JSON.parse(fs.readFileSync(path.join(src, "package.json"), "utf8")).version;
fs.writeFileSync(path.join(dest, "VERSION"), `pdfjs-dist ${version}\n`);
console.log(`pdf.js ${version} -> lib/pdfjs`);
