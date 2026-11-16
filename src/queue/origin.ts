// The QR code must send a phone to the attendee page, so its origin has to be something a
// phone can reach. A phone's "localhost" is the phone itself, so loopback is refused.
export class OriginError extends Error {}

const LOOPBACK_V4 = /^127(?:\.\d{1,3}){3}$/;

export function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  return host === 'localhost' || host.endsWith('.localhost') || LOOPBACK_V4.test(host) || host === '::1' || host === '0.0.0.0' || host === '::';
}

function isPrivateLan(hostname: string): boolean {
  const octets = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(hostname);
  if (octets) {
    const [a, b] = [Number(octets[1]), Number(octets[2])];
    return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
  }
  return hostname.endsWith('.local');
}

/**
 * The URL a QR should encode for an origin such as `https://jukebox.purduehackers.com`.
 * Throws for origins a phone cannot use. Plain http is accepted only for private LAN hosts
 * (a local test), never for a public hostname.
 */
export function queueEntryUrl(origin: string): string {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    throw new OriginError(`Not a valid origin: ${origin}`);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new OriginError('Origin must be http(s)');
  if (url.username || url.password) throw new OriginError('Origin must not contain credentials');
  if (isLoopbackHost(url.hostname)) {
    throw new OriginError(`${url.hostname} is the phone itself, not this machine; use the venue origin, a LAN address, or a tunnel`);
  }
  if (url.protocol === 'http:' && !isPrivateLan(url.hostname)) {
    throw new OriginError('Public origins must use https; plain http is only for private LAN tests');
  }
  return `${url.origin}/queue`;
}
