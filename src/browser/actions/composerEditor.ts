/**
 * Page function: the composer editor to type into and read from. After an in-page move (the
 * first prompt sent from the home page opens the conversation), ChatGPT keeps the home page's
 * composer in the page, hidden and first in document order, next to the conversation's own
 * visible composer. So the first visible element among all matches wins, in selector order; the
 * first match counts only when none is visible. Injected with Function.prototype.toString.
 */
export function findComposerEditor(doc: Document, selectors: readonly string[]): Element | null {
  let first: Element | null = null;
  for (const selector of selectors) {
    for (const node of Array.from(doc.querySelectorAll(selector))) {
      if (!first) first = node;
      const rect =
        typeof node.getBoundingClientRect === "function" ? node.getBoundingClientRect() : null;
      if (rect && rect.width > 0 && rect.height > 0) return node;
    }
  }
  return first;
}
