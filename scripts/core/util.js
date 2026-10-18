/**
 * Small, dependency-free helpers shared by the conversion pipeline.
 * Nothing in scripts/core may touch Foundry globals: the core also runs in Node for tests.
 */

export function escapeHtml(text) {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function median(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** Most frequent value of a weighted histogram (Map value -> weight). */
export function weightedMode(histogram) {
  let best = null;
  let bestWeight = -Infinity;
  for (const [value, weight] of histogram) {
    if (weight > bestWeight) {
      best = value;
      bestWeight = weight;
    }
  }
  return best;
}

export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

/** Fast 53-bit string/bytes hash (cyrb53). Works without crypto.subtle (plain-HTTP Foundry servers). */
export function hashBytes(bytes, seed = 0) {
  let h1 = 0xdeadbeef ^ seed;
  let h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < bytes.length; i++) {
    const ch = bytes[i];
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16).padStart(14, "0");
}

/** "1-3, 7, 10-" -> [1,2,3,7,10,...,max]. Empty string means every page. */
export function parsePageRange(spec, max) {
  const text = String(spec ?? "").trim();
  if (!text) return Array.from({ length: max }, (_, i) => i + 1);
  const pages = new Set();
  for (const part of text.split(/[,;]\s*/)) {
    const m = part.trim().match(/^(\d*)\s*(?:-\s*(\d*))?$/);
    if (!m) continue;
    const isRange = part.includes("-");
    const start = m[1] ? Number(m[1]) : 1;
    const end = isRange ? (m[2] ? Number(m[2]) : max) : start;
    for (let p = Math.max(1, start); p <= Math.min(max, end); p++) pages.add(p);
  }
  return [...pages].sort((a, b) => a - b);
}

export function slugify(text, fallback = "pdf") {
  const slug = String(text ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return slug || fallback;
}
