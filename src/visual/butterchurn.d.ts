declare module 'butterchurn' {
  export interface ButterchurnAudioLevels {
    timeByteArray: Uint8Array;
    timeByteArrayL: Uint8Array;
    timeByteArrayR: Uint8Array;
  }

  export interface ButterchurnOptions {
    width?: number;
    height?: number;
    pixelRatio?: number;
    textureRatio?: number;
    meshWidth?: number;
    meshHeight?: number;
  }

  export interface ButterchurnVisualizer {
    loadPreset(preset: Record<string, unknown>, blendTime?: number): Promise<void> | void;
    setRendererSize(width: number, height: number, opts?: ButterchurnOptions): void;
    render(opts?: { audioLevels?: ButterchurnAudioLevels; elapsedTime?: number }): void;
    loseGLContext(): void;
  }

  export interface ButterchurnModule {
    createVisualizer(
      context: BaseAudioContext | null,
      canvas: HTMLCanvasElement,
      opts?: ButterchurnOptions,
    ): ButterchurnVisualizer;
  }

  const butterchurn: ButterchurnModule;
  export default butterchurn;
}

declare module 'butterchurn-presets/dist/base.min.js' {
  const presets: Record<string, Record<string, unknown>>;
  export default presets;
}

declare module 'butterchurn-presets/dist/presetPackMeta.min.js' {
  export function getBasePresetKeys(): { presets: string[]; chunk: string };
  const meta: { getBasePresetKeys(): { presets: string[]; chunk: string } };
  export default meta;
}
