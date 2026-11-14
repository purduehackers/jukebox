import {
  defaultPatternSizing,
  ditheringFragmentShader,
  DitheringShapes,
  DitheringTypes,
  getShaderColorFromString,
  ShaderFitOptions,
  ShaderMount,
  type ShaderMountUniforms,
} from '@paper-design/shaders';

const mounted = new WeakSet<HTMLElement>();

export function mountDitheredSoup(container: HTMLElement, fgColor: string): () => void {
  const mql = window.matchMedia('(prefers-reduced-motion: reduce)');
  const uniforms: ShaderMountUniforms = {
    u_colorBack: getShaderColorFromString('#000000'),
    u_colorFront: getShaderColorFromString(fgColor),
    u_shape: DitheringShapes.warp,
    u_type: DitheringTypes['4x4'],
    u_pxSize: 2,
    u_fit: ShaderFitOptions[defaultPatternSizing.fit],
    u_scale: 1,
    u_rotation: defaultPatternSizing.rotation,
    u_offsetX: defaultPatternSizing.offsetX,
    u_offsetY: defaultPatternSizing.offsetY,
    u_originX: defaultPatternSizing.originX,
    u_originY: defaultPatternSizing.originY,
    u_worldWidth: defaultPatternSizing.worldWidth,
    u_worldHeight: defaultPatternSizing.worldHeight,
  };

  let mount: ShaderMount | null = null;
  try {
    mount = new ShaderMount(container, ditheringFragmentShader, uniforms, undefined, mql.matches ? 0 : 0.04);
  } catch {
    return () => {};
  }

  const onChange = () => {
    mount?.setSpeed(mql.matches ? 0 : 0.04);
  };
  mql.addEventListener('change', onChange);

  return () => {
    mql.removeEventListener('change', onChange);
    mount?.dispose();
    mount = null;
  };
}

export function initDitheredSoups(root: ParentNode = document): () => void {
  const cleanups: Array<() => void> = [];
  for (const wrapper of root.querySelectorAll<HTMLElement>('.ph-dither-soup[data-fg-color]')) {
    const target = wrapper.querySelector<HTMLElement>('[data-dither-soup-mount]') ?? wrapper;
    if (mounted.has(target)) continue;
    const fgColor = wrapper.dataset.fgColor;
    if (!fgColor) continue;
    mounted.add(target);
    cleanups.push(mountDitheredSoup(target, fgColor));
  }
  return () => {
    for (const cleanup of cleanups) cleanup();
  };
}
