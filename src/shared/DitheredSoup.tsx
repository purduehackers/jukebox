import { useEffect, useRef } from 'react';
import { mountDitheredSoup } from './dithered-soup.ts';
import './dithered-soup.css';

/** The same low-speed 4×4 warp dither used by the Checkpoints UI revamp. */
export function DitheredSoup({ fgColor }: { fgColor: string }) {
  const mountRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (mountRef.current) return mountDitheredSoup(mountRef.current, fgColor);
    return undefined;
  }, [fgColor]);

  return (
    <div className="ph-dither-soup" aria-hidden="true" data-fg-color={fgColor}>
      <div ref={mountRef} data-dither-soup-mount style={{ width: '100%', height: '100%' }} />
      <div className="ph-dither-soup__fade" />
    </div>
  );
}
