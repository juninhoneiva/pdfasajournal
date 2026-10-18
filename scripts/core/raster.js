/**
 * Pixel work: turning pdf.js image objects into canvases, applying the placement matrix
 * (rotation / flips / scale) and removing flat backgrounds to obtain transparent artwork.
 *
 * `createCanvas(width, height)` is injected so the same code runs in the browser and in Node tests.
 */

const ImageKind = { GRAYSCALE_1BPP: 1, RGB_24BPP: 2, RGBA_32BPP: 3 };

function context2d(canvas) {
  return canvas.getContext("2d", { willReadFrequently: true });
}

/** Draws the decoded pdf.js image (bitmap or raw pixel buffer) on a canvas of its native size. */
export function sourceToCanvas(source, createCanvas) {
  const width = source.width;
  const height = source.height;
  if (!(width > 0 && height > 0)) return null;
  const canvas = createCanvas(width, height);
  const ctx = context2d(canvas);

  if (source.bitmap) {
    ctx.drawImage(source.bitmap, 0, 0);
    return canvas;
  }
  const src = source.data;
  if (!src) return null;

  const imageData = ctx.createImageData(width, height);
  const dest = imageData.data;
  const pixels = width * height;
  switch (source.kind) {
    case ImageKind.RGBA_32BPP:
      dest.set(src.subarray ? src.subarray(0, pixels * 4) : src.slice(0, pixels * 4));
      break;
    case ImageKind.RGB_24BPP:
      for (let i = 0, j = 0; i < pixels; i++, j += 3) {
        const k = i * 4;
        dest[k] = src[j];
        dest[k + 1] = src[j + 1];
        dest[k + 2] = src[j + 2];
        dest[k + 3] = 255;
      }
      break;
    case ImageKind.GRAYSCALE_1BPP: {
      const rowBytes = (width + 7) >> 3;
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          const bit = src[y * rowBytes + (x >> 3)] & (128 >> (x & 7));
          const k = (y * width + x) * 4;
          const v = bit ? 255 : 0;
          dest[k] = dest[k + 1] = dest[k + 2] = v;
          dest[k + 3] = 255;
        }
      }
      break;
    }
    default:
      return null;
  }
  ctx.putImageData(imageData, 0, 0);
  return canvas;
}

/**
 * Renders the image exactly as it appears on the page (orientation included) into a new canvas
 * whose resolution matches the native pixel density of the image, capped at `maxDimension`.
 */
export function placeImage(sourceCanvas, placed, createCanvas, { maxDimension = 2048 } = {}) {
  const w = sourceCanvas.width;
  const h = sourceCanvas.height;
  const boxW = placed.x1 - placed.x0;
  const boxH = placed.bottom - placed.top;
  if (!(boxW > 0 && boxH > 0)) return null;

  let scale = Math.sqrt((w * h) / (boxW * boxH));
  const largest = Math.max(boxW, boxH) * scale;
  if (largest > maxDimension) scale *= maxDimension / largest;
  const outW = Math.max(1, Math.round(boxW * scale));
  const outH = Math.max(1, Math.round(boxH * scale));

  const [a, b, c, d, e, f] = placed.matrix;
  const out = createCanvas(outW, outH);
  const ctx = context2d(out);
  ctx.imageSmoothingEnabled = true;
  if ("imageSmoothingQuality" in ctx) ctx.imageSmoothingQuality = "high";
  ctx.setTransform(
    (scale * a) / w,
    (scale * b) / w,
    (-scale * c) / h,
    (-scale * d) / h,
    scale * (c + e - placed.x0),
    scale * (d + f - placed.top)
  );
  ctx.drawImage(sourceCanvas, 0, 0);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  return out;
}

/** True when a noticeable share of pixels is already (semi)transparent. */
export function hasTransparency(imageData, threshold = 0.005) {
  const data = imageData.data;
  const total = data.length >> 2;
  const step = Math.max(1, Math.floor(total / 200000));
  let seen = 0;
  let transparent = 0;
  for (let i = 0; i < total; i += step) {
    seen++;
    if (data[i * 4 + 3] < 250) transparent++;
  }
  return transparent / seen > threshold;
}

