/** True when a captured body looks like HTML suitable for SEO parsing. */
export function looksLikeHtml(html: string): boolean {
  const trimmed = html.trim();
  if (!trimmed) return false;
  if (/<!doctype\s+html/i.test(trimmed) || /<html[\s>]/i.test(trimmed)) return true;
  // Large markup without a root <html> (partial documents / some CDNs)
  return trimmed.length >= 500 && /<(head|body|meta|title|div|script)[\s>]/i.test(trimmed);
}
