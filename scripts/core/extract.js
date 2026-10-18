/**
 * Reads one PDF page through pdf.js and returns a plain model:
 *  - spans: positioned text fragments with font size and bold/italic flags
 *  - images: raster images with their placement on the page and the decoded pixel source
 *
 * Coordinates are in "viewport" space at scale 1: origin at the top-left corner, y grows downwards,
 * units are PDF points (1/72 in). Page rotation (/Rotate) is already applied by the viewport.
 */

const BOLD_RE = /bold|black|heavy|semibold|demibold|extrabold|ultrabold|demi\b/i;
const ITALIC_RE = /italic|oblique|-it$|-ital|kursiv/i;
const MAX_TEXT_ANGLE = 0.17; // ~10 degrees: rotated text (sidebars, stamps) is skipped for now

export async function extractPage(pdfjs, page, { images = true, imageTimeout = 20000 } = {}) {
  const viewport = page.getViewport({ scale: 1 });
  // The operator list must be fetched first: it loads the fonts into commonObjs (we read their names)
  // and lists every image painted on the page.
  const opList = await page.getOperatorList();
  const textContent = await page.getTextContent();
  const spans = readSpans(pdfjs, page, textContent, viewport);
  const placed = images ? await readImages(pdfjs, page, opList, viewport, imageTimeout) : [];
  return {
    number: page.pageNumber,
    width: viewport.width,
    height: viewport.height,
    spans,
    images: placed
  };
}

function readFont(page, fontName, cache) {
  if (cache.has(fontName)) return cache.get(fontName);
  let name = "";
  let bold = false;
  let italic = false;
  try {
    if (page.commonObjs.has(fontName)) {
      const font = page.commonObjs.get(fontName);
      name = font?.name ?? "";
      bold = !!font?.bold || !!font?.black;
      italic = !!font?.italic;
    }
  } catch {
    // Font not available: fall back to name-less detection.
  }
  const clean = String(name).replace(/^[A-Z]{6}\+/, "");
  const info = {
    name: clean,
    bold: bold || BOLD_RE.test(clean),
    italic: italic || ITALIC_RE.test(clean)
  };
  cache.set(fontName, info);
  return info;
}

function readSpans(pdfjs, page, textContent, viewport) {
  const { Util } = pdfjs;
  const fonts = new Map();
  const spans = [];
  for (const item of textContent.items) {
    if (typeof item.str !== "string") continue; // marked-content markers
    const str = item.str;
    if (!str.trim()) continue;
    const style = textContent.styles[item.fontName] ?? {};
    if (style.vertical) continue;

    const tx = Util.transform(viewport.transform, item.transform);
    const size = Math.hypot(tx[2], tx[3]);
    if (!(size >= 1)) continue;
    const angle = Math.atan2(tx[1], tx[0]);
    if (Math.abs(angle) > MAX_TEXT_ANGLE) continue;

    const ascent = style.ascent > 0.4 && style.ascent < 1.3 ? style.ascent : 0.8;
    const descent = Math.abs(style.descent) > 0 && Math.abs(style.descent) < 0.6 ? Math.abs(style.descent) : 0.2;
    const font = readFont(page, item.fontName, fonts);
    const width = Math.abs(item.width * viewport.scale);
    const x = tx[4];
    const baseline = tx[5];
    spans.push({
      str,
      x0: x,
      x1: x + width,
      top: baseline - ascent * size,
      bottom: baseline + descent * size,
      baseline,
      size,
      bold: font.bold,
      italic: font.italic,
      font: font.name
    });
  }
  return spans;
}

function getObject(page, id, timeout) {
  const store = id.startsWith("g_") ? page.commonObjs : page.objs;
  return new Promise(resolve => {
    const timer = setTimeout(() => resolve(null), timeout);
    try {
      store.get(id, obj => {
        clearTimeout(timer);
        resolve(obj ?? null);
      });
    } catch {
      clearTimeout(timer);
      resolve(null);
    }
  });
}

/** Walks the operator list keeping track of the current transformation matrix (CTM). */
async function readImages(pdfjs, page, opList, viewport, timeout) {
  const { OPS, Util } = pdfjs;
  const identity = [1, 0, 0, 1, 0, 0];
  const stack = [];
  let ctm = identity;
  const found = [];

  const { fnArray, argsArray } = opList;
  for (let i = 0; i < fnArray.length; i++) {
    const fn = fnArray[i];
    const args = argsArray[i];
    switch (fn) {
      case OPS.save:
      case OPS.beginGroup:
        stack.push(ctm);
        break;
      case OPS.restore:
      case OPS.endGroup:
      case OPS.paintFormXObjectEnd:
        ctm = stack.pop() ?? identity;
        break;
      case OPS.transform:
        ctm = Util.transform(ctm, args);
        break;
      case OPS.paintFormXObjectBegin:
        stack.push(ctm);
        if (Array.isArray(args?.[0]) || ArrayBuffer.isView(args?.[0])) ctm = Util.transform(ctm, Array.from(args[0]));
        break;
      case OPS.paintImageXObject:
        found.push({ id: args[0], width: args[1], height: args[2], ctm });
        break;
      case OPS.paintInlineImageXObject:
        found.push({ id: null, inline: args[0], width: args[0]?.width, height: args[0]?.height, ctm });
        break;
      default:
        break;
    }
  }

  const placed = [];
  const cache = new Map();
  for (const entry of found) {
    const matrix = Util.transform(viewport.transform, entry.ctm);
    const [a, b, c, d, e, f] = matrix;
    const corners = [[0, 0], [1, 0], [0, 1], [1, 1]].map(([u, v]) => [a * u + c * v + e, b * u + d * v + f]);
    const xs = corners.map(c => c[0]);
    const ys = corners.map(c => c[1]);
    const box = { x0: Math.min(...xs), x1: Math.max(...xs), top: Math.min(...ys), bottom: Math.max(...ys) };
    let source = entry.inline ?? null;
    if (!source && entry.id) {
      if (!cache.has(entry.id)) cache.set(entry.id, getObject(page, entry.id, timeout));
      source = await cache.get(entry.id);
    }
    if (!source) continue;
    placed.push({
      ...box,
      objId: entry.id,
      matrix,
      source,
      pixelWidth: source.width ?? entry.width,
      pixelHeight: source.height ?? entry.height
    });
  }
  return placed;
}
