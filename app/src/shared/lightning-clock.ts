import { LightningTime } from '@purduehackers/time';

export interface LightningColors {
  boltColor: string;
  zapColor: string;
  sparkColor: string;
}

// 1 day (86,400,000 ms) / (16 * 16 * 16 * 16) charges
const MILLIS_PER_CHARGE = 1318.359375;

function millisSinceMidnight(date: Date): number {
  return (
    ((date.getHours() * 60 + date.getMinutes()) * 60 + date.getSeconds()) * 1000 +
    date.getMilliseconds()
  );
}

export function getLightningColors(date = new Date()): LightningColors {
  return new LightningTime().convertToLightning(date).colors;
}

export function subscribeLightningColors(onColors: (colors: LightningColors) => void): () => void {
  let timer: number | undefined;
  let stopped = false;

  const tick = () => {
    if (stopped) return;
    const now = new Date();
    onColors(getLightningColors(now));
    const remaining = MILLIS_PER_CHARGE - (millisSinceMidnight(now) % MILLIS_PER_CHARGE);
    timer = window.setTimeout(tick, Math.max(50, Math.ceil(remaining)));
  };

  tick();
  return () => {
    stopped = true;
    if (timer !== undefined) window.clearTimeout(timer);
  };
}
