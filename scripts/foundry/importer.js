/** Glue between the conversion core and Foundry documents. */

import { MODULE_ID } from "../constants.js";
import { convertPdf, DEFAULT_OPTIONS } from "../core/convert.js";
import { slugify } from "../core/util.js";
import { createCanvas, makeUploader } from "./images.js";
import { documentParams, loadPdfjs } from "./pdf-loader.js";

const TEXT_FORMAT_HTML = 1;

function defaultImageDirectory() {
  return game.settings.get(MODULE_ID, "imageDirectory") || `worlds/${game.world.id}/pdf-as-journal`;
}

/**
 * Converts a PDF and creates a Journal Entry with one page per PDF page.
 *
 * @param {object} params
 * @param {ArrayBuffer|Uint8Array} params.data  PDF bytes
 * @param {string} [params.fileName]            used for the journal name and image folder
 * @param {string} [params.name]                journal name (defaults to PDF title or file name)
 * @param {string} [params.folder]              JournalEntry folder id
 * @param {object} [params.options]             conversion options (see DEFAULT_OPTIONS)
 * @param {Function} [params.onProgress]
 * @returns {Promise<JournalEntry>}
 */
export async function importPdf({ data, fileName = "document.pdf", name, folder, options = {}, onProgress }) {
  const pdfjs = await loadPdfjs();
  const baseName = fileName.replace(/\.pdf$/i, "");
  const directory = `${defaultImageDirectory()}/${slugify(name || baseName)}`;
  const source = game.settings.get(MODULE_ID, "imageSource") || "data";

  const result = await convertPdf(pdfjs, new Uint8Array(data), {
    ...DEFAULT_OPTIONS,
    ...options,
    pageLabel: game.i18n.localize("PDFJ.PageLabel"),
    documentParams: documentParams(),
    createCanvas,
    saveImage: makeUploader({ source, directory }),
    onProgress
  });

  onProgress?.({ stage: "create", current: 0, total: 1 });
  const pages = result.pages.map((page, i) => ({
    name: page.name,
    type: "text",
    sort: (i + 1) * 100000,
    title: { show: page.showTitle, level: 1 },
    text: { content: page.html, format: TEXT_FORMAT_HTML },
    flags: { [MODULE_ID]: { pdfPage: page.number } }
  }));

  const entry = await JournalEntry.implementation.create({
    name: name || result.title || baseName,
    folder: folder || null,
    pages,
    flags: { [MODULE_ID]: { source: fileName, imageDirectory: directory, importedAt: Date.now(), options } }
  });
  onProgress?.({ stage: "create", current: 1, total: 1 });
  return entry;
}
