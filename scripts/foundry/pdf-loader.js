/** Loads the pdf.js copy bundled with the module (lib/pdfjs). */

const LIB = new URL("../../lib/pdfjs/", import.meta.url);
let loading = null;

export function loadPdfjs() {
  loading ??= import(new URL("pdf.min.mjs", LIB).href).then(pdfjs => {
    pdfjs.GlobalWorkerOptions.workerSrc = new URL("pdf.worker.min.mjs", LIB).href;
    return pdfjs;
  });
  return loading;
}

/** Extra getDocument() parameters pointing to the bundled fonts, cMaps and decoders. */
export function documentParams() {
  return {
    cMapUrl: new URL("cmaps/", LIB).href,
    cMapPacked: true,
    standardFontDataUrl: new URL("standard_fonts/", LIB).href,
    wasmUrl: new URL("wasm/", LIB).href,
    verbosity: 0
  };
}
