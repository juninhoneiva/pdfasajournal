/** Links book cross-references ("p. 250") across every journal imported from the same book. */

import { MODULE_ID } from "../constants.js";
import { linkReferences, normalizeName } from "../core/links.js";

const OWN_LINK_RE = /@UUID\[(JournalEntry\.[^\]#]+)(#[^\]]*)?\]\{((?:p\.|pp\.|pág\.|página) ?\d{1,4})\}/g;

function headingsOf(html) {
  return [...html.matchAll(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/g)].map(m => m[2].replace(/<[^>]+>/g, "").trim());
}

function slugOf(text) {
  const heading = document.createElement("h2");
  heading.textContent = text;
  const PageClass = foundry.documents?.JournalEntryPage ?? globalThis.JournalEntryPage;
  return PageClass?.slugifyHeading?.(heading) ?? text.slugify({ strict: true });
}

/**
 * Re-links every journal imported from `book` (all books when omitted). Links whose target was
 * deleted (a chapter imported again) go back to plain text first, then everything is linked anew.
 * @returns {Promise<number>} number of links created
 */
export async function relinkBook(book = null) {
  const entries = game.journal.filter(j => {
    const key = j.getFlag(MODULE_ID, "book");
    return key && (!book || key === book);
  });
  if (!entries.length) return 0;

  const index = new Map();
  for (const entry of entries) {
    const key = entry.getFlag(MODULE_ID, "book");
    for (const page of entry.pages) {
      for (const n of page.getFlag(MODULE_ID, "printedPages") ?? []) index.set(`${key}|${n}`, page);
    }
  }
  const headings = new Map();
  const headingsFor = page => {
    if (!headings.has(page.id)) headings.set(page.id, headingsOf(page.text?.content ?? ""));
    return headings.get(page.id);
  };

  let total = 0;
  for (const entry of entries) {
    const key = entry.getFlag(MODULE_ID, "book");
    const resolve = (number, name) => {
      const page = index.get(`${key}|${number}`);
      if (!page) return null;
      let anchor = null;
      if (name) {
        const wanted = normalizeName(name);
        const match = headingsFor(page).find(h => {
          const norm = normalizeName(h);
          return norm === wanted || (wanted.length > 4 && norm.startsWith(wanted));
        });
        if (match) anchor = slugOf(match);
      }
      return { uuid: page.uuid, anchor };
    };

    const updates = [];
    for (const page of entry.pages) {
      const original = page.text?.content ?? "";
      if (!original) continue;
      // Drop links to pages that no longer exist, then link again.
      const cleaned = original.replace(OWN_LINK_RE, (match, uuid, anchor, label) => (fromUuidSync(uuid) ? match : label));
      const { html, count } = linkReferences(cleaned, resolve);
      total += count;
      if (html !== original) updates.push({ _id: page.id, "text.content": html });
    }
    if (updates.length) await entry.updateEmbeddedDocuments("JournalEntryPage", updates);
  }
  return total;
}
