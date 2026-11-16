import { useState } from 'react';
import { DisplayView, isFixtureState } from './DisplayPage.tsx';
import { displayFixture, fixtureStates, type FixtureState } from './fixtures.ts';

/** Loaded only by the dev-server fixture query. Never mounts a player. */
export function FixtureView({ initial }: { initial: string }) {
  const [state, setState] = useState<FixtureState>(isFixtureState(initial) ? initial : 'master');
  const [now] = useState(Date.now());
  return (
    <>
      <DisplayView
        snapshot={displayFixture(state, now)}
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
      </div>
    </>
  );
}
