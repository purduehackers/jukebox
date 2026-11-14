import type { Snapshot } from '../../../src/contract/types.ts';
import { mountPlayer } from '../player/player-mount.ts';
import type { PlayerState } from '../player/controller.ts';
import { startOrganizerGate } from '../shared/organizer-gate.ts';
import { blendTechniques, controls, defaults, type Settings } from './soundbar.ts';
import { mountSoundbar } from './soundbar-mount.ts';

const STORAGE_KEY = 'jukebox.visual.soundbar.v3';

function loadSettings(): Settings {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}') as Record<string, unknown>;
    const settings: Settings = { ...defaults };
    for (const c of controls) {
      const raw = saved[c.key];
      if (typeof raw === 'number' && Number.isFinite(raw)) {
        settings[c.key] = Math.min(
          c.max,
          Math.max(c.min, Number((Math.round(raw / c.step) * c.step).toFixed(8))),
        );
      }
    }
    const blend = saved.blendTechnique;
    if (typeof blend === 'number' && blendTechniques.some((mode) => mode.value === blend)) {
      settings.blendTechnique = blend;
    }
    return settings;
  } catch {
    return { ...defaults };
  }
}

function saveSettings(settings: Settings) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // Sliders still work without storage.
  }
}

function formatSliderOutput(value: number, unit?: string): string {
  return `${Number(value.toFixed(2))}${unit ? ` ${unit}` : ''}`;
}

