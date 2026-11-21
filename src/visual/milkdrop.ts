import type { ButterchurnModule } from 'butterchurn';

export const DEFAULT_CYCLE_MS = 30_000;
export const DEFAULT_BLEND_SEC = 2.7;
export const SILENCE_1024 = new Uint8Array(1024).fill(128);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isObjectLike(value: unknown): value is Record<string, unknown> {
  return (typeof value === 'object' || typeof value === 'function') && value !== null && !Array.isArray(value);
}

/** Unwrap up to two `.default` layers from CJS/UMD interop wrappers. */
function unwrapModule(mod: unknown): Record<string, unknown> | null {
  let current: unknown = mod;
  for (let i = 0; i < 2; i++) {
    if (isObjectLike(current) && 'default' in current && current.default !== undefined && current.default !== current) {
      current = current.default;
    } else {
      break;
    }
  }
  return isObjectLike(current) ? current : null;
}

export function extractButterchurn(mod: unknown): ButterchurnModule {
  const candidates: unknown[] = [mod];
  const unwrapped = unwrapModule(mod);
  if (unwrapped && unwrapped !== mod) candidates.push(unwrapped);
  for (const candidate of candidates) {
    if (isObjectLike(candidate) && typeof candidate.createVisualizer === 'function') {
      return candidate as unknown as ButterchurnModule;
    }
  }
  throw new Error('Butterchurn module did not expose createVisualizer');
}

export function extractPresetMap(mod: unknown): Record<string, Record<string, unknown>> {
  let root: unknown = unwrapModule(mod) ?? mod;
  if (isRecord(root) && typeof root.getPresets === 'function') {
    root = (root.getPresets as () => unknown)();
  }
  if (!isRecord(root)) return {};
  const result: Record<string, Record<string, unknown>> = {};
  for (const [key, value] of Object.entries(root)) {
    if (isRecord(value) && isRecord(value.baseVals)) {
      result[key] = value;
    }
  }
  return result;
}

export function extractBasePresetKeys(mod: unknown): string[] {
  const candidates: unknown[] = [mod, unwrapModule(mod)];
  for (const candidate of candidates) {
    if (isRecord(candidate) && typeof candidate.getBasePresetKeys === 'function') {
      const pack = (candidate.getBasePresetKeys as () => unknown)();
      if (isRecord(pack) && Array.isArray(pack.presets)) {
        return pack.presets
          .filter((name): name is string => typeof name === 'string')
          .sort((a, b) => a.localeCompare(b, 'en', { sensitivity: 'base' }));
      }
    }
  }
  return [];
}

export function sortedPresetNames(presets: Record<string, unknown>): string[] {
  return Object.keys(presets).sort((a, b) => a.localeCompare(b, 'en', { sensitivity: 'base' }));
}

export function pickNextPreset(
  names: readonly string[],
  current: string | null,
  random: () => number = Math.random,
): string | null {
  if (names.length === 0) return null;
  if (names.length === 1) return names[0] ?? null;
  const pool = current !== null && names.includes(current)
    ? names.filter((name) => name !== current)
    : names;
  const index = Math.min(pool.length - 1, Math.max(0, Math.floor(random() * pool.length)));
  return pool[index] ?? null;
}

export function nextPinnedPreset(names: readonly string[], current: string | null): string | null {
  if (current === null || names.length === 0) return null;
  const index = names.indexOf(current);
  return names[(index + 1) % names.length] ?? null;
}

export function computeRenderSize(
  clientWidth: number,
  clientHeight: number,
  devicePixelRatio = 1,
  maxDim = 1920,
): { width: number; height: number } {
  const safeW = Number.isFinite(clientWidth) && clientWidth > 0 ? clientWidth : 1;
  const safeH = Number.isFinite(clientHeight) && clientHeight > 0 ? clientHeight : 1;
  const safeDpr = Number.isFinite(devicePixelRatio) && devicePixelRatio > 0 ? devicePixelRatio : 1;
  const dpr = Math.min(Math.max(1, safeDpr), 1.5);
  let width = safeW * dpr;
  let height = safeH * dpr;
  const largest = Math.max(width, height);
  if (maxDim > 0 && largest > maxDim) {
    const scale = maxDim / largest;
    width *= scale;
    height *= scale;
  }
  return {
    width: Math.max(1, Math.round(width)),
    height: Math.max(1, Math.round(height)),
  };
}

export function scaleTimeDomainSamples(source: Uint8Array, dest: Uint8Array, gain: number): void {
  const len = Math.min(source.length, dest.length);
  if (gain <= 0) {
    dest.fill(128, 0, len);
    return;
  }
  if (gain >= 1) {
    dest.set(source.length === len ? source : source.subarray(0, len));
    return;
  }
  for (let i = 0; i < len; i++) {
    dest[i] = Math.max(0, Math.min(255, Math.round(128 + (source[i]! - 128) * gain)));
  }
}
