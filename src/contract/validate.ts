// Runtime validation of untrusted command envelopes against the v1 contract.
import type { CommandEnvelope, CommandType, ObservedStatus, Role } from './types.ts';

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export class ValidationError extends Error {}

type Shape = Record<string, (v: unknown) => boolean>;
const str = (max: number) => (v: unknown) => typeof v === 'string' && v.length > 0 && v.length <= max;
const id = (v: unknown) => typeof v === 'string' && UUID.test(v);
const idOrNull = (v: unknown) => v === null || id(v);
const finite = (min: number, max: number) => (v: unknown) => typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max;
const int = (v: unknown) => Number.isSafeInteger(v) && (v as number) >= 0;
const optional = (check: (v: unknown) => boolean) => (v: unknown) => v === undefined || check(v);
/** API character bound for submitted links (real navigation/share URLs are long); the source layer enforces its own byte bound. */
export const MAX_URL = 2048;
const MODES = ['auto', 'master', 'requests'];
const STATUSES: ObservedStatus[] = ['loading', 'playing', 'paused', 'buffering', 'ended', 'error', 'needs_activation'];

const SHAPES: { [T in CommandType]: Shape } = {
  'night.open': {},
  'night.close': {},
  'master.add': { url: str(MAX_URL) },
  'master.remove': { entryId: id },
  'master.move': { entryId: id, afterEntryId: idOrNull },
  'request.remove': { entryId: id },
  'request.move': { entryId: id, afterEntryId: idOrNull },
  'playback.play': {},
  'playback.pause': {},
  'playback.seek': { entryId: id, positionSec: finite(0, 24 * 3600) },
  'playback.skip': { entryId: id },
  'playback.volume': { volume: finite(0, 1) },
  'queue.mode': { mode: (v) => MODES.includes(v as string) },
  // Wide sanity range here; the service enforces the configured policy bounds.
  'queue.interval': { periodMs: (v) => v === null || (Number.isSafeInteger(v) && (v as number) >= 1000 && (v as number) <= 24 * 3600_000) },
  'request.playNow': { entryId: id },
  'device.pairing.create': { name: str(60) },
  'device.revoke': { deviceId: id },
  'requester.ban': { username: (v) => typeof v === 'string' && /^[a-zA-Z0-9._-]{1,40}$/.test(v) },
  'requester.unban': { username: (v) => typeof v === 'string' && /^[a-zA-Z0-9._-]{1,40}$/.test(v) },
  'request.submit': { url: str(MAX_URL), expectRecordingKey: optional(str(200)) },
  'request.preview': { url: str(MAX_URL) },
  'device.pair': { code: str(20) },
  'display.connect': { secret: (v) => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v) },
  'player.claim': { takeover: optional((v) => typeof v === 'boolean') },
  'player.release': { generation: int },
  'player.report': {
    generation: int,
    epoch: int,
    loadId: int,
    status: (v) => STATUSES.includes(v as ObservedStatus),
    positionSec: finite(0, 24 * 3600),
    previous: optional((v) => {
      if (typeof v !== 'object' || v === null) return false;
      const p = v as Record<string, unknown>;
      return Object.keys(p).length === 2 && int(p.loadId) && finite(0, 24 * 3600)(p.positionSec);
    }),
    error: optional(str(300)),
  },
};

/** Which authenticated role may issue each command. Enforced server-side only. */
export const COMMAND_ROLES: { [T in CommandType]: Role } = {
  'night.open': 'admin',
  'night.close': 'admin',
  'master.add': 'admin',
  'master.remove': 'admin',
  'master.move': 'admin',
  'request.remove': 'admin',
  'request.move': 'admin',
  'playback.play': 'admin',
  'playback.pause': 'admin',
  'playback.seek': 'admin',
  'playback.skip': 'admin',
  'playback.volume': 'admin',
  'queue.mode': 'admin',
  'queue.interval': 'admin',
  'request.playNow': 'admin',
  'device.pairing.create': 'admin',
  'device.revoke': 'admin',
  'requester.ban': 'admin',
  'requester.unban': 'admin',
  'request.submit': 'attendee',
  'request.preview': 'attendee',
  'device.pair': 'public',
  'display.connect': 'admin',
  'player.claim': 'player',
  'player.release': 'player',
  'player.report': 'player',
};

export function parseEnvelope(body: unknown): CommandEnvelope {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) throw new ValidationError('Command must be a JSON object');
  const env = body as Record<string, unknown>;
  for (const key of Object.keys(env)) {
    if (!['commandId', 'type', 'expectedRevision', 'payload'].includes(key)) throw new ValidationError(`Unknown field ${key}`);
  }
  if (!id(env.commandId)) throw new ValidationError('commandId must be a lowercase UUID');
  if (typeof env.type !== 'string' || !Object.hasOwn(SHAPES, env.type)) throw new ValidationError('Unknown command type');
  if (env.expectedRevision !== undefined && !int(env.expectedRevision)) throw new ValidationError('expectedRevision must be a non-negative integer');
  const payload = env.payload ?? {};
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) throw new ValidationError('payload must be an object');
  const shape = SHAPES[env.type as CommandType];
  for (const key of Object.keys(payload)) {
    if (!Object.hasOwn(shape, key)) throw new ValidationError(`Unknown payload field ${key}`);
  }
  for (const [key, check] of Object.entries(shape)) {
    if (!check((payload as Record<string, unknown>)[key])) throw new ValidationError(`Invalid payload field ${key}`);
  }
  return { commandId: env.commandId as string, type: env.type as CommandType, expectedRevision: env.expectedRevision as number | undefined, payload } as CommandEnvelope;
}