export function mountVisualPage(root: HTMLElement): () => void {
  const silent = new URLSearchParams(window.location.search).has('silent');

  return startOrganizerGate(root, (container) => {
    let settings = loadSettings();
    let dithered = true;
    let copied = false;
    let snapshot: Snapshot | null = null;
    let local: PlayerState | null = null;
    let error: string | null = null;

    container.innerHTML = `
      <main class="visual-lab">
        <header>
          <div>
            <span class="visual-eyebrow">JUKEBOX / VISUAL LAB</span>
            <h1>Soundbar</h1>
          </div>
          <a href="/admin">Admin ↗</a>
        </header>
        <div class="visual-workspace">
          <section class="visual-stage" aria-label="Stationary mirrored audio spectrum">
            <div class="visual-soundbar-host" style="position: absolute; inset: 0;"></div>
            <div class="visual-caption" role="status">
              <span data-visual-status></span>
              <span data-visual-track></span>
            </div>
          </section>
          <aside class="visual-controls">
            <h2>Tune</h2>
            <button type="button" class="visual-mode" data-dither-toggle aria-pressed="false">Show underlying function</button>
            <h2>Audio response</h2>
            <div data-controls-host></div>
            <div class="visual-actions">
              <button type="button" data-action="reset">Reset</button>
              <button type="button" data-action="copy">Copy settings</button>
            </div>
            <p>Left → right: bass → treble. Settings save in this browser. Use this page instead of the display tab while tuning audio.</p>
          </aside>
        </div>
      </main>
    `;

    const stageHost = container.querySelector<HTMLElement>('.visual-soundbar-host');
    const statusEl = container.querySelector<HTMLElement>('[data-visual-status]');
    const trackEl = container.querySelector<HTMLElement>('[data-visual-track]');
    const ditherBtn = container.querySelector<HTMLButtonElement>('[data-dither-toggle]');
    const controlsHost = container.querySelector<HTMLElement>('[data-controls-host]');
    const resetBtn = container.querySelector<HTMLButtonElement>('[data-action="reset"]');
    const copyBtn = container.querySelector<HTMLButtonElement>('[data-action="copy"]');

    const soundbar = stageHost
      ? mountSoundbar(stageHost, { settings, active: false, dithered })
      : null;

    let blendSelect: HTMLSelectElement | null = null;
    let blendHint: HTMLElement | null = null;
    let blendSoftnessLabel: HTMLLabelElement | null = null;
    const sliderMap = new Map<
      keyof Settings,
      { input: HTMLInputElement; output: HTMLOutputElement; unit?: string }
    >();

    if (controlsHost) {
      for (const c of controls) {
        if (c.key === 'negativeSpace') {
          const h2 = document.createElement('h2');
          h2.textContent = 'Negative field';
          controlsHost.append(h2);
        }
        if (c.key === 'blendAmount') {
          const h2 = document.createElement('h2');
          h2.textContent = 'Layer blending';
          const selectLabel = document.createElement('label');
          const topSpan = document.createElement('span');
          topSpan.textContent = 'Technique';
          blendSelect = document.createElement('select');
          for (const mode of blendTechniques) {
            const opt = document.createElement('option');
            opt.value = String(mode.value);
            opt.textContent = mode.label;
            blendSelect.append(opt);
          }
          blendSelect.addEventListener('change', () => {
            copied = false;
            settings = { ...settings, blendTechnique: Number(blendSelect!.value) };
            saveSettings(settings);
            soundbar?.setSettings(settings);
            syncControls();
          });
          selectLabel.append(topSpan, blendSelect);

          blendHint = document.createElement('p');
          blendHint.className = 'visual-blend-hint';

          controlsHost.append(h2, selectLabel, blendHint);
        }

        const label = document.createElement('label');
        const row = document.createElement('span');
        row.append(document.createTextNode(c.label));
        const output = document.createElement('output');
        output.textContent = formatSliderOutput(settings[c.key], c.unit);
        row.append(output);

        const input = document.createElement('input');
        input.type = 'range';
        input.min = String(c.min);
        input.max = String(c.max);
        input.step = String(c.step);
        input.value = String(settings[c.key]);
        input.addEventListener('input', () => {
          copied = false;
          settings = { ...settings, [c.key]: Number(input.value) };
          output.textContent = formatSliderOutput(settings[c.key], c.unit);
          saveSettings(settings);
          soundbar?.setSettings(settings);
          syncButtons();
        });

        label.append(row, input);
        controlsHost.append(label);
        if (c.key === 'blendSoftness') {
          blendSoftnessLabel = label;
        }
        sliderMap.set(c.key, { input, output, unit: c.unit });
      }
    }

    const syncCaption = () => {
      const playing = local?.status === 'playing';
      soundbar?.setActive(playing);
      if (statusEl) {
        statusEl.textContent = silent
          ? 'Silent layout preview'
          : (error ??
            (playing
              ? 'Live audio'
              : local?.status === 'needs_activation'
                ? 'Firefox autoplay permission required'
                : snapshot?.night?.status === 'open'
                  ? 'Paused / waiting for audio'
                  : 'Night not started'));
      }
      if (trackEl) {
        trackEl.textContent = snapshot?.nowPlaying?.title ?? '';
      }
    };

    const syncButtons = () => {
      if (ditherBtn) {
        ditherBtn.setAttribute('aria-pressed', String(!dithered));
        ditherBtn.textContent = dithered ? 'Show underlying function' : 'Show dithering';
      }
      if (copyBtn) {
        copyBtn.textContent = copied ? 'Copied' : 'Copy settings';
      }
    };

    const syncControls = () => {
      if (blendSelect) blendSelect.value = String(settings.blendTechnique);
      if (blendHint) {
        blendHint.textContent =
          blendTechniques.find((mode) => mode.value === settings.blendTechnique)?.description ?? '';
      }
      if (blendSoftnessLabel) {
        blendSoftnessLabel.hidden = settings.blendTechnique !== 2;
      }
      for (const [key, item] of sliderMap) {
        item.input.value = String(settings[key]);
        item.output.textContent = formatSliderOutput(settings[key], item.unit);
      }
      syncButtons();
    };

    syncControls();
    syncCaption();

    ditherBtn?.addEventListener('click', () => {
      dithered = !dithered;
      soundbar?.setDithered(dithered);
      syncButtons();
    });

    resetBtn?.addEventListener('click', () => {
      settings = { ...defaults };
      copied = false;
      saveSettings(settings);
      soundbar?.setSettings(settings);
      syncControls();
    });

    copyBtn?.addEventListener('click', () => {
      void (async () => {
        try {
          await navigator.clipboard.writeText(JSON.stringify(settings, null, 2));
          copied = true;
          syncButtons();
        } catch {
          error = 'Could not copy settings';
          syncCaption();
        }
      })();
    });

    let stopPlayer = () => {};
    const playerHost = document.createElement('div');
    if (!silent) {
      container.querySelector('.visual-lab')?.append(playerHost);
      stopPlayer = mountPlayer(playerHost, {
        onSnapshot(next) {
          snapshot = next;
          syncCaption();
        },
        onError(next) {
          error = next;
          syncCaption();
        },
        onState(next) {
          local = next;
          syncCaption();
        },
      });
    }

    return () => {
      stopPlayer();
      playerHost.remove();
      soundbar?.dispose();
      container.replaceChildren();
    };
  });
}
