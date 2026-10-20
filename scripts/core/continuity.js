/**
 * Re-joins paragraphs that the printed book split across a page break (last column of one page,
 * first column of the next). In a journal there is no page break, so the split only gets in the
 * way of reading.
 *
 * A paragraph continues when it ends without closing punctuation and the next text paragraph starts
 * in lowercase, or the first one ends on a comma, semicolon, hyphen or lowercase letter. Headings,
 * list items and paragraphs opening with a drop cap never continue anything.
 */

import { headingLevel } from "./html.js";
import { lineText } from "./layout.js";

const CLOSED_RE = /[.!?…:"”»)\]]\s*$/u;
const OPEN_END_RE = /[,;\-–\p{Ll}]\s*$/u;
const LOWER_START_RE = /^\s*\p{Ll}/u;

function* leavesInOrder(node) {
  if (!node) return;
  if (node.type === "leaf") yield node;
  else for (const child of node.children ?? []) yield* leavesInOrder(child);
}

function continues(previous, next, stats) {
  if (previous.list || next.list || next.dropcap) return false;
  if (headingLevel(previous, stats) || headingLevel(next, stats)) return false;
  const ratio = next.size / previous.size;
  if (ratio > 1.1 || ratio < 0.9) return false;
  const end = lineText(previous.lines.at(-1));
  const start = lineText(next.lines[0]);
  if (!end || !start || CLOSED_RE.test(end)) return false;
  return LOWER_START_RE.test(start) || OPEN_END_RE.test(end);
}

function absorb(previous, next) {
  const chars = previous.chars + next.chars;
  previous.size = chars ? (previous.size * previous.chars + next.size * next.chars) / chars : previous.size;
  previous.chars = chars;
  previous.lines.push(...next.lines);
  previous.bold = previous.bold && next.bold;
  previous.italic = previous.italic && next.italic;
}

/**
 * @param {object[]} layouts  consecutive page layouts of one journal page (one section)
 * @param {object} stats
 * @param {{ acrossColumns?: boolean }} options  also join splits between columns of the same page
 * @returns {number} how many paragraphs were joined
 */
export function joinContinuations(layouts, stats, { acrossColumns = false } = {}) {
  let previous = null;
  let previousPage = null;
  let joined = 0;
  for (const layout of layouts) {
    for (const leaf of leavesInOrder(layout.tree)) {
      const index = leaf.blocks.findIndex(b => b.kind !== "image");
      const first = leaf.blocks[index]?.kind === "para" ? leaf.blocks[index] : null;
      const allowed = previousPage !== layout || acrossColumns;
      if (first && previous && allowed && continues(previous, first, stats)) {
        absorb(previous, first);
        leaf.blocks.splice(index, 1);
        joined++;
      }
      // The text that ends the block (figures in between are skipped, a table ends the flow).
      const last = leaf.blocks.findLast(b => b.kind !== "image");
      if (last) {
        previous = last.kind === "para" ? last : null;
        previousPage = layout;
      }
    }
  }
  return joined;
}
