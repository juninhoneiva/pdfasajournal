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
    // U+FFFD marks glyphs pdf.js could not map to a character (missing ToUnicode entries).
    const str = item.str.replace(/\uFFFD/g, "");
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

/**
 * Walks the operator list keeping track of the graphics state: the current transformation matrix
 * (CTM) and the active soft mask.
 *
 * Soft masks (ExtGState /SMask) are drawn by pdf.js as a group flagged `smask`: whatever is painted
 * inside it is the mask itself (white = opaque, black = transparent for Luminosity masks), never
 * visible content. Images inside such groups are collected as mask layers; when the mask is active
 * while a later image is painted, the layers are attached to that image so raster.js can turn them
 * into transparency (rounded corners, torn paper edges, vignettes).
 */
async function readImages(pdfjs, page, opList, viewport, timeout) {
  const { OPS, Util } = pdfjs;
  const identity = [1, 0, 0, 1, 0, 0];
  const stack = [];
  // mask: soft mask set in the current graphics state; outer: masks of enclosing groups, which keep
  // applying to everything inside them even if the group resets its own SMask.
  let state = { ctm: identity, mask: null, outer: [] };
  const groups = [];
  let pendingMask = null;
  const found = [];

  const push = () => stack.push(state);
  const pop = () => {
    state = stack.pop() ?? { ctm: identity, mask: null, outer: [] };
  };
  const maskGroup = () => {
    for (let i = groups.length - 1; i >= 0; i--) if (groups[i].isMask) return groups[i];
    return null;
  };
  const record = entry => {
    const group = maskGroup();
    if (group) group.layers.push(entry);
    else found.push({ ...entry, masks: state.mask ? [...state.outer, state.mask] : state.outer });
  };

  const { fnArray, argsArray } = opList;
  for (let i = 0; i < fnArray.length; i++) {
    const fn = fnArray[i];
    const args = argsArray[i];
    switch (fn) {
      case OPS.save:
        push();
        break;
      case OPS.restore:
      case OPS.paintFormXObjectEnd:
        pop();
        break;
      case OPS.beginGroup: {
        const smask = args?.[0]?.smask;
        groups.push({
          isMask: !!smask,
          subtype: smask?.subtype ?? "Alpha",
          backdrop: smask?.backdrop ?? null,
          layers: []
        });
        push();
        if (!smask && state.mask) state = { ...state, outer: [...state.outer, state.mask], mask: null };
        break;
      }
      case OPS.endGroup: {
        const group = groups.pop();
        pop();
        if (group?.isMask) pendingMask = group;
        break;
      }
      case OPS.setGState:
        for (const [key, value] of args?.[0] ?? []) {
          if (key !== "SMask") continue;
          state = { ...state, mask: value && pendingMask?.layers.length ? pendingMask : null };
          if (value) pendingMask = null;
        }
        break;
      case OPS.transform:
        state = { ...state, ctm: Util.transform(state.ctm, args) };
        break;
      case OPS.paintFormXObjectBegin:
        push();
        if (Array.isArray(args?.[0]) || ArrayBuffer.isView(args?.[0])) {
          state = { ...state, ctm: Util.transform(state.ctm, Array.from(args[0])) };
        }
        break;
      case OPS.paintImageXObject:
        record({ id: args[0], width: args[1], height: args[2], ctm: state.ctm });
        break;
      case OPS.paintInlineImageXObject:
        record({ id: null, inline: args[0], width: args[0]?.width, height: args[0]?.height, ctm: state.ctm });
        break;
      default:
        break;
    }
  }

  const cache = new Map();
  const resolve = async entry => {
    const matrix = Util.transform(viewport.transform, entry.ctm);
    const [a, b, c, d, e, f] = matrix;
    const corners = [[0, 0], [1, 0], [0, 1], [1, 1]].map(([u, v]) => [a * u + c * v + e, b * u + d * v + f]);
    const xs = corners.map(p => p[0]);
    const ys = corners.map(p => p[1]);
    const box = { x0: Math.min(...xs), x1: Math.max(...xs), top: Math.min(...ys), bottom: Math.max(...ys) };
    let source = entry.inline ?? null;
    if (!source && entry.id) {
      if (!cache.has(entry.id)) cache.set(entry.id, getObject(page, entry.id, timeout));
      source = await cache.get(entry.id);
    }
    if (!source) return null;
    return {
      ...box,
      objId: entry.id,
      matrix,
      source,
      pixelWidth: source.width ?? entry.width,
      pixelHeight: source.height ?? entry.height
    };
  };

  const placed = [];
  const masks = new Map();
  for (const entry of found) {
    const image = await resolve(entry);
    if (!image) continue;
    const resolved = [];
    for (const mask of entry.masks) {
      if (!masks.has(mask)) {
        const layers = (await Promise.all(mask.layers.map(resolve))).filter(Boolean);
        masks.set(mask, layers.length ? { subtype: mask.subtype, layers } : null);
      }
      if (masks.get(mask)) resolved.push(masks.get(mask));
    }
    if (resolved.length) image.masks = resolved;
    placed.push(image);
  }
  return placed;
}
