import { useEffect, useState } from 'react';
import { Dithering } from '@paper-design/shaders-react';
import './dithered-soup.css';

/** The same low-speed 4×4 warp dither used by the Checkpoints UI revamp. */
export function DitheredSoup({ fgColor }: { fgColor: string }) {
  const [reducedMotion, setReducedMotion] = useState(false);

  useEffect(() => {
    const query = window.matchMedia('(prefers-reduced-motion: reduce)');
    const update = () => setReducedMotion(query.matches);
    update();
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);

  return (
    <div className="ph-dither-soup" aria-hidden="true">
      <Dithering
        className="ph-dither-soup__shader"
        width="100%"
        height="100%"
        colorBack="#000000"
        colorFront={fgColor}
        shape="warp"
        type="4x4"
        size={2}
        speed={reducedMotion ? 0 : 0.04}
        scale={1}
      />
      <div className="ph-dither-soup__fade" />
    </div>
  );
}
