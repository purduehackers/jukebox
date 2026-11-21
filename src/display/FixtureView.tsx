import { useState } from 'react';
import type { VisualizerMode } from '../contract/types.ts';
import { DisplayView, isFixtureState } from './DisplayPage.tsx';
import { displayFixture, fixtureStates, type FixtureState } from './fixtures.ts';

/** Loaded only by the dev-server fixture query. Never mounts a player. */
export function FixtureView({ initial }: { initial: string }) {
  const [state, setState] = useState<FixtureState>(isFixtureState(initial) ? initial : 'master');
  const [visualizerMode, setVisualizerMode] = useState<VisualizerMode>('soundbar');
  const [presetNonce, setPresetNonce] = useState(0);
  const [now] = useState(Date.now());
  const snapshot = {
    ...displayFixture(state, now),
    visualizer: { mode: visualizerMode, preset: null, presetNonce },
  };
  return (
    <>
      <DisplayView
        snapshot={snapshot}
        error={state === 'disconnected' ? 'Fixture connection failure' : null}
        now={now}
      />
      <div className="display-fixture-control">
        <label>
          DEV SNAPSHOT · no playback{' '}
          <select value={state} onChange={(event) => setState(event.target.value as FixtureState)}>
            {fixtureStates.map((name) => (
              <option key={name}>{name}</option>
            ))}
          </select>
        </label>
        {' '}
        <label>
          Visualizer{' '}
          <select
            value={visualizerMode}
            onChange={(event) => setVisualizerMode(event.target.value as VisualizerMode)}
          >
            <option value="soundbar">soundbar</option>
            <option value="milkdrop">milkdrop</option>
          </select>
        </label>
        {visualizerMode === 'milkdrop' && (
          <>
            {' '}
            <button type="button" onClick={() => setPresetNonce((n) => n + 1)}>
              Next preset
            </button>
          </>
        )}
      </div>
    </>
  );
}
