/** One local hostname keeps browser cookies and the registered OAuth callback together.
 * This redirects navigation; it never relaxes the API's same-origin checks. */
export function localOriginRedirect(host: string | undefined, path: string, canonicalOrigin: string): string | null {
  if (!host || !path.startsWith('/') || path.startsWith('//')) return null;
  try {
    const canonical = new URL(canonicalOrigin);
    const incoming = new URL(`${canonical.protocol}//${host}`);
    const loopback = new Set(['localhost', '127.0.0.1', '[::1]']);
    if (!loopback.has(canonical.hostname) || !loopback.has(incoming.hostname)
      || incoming.username || incoming.password || incoming.port !== canonical.port
      || incoming.host === canonical.host) return null;
    return `${canonical.origin}${path}`;
  } catch { return null; }
}