function colorDistance(data, k, bg) {
  const dr = data[k] - bg[0];
  const dg = data[k + 1] - bg[1];
  const db = data[k + 2] - bg[2];
  return Math.sqrt(dr * dr + dg * dg + db * db);
}

/**
 * Makes the flat background of an artwork transparent.
 *
 * The background color is the dominant color of the image border. Only pixels connected to the
 * border (flood fill) are removed, so white areas inside the drawing (eyes, highlights) survive.
 * The first ring of pixels around the drawing is feathered and "un-blended" from the background
 * color, which avoids the halo that a hard cut leaves on anti-aliased edges.
 *
 * Returns false (and leaves the pixels untouched) when the border is not uniform, i.e. the image is
 * a photo or a framed illustration that should stay rectangular.
 */
export function removeBackground(imageData, { tolerance = 40, minBorderUniformity = 0.6 } = {}) {
  const { data, width: w, height: h } = imageData;
  if (w < 4 || h < 4) return false;

  const border = [];
  for (let x = 0; x < w; x++) border.push(x, (h - 1) * w + x);
  for (let y = 1; y < h - 1; y++) border.push(y * w, y * w + w - 1);

  const buckets = new Map();
  for (const p of border) {
    const k = p * 4;
    if (data[k + 3] < 128) continue;
    const key = ((data[k] >> 4) << 8) | ((data[k + 1] >> 4) << 4) | (data[k + 2] >> 4);
    const bucket = buckets.get(key) ?? { n: 0, r: 0, g: 0, b: 0 };
    bucket.n++;
    bucket.r += data[k];
    bucket.g += data[k + 1];
    bucket.b += data[k + 2];
    buckets.set(key, bucket);
  }
  let dominant = null;
  for (const bucket of buckets.values()) if (!dominant || bucket.n > dominant.n) dominant = bucket;
  if (!dominant) return false;
  const bg = [dominant.r / dominant.n, dominant.g / dominant.n, dominant.b / dominant.n];

  let uniform = 0;
  for (const p of border) if (colorDistance(data, p * 4, bg) <= tolerance) uniform++;
  if (uniform / border.length < minBorderUniformity) return false;

  const total = w * h;
  const mask = new Uint8Array(total);
  const queue = new Int32Array(total);
  let head = 0;
  let tail = 0;
  for (const p of border) {
    if (!mask[p] && colorDistance(data, p * 4, bg) <= tolerance) {
      mask[p] = 1;
      queue[tail++] = p;
    }
  }
  while (head < tail) {
    const p = queue[head++];
    const x = p % w;
    const y = (p - x) / w;
    const neighbours = [x > 0 ? p - 1 : -1, x < w - 1 ? p + 1 : -1, y > 0 ? p - w : -1, y < h - 1 ? p + w : -1];
    for (const n of neighbours) {
      if (n < 0 || mask[n]) continue;
      if (colorDistance(data, n * 4, bg) <= tolerance) {
        mask[n] = 1;
        queue[tail++] = n;
      }
    }
  }

  const removed = tail;
  if (removed < total * 0.02 || removed > total * 0.97) return false;

  for (let p = 0; p < total; p++) if (mask[p]) data[p * 4 + 3] = 0;

  // Feather the first ring of foreground pixels.
  const soft = tolerance * 1.5;
  for (let p = 0; p < total; p++) {
    if (mask[p]) continue;
    const x = p % w;
    const y = (p - x) / w;
    const touchesBg =
      (x > 0 && mask[p - 1]) || (x < w - 1 && mask[p + 1]) || (y > 0 && mask[p - w]) || (y < h - 1 && mask[p + w]);
    if (!touchesBg) continue;
    const k = p * 4;
    const alpha = Math.min(1, Math.max(0.05, (colorDistance(data, k, bg) - tolerance) / soft));
    if (alpha >= 1) continue;
    for (let c = 0; c < 3; c++) {
      data[k + c] = Math.max(0, Math.min(255, Math.round((data[k + c] - bg[c] * (1 - alpha)) / alpha)));
    }
    data[k + 3] = Math.round(data[k + 3] * alpha);
  }
  return true;
}
