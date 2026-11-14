// Phase 4A: organizer controls at /admin. Composition only: data in state.ts, rules in derive.ts,
// command identity in intents.ts, markup in views.tsx. Rendered as an Astro React island
// (client:load): the gate/loading states are server-rendered, the console hydrates in place.
import { useEffect, useMemo, useReducer, useRef, useState } from 'react';
import type { QueueMode, Snapshot } from '../../../src/contract/types.ts';
import { Button } from '../components/ph/button.tsx';
import { Card } from '../components/ph/card.tsx';
import { DitheredSoup } from '../shared/DitheredSoup.tsx';
import {
  createAdminControls,
  createLiveAdmin,
  getServerNow,
  type ControlsHandle,
  type LiveHandle,
} from './state.ts';
import { estimatePosition, moveAnchor, optimisticIntent, waitingRequests } from './derive.ts';
import {
  AccessGate,
  ActivityPanel,
  AddBar,
  AlertsBand,
  BanMenu,
  HeaderMeta,
  NightPanel,
  NowPlayingPanel,
  QueueControls,
  RequestQueuePanel,
  MasterQueuePanel,
  TurnPanel,
} from './views.tsx';
import type { Actions } from './views.tsx';
import '../shared/ph-ui.css';
import './admin.css';

export function AdminPage() {
  const [, force] = useReducer((count: number) => count + 1, 0);
  const [live, setLive] = useState<LiveHandle | null>(null);
  const [controls, setControls] = useState<ControlsHandle | null>(null);

  useEffect(() => {
    const handle = createLiveAdmin(() => force());
    setLive(handle);
    return () => handle.dispose();
  }, []);
  useEffect(() => {
    if (!live) return;
    const handle = createAdminControls(live, () => force());
    setControls(handle);
    return () => handle.dispose();
  }, [live]);

  const [showActivity, setShowActivity] = useState(false);
  const [pendingVolume, setPendingVolume] = useState<number | null>(null);
  const [draggingSeek, setDraggingSeek] = useState<number | null>(null);
  const [addUrl, setAddUrl] = useState('');
  const [addSubmitting, setAddSubmitting] = useState<'master' | 'request' | null>(null);
  const [banOpen, setBanOpen] = useState(false);
  const [banUsername, setBanUsername] = useState('');
  const [qcConfirming, setQcConfirming] = useState(false);
  const [qcDraft, setQcDraft] = useState<string | null>(null);
  const [armedConfirm, setArmedConfirm] = useState<{ id: string; context: number | undefined } | null>(null);
  const [displayDelayed, setDisplayDelayed] = useState(false);
  const [localNow, setLocalNow] = useState(() => Date.now());
  const banMenuRef = useRef<HTMLDivElement>(null);

  const { runner, volume } = controls ?? { runner: null, volume: null };
  useEffect(() => {
    if (!volume) return;
    volume.onPending = setPendingVolume;
    return () => {
      volume.onPending = () => undefined;
    };
  }, [volume]);

  useEffect(() => {
    const timer = window.setInterval(() => setLocalNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  const actions = useMemo<Actions | null>(() => {
    if (!runner || !volume) return null;
    return {
      play: () => runner.run('Play', 'playback.play', {}),
      pause: () => runner.run('Pause', 'playback.pause', {}),
      skip: (entryId) => runner.run('Skip', 'playback.skip', { entryId }),
      replay: (entryId) => runner.run('Restart song', 'playback.seek', { entryId, positionSec: 0 }),
      seek: (entryId, positionSec) =>
        runner.run(
          `Seek to ${Math.floor(positionSec / 60)}:${String(Math.floor(positionSec % 60)).padStart(2, '0')}`,
          'playback.seek',
          { entryId, positionSec },
        ),
      setVolume: (v) => volume.set(v),
      beginVolume: () => volume.begin(),
      commitVolume: () => volume.flush(),
      openNight: () => runner.run('Start night', 'night.open', {}),
      // Strict CAS: if anything changed while the organizer was confirming, nothing is closed.
      closeNight: (expectedRevision) => runner.run('End night', 'night.close', {}, { expectedRevision }),
      addMaster: (url) => runner.run(`Add to master: ${url}`, 'master.add', { url }),
      addRequest: (url) => runner.run(`Add to requests: ${url}`, 'request.submit', { url }),
      removeMaster: (entryId, title) => runner.run(`Remove “${title}” from master`, 'master.remove', { entryId }),
      moveMaster: (entryId, afterEntryId, title) => runner.run(`Move “${title}”`, 'master.move', { entryId, afterEntryId }),
      setMode: (mode) =>
        runner.run(
          `Play from: ${{ auto: 'Auto', master: 'Master only', requests: 'Requests only' }[mode]}`,
          'queue.mode',
          { mode },
        ),
      setInterval: (periodMs) =>
        runner.run(
          periodMs === null ? 'Use the default request interval' : `Request every ${periodMs / 60_000} min`,
          'queue.interval',
          { periodMs },
        ),
      playNow: (entryId, title) => runner.run(`Play “${title}” now`, 'request.playNow', { entryId }),
      removeRequest: (entryId, title) => runner.run(`Remove request “${title}”`, 'request.remove', { entryId }),
      moveRequest: (entryId, afterEntryId, title) => runner.run(`Move request “${title}”`, 'request.move', { entryId, afterEntryId }),
      banUsername: (username) => runner.run(`Ban PH ID username ${username}`, 'requester.ban', { username }),
      unbanUsername: (username) => runner.run(`Unban PH ID username ${username}`, 'requester.unban', { username }),
      retry: (id) => void runner.retry(id),
    };
  }, [runner, volume]);

  const snapshot = live?.snapshot ?? null;
  const serverNow = live ? getServerNow(live, localNow) : localNow;
  const intents = controls?.intents ?? [];

  // 15-second DisplayWait delay timer keyed on playback.desiredEpoch while waiting.
  const confirmation = snapshot?.playback.confirmation;
  const waitingAck = confirmation === 'requested' || confirmation === 'unconfirmed';
  const desiredEpoch = snapshot?.playback.desiredEpoch ?? null;
  useEffect(() => {
    if (!waitingAck) {
      setDisplayDelayed(false);
      return;
    }
    setDisplayDelayed(false);
    const timer = window.setTimeout(() => setDisplayDelayed(true), 15_000);
    return () => window.clearTimeout(timer);
  }, [waitingAck, desiredEpoch]);

  // Keep the interval draft in sync with the server value until the organizer edits it.
  const currentMinutes = snapshot ? Math.round(snapshot.schedule.periodMs / 60_000) : null;
  useEffect(() => {
    if (currentMinutes !== null) setQcDraft(String(currentMinutes));
  }, [currentMinutes]);

  // Close the ban submenu on Escape or an outside pointer press.
  useEffect(() => {
    if (!banOpen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setBanOpen(false);
    };
    const onPointer = (event: PointerEvent) => {
      if (banMenuRef.current && !banMenuRef.current.contains(event.target as Node)) setBanOpen(false);
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onPointer);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerdown', onPointer);
    };
  }, [banOpen]);

  const submitAdd = (next: 'master' | 'request') => {
    if (!actions) return;
    const value = addUrl.trim();
    const adds = intents.filter((i) => i.type === 'master.add' || i.type === 'request.submit');
    const lastAdd = adds.find((i) => i.status === 'pending') ?? adds[0] ?? null;
    if (!value || lastAdd?.status === 'pending' || addSubmitting !== null) return;
    setAddSubmitting(next);
    void (next === 'master' ? actions.addMaster(value) : actions.addRequest(value))
      .then((intent) => {
        if (intent.status === 'ok') setAddUrl('');
      })
      .finally(() => setAddSubmitting(null));
  };

  const commitSeek = () => {
    if (!actions || draggingSeek === null || !snapshot?.nowPlaying) return;
    const pos = draggingSeek;
    setDraggingSeek(null);
    void actions.seek(snapshot.nowPlaying.entryId, pos);
  };

  const relSeek = (delta: number) => {
    if (!actions || !snapshot?.nowPlaying) return;
    const pos = estimatePosition(snapshot, serverNow);
    const seekIntent = optimisticIntent(snapshot, intents, ['playback.seek']);
    const seek = seekIntent?.payload as { entryId: string; positionSec: number } | undefined;
    const localPosition = seek?.entryId === snapshot.nowPlaying.entryId ? seek.positionSec : undefined;
    const base = draggingSeek ?? localPosition ?? pos.positionSec ?? 0;
    void actions.seek(snapshot.nowPlaying.entryId, Math.max(0, base + delta));
  };

  const executeConfirm = (id: string, context: number | undefined) => {
    if (!actions || !snapshot) return;
    if (id === 'night-close') {
      void actions.closeNight(context ?? snapshot.revision);
      return;
    }
    if (id === 'skip-now' && snapshot.nowPlaying) {
      void actions.skip(snapshot.nowPlaying.entryId);
      return;
    }
    if (id.startsWith('master-remove:')) {
      const entryId = id.slice('master-remove:'.length);
      const item = (snapshot.master ?? []).find((m) => m.id === entryId);
      if (item) void actions.removeMaster(entryId, item.title);
      return;
    }
    if (id.startsWith('request-playNow:')) {
      const entryId = id.slice('request-playNow:'.length);
      const item = waitingRequests(snapshot).find((r) => r.id === entryId);
      if (item) void actions.playNow(entryId, item.title);
      return;
    }
    if (id.startsWith('request-remove:')) {
      const entryId = id.slice('request-remove:'.length);
      const item = snapshot.requests.find((r) => r.id === entryId);
      if (item) void actions.removeRequest(entryId, item.title);
    }
  };

  const onRootClick = (event: React.MouseEvent) => {
    if (!actions || !snapshot) return;
    const target = event.target as HTMLElement | null;
    if (!target) return;

    const armBtn = target.closest<HTMLElement>('[data-confirm-arm]');
    if (armBtn?.dataset.confirmArm) {
      const ctxRaw = armBtn.dataset.confirmContext;
      const ctx = ctxRaw !== undefined && ctxRaw !== '' ? Number(ctxRaw) : undefined;
      setArmedConfirm({ id: armBtn.dataset.confirmArm, context: ctx });
      return;
    }
    if (target.closest('[data-confirm-cancel]')) {
      setArmedConfirm(null);
      return;
    }
    const execBtn = target.closest<HTMLElement>('[data-confirm-exec]');
    if (execBtn?.dataset.confirmExec) {
      const id = execBtn.dataset.confirmExec;
      const ctx = armedConfirm?.id === id ? armedConfirm.context : undefined;
      setArmedConfirm(null);
      executeConfirm(id, ctx);
      return;
    }

    if (target.closest('[data-adm-sign-out]')) {
      void (async () => {
        await fetch('/auth/logout', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: '{}',
        });
        live?.recheck();
      })();
      return;
    }
    if (target.closest('[data-adm-ack-external]')) {
      live?.ackExternal();
      return;
    }
    if (target.closest('[data-adm-night-open]')) {
      void actions.openNight();
      return;
    }
    if (target.closest('[data-adm-play]')) {
      void actions.play();
      return;
    }
    if (target.closest('[data-adm-pause]')) {
      void actions.pause();
      return;
    }
    const replayBtn = target.closest<HTMLElement>('[data-adm-replay]');
    if (replayBtn?.dataset.admReplay) {
      void actions.replay(replayBtn.dataset.admReplay);
      return;
    }
    const relBtn = target.closest<HTMLElement>('[data-adm-seek-rel]');
    if (relBtn?.dataset.admSeekRel) {
      relSeek(Number(relBtn.dataset.admSeekRel));
      return;
    }
    const unbanBtn = target.closest<HTMLElement>('[data-adm-unban]');
    if (unbanBtn?.dataset.admUnban) {
      void actions.unbanUsername(unbanBtn.dataset.admUnban);
      return;
    }
    if (target.closest('[data-adm-ban-toggle]')) {
      setBanOpen((open) => !open);
      return;
    }

    const modeBtn = target.closest<HTMLElement>('[data-mode]');
    if (modeBtn?.dataset.mode) {
      const next = modeBtn.dataset.mode as QueueMode;
      const pendingMode = optimisticIntent(snapshot, intents, ['queue.mode'])?.payload as
        | { mode: QueueMode }
        | undefined;
      const curMode = pendingMode?.mode ?? snapshot.schedule.mode;
      const current = snapshot.schedule.phase === 'master' ? snapshot.nowPlaying : null;
      if (next === 'requests' && current) {
        setQcConfirming(true);
        return;
      }
      setQcConfirming(false);
      if (next !== curMode) void actions.setMode(next);
      return;
    }
    if (target.closest('[data-adm-confirm-requests-only]')) {
      setQcConfirming(false);
      void actions.setMode('requests');
      return;
    }
    if (target.closest('[data-adm-cancel-requests-only]')) {
      setQcConfirming(false);
      return;
    }

    const moveBtn = target.closest<HTMLElement>('[data-adm-move-queue]');
    if (moveBtn?.dataset.admMoveQueue && moveBtn.dataset.admMoveId && moveBtn.dataset.admMoveDir) {
      const queue = moveBtn.dataset.admMoveQueue as 'master' | 'request';
      const entryId = moveBtn.dataset.admMoveId;
      const dir = moveBtn.dataset.admMoveDir as 'up' | 'down';
      if (queue === 'master') {
        const list = snapshot.master ?? [];
        const index = list.findIndex((m) => m.id === entryId);
        const ids = list.map((m) => m.id);
        const anchor = index >= 0 ? moveAnchor(ids, index, dir) : null;
        if (anchor && list[index]) void actions.moveMaster(entryId, anchor.afterEntryId, list[index]!.title);
      } else {
        const list = waitingRequests(snapshot);
        const index = list.findIndex((r) => r.id === entryId);
        const ids = list.map((r) => r.id);
        const anchor = index >= 0 ? moveAnchor(ids, index, dir) : null;
        if (anchor && list[index]) void actions.moveRequest(entryId, anchor.afterEntryId, list[index]!.title);
      }
      return;
    }

    const retryBtn = target.closest<HTMLElement>('[data-adm-retry]');
    if (retryBtn?.dataset.admRetry) {
      actions.retry(retryBtn.dataset.admRetry);
    }
  };

  const onRootSubmit = (event: React.FormEvent<HTMLDivElement>) => {
    event.preventDefault();
    if (!actions || !snapshot) return;
    const form = event.target as HTMLFormElement;
    if (form.classList.contains('adm-add')) {
      submitAdd('master');
      return;
    }
    if (form.hasAttribute('data-adm-interval-form')) {
      const minM = Math.ceil(snapshot.schedule.periodMinMs / 60_000);
      const maxM = Math.floor(snapshot.schedule.periodMaxMs / 60_000);
      const draft = qcDraft ?? '';
      const minutes = Number(draft);
      if (draft.trim() !== '' && Number.isInteger(minutes) && minutes >= minM && minutes <= maxM) {
        void actions.setInterval(minutes * 60_000);
      }
      return;
    }
    if (form.hasAttribute('data-adm-ban-form')) {
      const value = banUsername.trim();
      if (!/^[a-zA-Z0-9._-]{1,40}$/.test(value)) return;
      void actions.banUsername(value).then((intent) => {
        if (intent.status === 'ok') setBanUsername('');
      });
    }
  };

  const onRootChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    if (!actions) return;
    const id = event.target.id;
    if (id === 'adm-add-url') setAddUrl(event.target.value);
    else if (id === 'adm-interval') setQcDraft(event.target.value);
    else if (id === 'adm-ban-username') setBanUsername(event.target.value);
    else if (id === 'adm-seek') setDraggingSeek(Number(event.target.value));
    else if (id === 'adm-volume') actions.setVolume(Number(event.target.value) / 100);
  };

  if (!live || !actions) {
    return (
      <main className="ph-ui dark adm-root" aria-busy="true">
        <DitheredSoup fgColor="#897309" />
        <div className="adm-shell">
          <Card className="adm-card adm-gate">
            <p>Checking your sign-in…</p>
          </Card>
        </div>
      </main>
    );
  }
  if (live.access.state !== 'admin') {
    return (
      <>
        <DitheredSoup fgColor="#897309" />
        <AccessGate access={live.access} onRetry={live.recheck} />
      </>
    );
  }
  if (!snapshot) {
    return (
      <main className="ph-ui dark adm-root" aria-busy="true">
        <DitheredSoup fgColor="#897309" />
        <div className="adm-shell">
          <Card className="adm-card adm-gate">
            <p>Loading…</p>
          </Card>
        </div>
      </main>
    );
  }

  const adds = intents.filter((i) => i.type === 'master.add' || i.type === 'request.submit');
  const lastAdd = adds.find((i) => i.status === 'pending') ?? adds[0] ?? null;
  const accessName = live.access.state === 'admin' ? live.access.name : 'organizer';

  return (
    <div
      className="ph-ui dark adm-root"
      id="admin-page"
      onClick={onRootClick}
      onSubmit={onRootSubmit}
      onChange={onRootChange}
    >
      <DitheredSoup fgColor="#897309" />
      <div className="adm-shell">
        <header className="adm-header">
          <h1 className="adm-headline adm-h1">Jukebox</h1>
          <NightPanel snapshot={snapshot} armed={armedConfirm?.id === 'night-close'} />
          <div ref={banMenuRef} style={{ display: 'contents' }}>
            <BanMenu snapshot={snapshot} open={banOpen} username={banUsername} onUsernameChange={setBanUsername} />
          </div>
          <Button
            variant="outline"
            aria-expanded={showActivity}
            aria-controls="adm-activity"
            data-adm-activity-toggle="true"
            onClick={() => setShowActivity((shown) => !shown)}
          >
            {showActivity ? 'Hide activity log' : 'Show activity log'}
          </Button>
          <div className="adm-header-meta">
            <HeaderMeta name={accessName} link={live.link} linkError={live.linkError} />
          </div>
        </header>
        <AlertsBand snapshot={snapshot} link={live.link} external={live.externalChange} onAckExternal={live.ackExternal} />
        <NowPlayingPanel
          snapshot={snapshot}
          serverNow={serverNow}
          pendingVolume={pendingVolume}
          intents={intents}
          dragging={draggingSeek}
          displayDelayed={displayDelayed}
          armedSkip={armedConfirm?.id === 'skip-now'}
          onSeekChange={setDraggingSeek}
          onSeekCommit={commitSeek}
          onVolumeBegin={actions.beginVolume}
          onVolumeChange={actions.setVolume}
          onVolumeCommit={actions.commitVolume}
        >
          <TurnPanel snapshot={snapshot} serverNow={serverNow} />
        </NowPlayingPanel>
        <AddBar
          lastAdd={lastAdd}
          nightOpen={snapshot.night?.status === 'open'}
          url={addUrl}
          submitting={addSubmitting}
          onUrlChange={setAddUrl}
          onSubmitMaster={() => submitAdd('master')}
          onAddRequest={() => submitAdd('request')}
        >
          <QueueControls
            snapshot={snapshot}
            serverNow={serverNow}
            intents={intents}
            draft={qcDraft ?? undefined}
            confirming={qcConfirming}
            onDraftChange={setQcDraft}
          />
        </AddBar>
        <div className="adm-queues">
          <MasterQueuePanel snapshot={snapshot} armedId={armedConfirm?.id ?? null} />
          <RequestQueuePanel snapshot={snapshot} armedId={armedConfirm?.id ?? null} />
        </div>
        <ActivityPanel
          intents={intents}
          hidden={!showActivity}
          activity={snapshot.queueActivity}
          actorName={accessName}
        />
        <footer className="adm-credits">
          Icons:{' '}
          <a href="https://github.com/hackernoon/pixel-icon-library" target="_blank" rel="noreferrer">
            HackerNoon Pixel Icon Library
          </a>{' '}
          ·{' '}
          <a href="https://creativecommons.org/licenses/by/4.0/" target="_blank" rel="noreferrer">
            CC BY 4.0
          </a>
        </footer>
      </div>
    </div>
  );
}
