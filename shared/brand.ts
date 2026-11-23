/** Public product identity. Technical IDs stay unchanged for existing installs. */
const PRODUCT_NAME = "NEX";

/** Upgrade the old default without overwriting a site's custom name. */
export function resolveSiteTitle(value?: string | null): string {
  const title = value?.trim();
  return !title || /^forwardx$/i.test(title) ? PRODUCT_NAME : title;
}
