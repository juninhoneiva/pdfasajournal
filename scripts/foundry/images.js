/** Canvas creation, encoding and upload of extracted images to the Foundry file storage. */

import { hashBytes } from "../core/util.js";

export function createCanvas(width, height) {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

function filePicker() {
  return foundry.applications?.apps?.FilePicker?.implementation ?? globalThis.FilePicker;
}

async function encode(canvas, format, quality) {
  const blob = await new Promise(resolve => canvas.toBlob(resolve, format, quality));
  if (blob) return blob;
  return new Promise(resolve => canvas.toBlob(resolve, "image/png"));
}

/** Creates every missing folder of `path` (FilePicker.createDirectory is not recursive). */
export async function ensureDirectory(source, path) {
  const FP = filePicker();
  let current = "";
  for (const part of path.split("/").filter(Boolean)) {
    current = current ? `${current}/${part}` : part;
    try {
      await FP.browse(source, current);
    } catch {
      try {
        await FP.createDirectory(source, current, {});
      } catch (err) {
        // Another call may have created it in the meantime; the upload will report real failures.
        console.debug("pdf-as-journal | createDirectory", current, err);
      }
    }
  }
}

/**
 * Returns a saveImage(canvas, info) function for convertPdf. Identical images are uploaded once
 * (file name = content hash), so re-importing the same PDF overwrites instead of duplicating.
 */
export function makeUploader({ source, directory, format = "image/webp", quality = 0.9 }) {
  const FP = filePicker();
  const uploaded = new Map();
  let ready = null;
  return async canvas => {
    ready ??= ensureDirectory(source, directory);
    await ready;
    const blob = await encode(canvas, format, quality);
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const key = hashBytes(bytes);
    if (uploaded.has(key)) return uploaded.get(key);
    const ext = blob.type === "image/webp" ? "webp" : blob.type === "image/jpeg" ? "jpg" : "png";
    const file = new File([blob], `img-${key}.${ext}`, { type: blob.type });
    const response = await FP.upload(source, directory, file, {}, { notify: false });
    const src = response?.path ?? `${directory}/${file.name}`;
    const result = { src, key };
    uploaded.set(key, result);
    return result;
  };
}
