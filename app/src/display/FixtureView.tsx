import { useState } from 'react';
import { DisplayView } from './DisplayPage.tsx';
import { displayFixture, fixtureStates } from './fixtures.ts';
import type { FixtureState } from './fixtures.ts';

/** Loaded only by the dev-server fixture query. Never mounts a player. */
export function FixtureView() {
  const query = new URLSearchParams(location.search).get('displayFixture');
  const initial = fixtureStates.includes(query as FixtureState) ? query as FixtureState : 'master';
  const [state, setState] = useState<FixtureState>(initial);
  const [now] = useState(Date.now());
  return <><DisplayView snapshot={displayFixture(state, now)} error={state === 'disconnected' ? 'Fixture connection failure' : null} now={now} />
    <div className="display-fixture-control"><label>DEV SNAPSHOT · no playback <select value={state} onChange={(e) => setState(e.target.value as FixtureState)}>{fixtureStates.map((name) => <option key={name}>{name}</option>)}</select></label></div>
  </>;
}
