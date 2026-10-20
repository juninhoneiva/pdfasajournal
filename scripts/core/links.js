/**
 * Book cross-references ("Matança no Soho (p. 250)") become Foundry content links.
 *
 * `resolve(printedPage, name)` returns { uuid, anchor } for the journal page holding that printed
 * page of the book (anchor: optional heading slug), or null when the page was not imported.
 * Text already inside a content link is left alone, so the function can run again after more of
 * the book is imported.
 */

const REF_RE = /(?:<strong>([^<]{2,80})<\/strong>([^<]{0,8}?))?\b(p\.|pp\.|pág\.|página)(\s|&nbsp;| )?(\d{1,4})/g;
const LINK_RE = /@UUID\[[^\]]*\]\{[^}]*\}/g;

export function normalizeName(text) {
  return String(text)
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export function linkReferences(html, resolve) {
  // Ranges already linked are skipped.
  const linked = [];
  for (const m of html.matchAll(LINK_RE)) linked.push([m.index, m.index + m[0].length]);
  const inLink = i => linked.some(([a, b]) => i >= a && i < b);

  let count = 0;
  const out = html.replace(REF_RE, (match, name, between, label, space, number, offset) => {
    const refStart = offset + match.length - (label.length + (space?.length ?? 0) + number.length);
    if (inLink(refStart)) return match;
    const target = resolve(Number(number), name?.trim() ?? null);
    if (!target) return match;
    count++;
    const ref = `${label}${space ? " " : ""}${number}`;
    const anchor = target.anchor ? `#${target.anchor}` : "";
    const prefix = name ? `<strong>${name}</strong>${between}` : "";
    return `${prefix}@UUID[${target.uuid}${anchor}]{${ref}}`;
  });
  return { html: out, count };
}
