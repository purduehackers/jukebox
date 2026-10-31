import {turnDecision, PERIOD_MS} from './turn.js';

const $ = id => document.getElementById(id);
const audio = $('audio');
audio.volume = .2;
let state, revision = 0, owned = false, swapping = false, context, analyser, mediaNode;
let assets = [], chain = Promise.resolve(), heartbeatPending = false, tickPending = false;
// A fresh document has a fresh lease identity, including duplicated tabs.
const token = crypto.randomUUID();
const events = [], measurements = [];
let rms = 0, peakRms = 0, dominantHz = 0;

function log(type, details = {}) {
  events.push({at: new Date().toISOString(), type, ...details});
  if (events.length > 100) events.shift();
  $('events').textContent = events.slice(-25).map(e => JSON.stringify(e)).join('\n');
}
function fail(error) {
  audio.pause(); owned = false;
  if (state) { state.paused = true; state.observation = 'error'; }
  $('error').textContent = error.message;
  log('halted', {error: error.message});
  render();
}
function enqueue(fn) {
  chain = chain.then(fn).catch(fail);
  return chain;
}
async function api(path, body) {
  const response = await fetch('/api/' + path, {method: body ? 'POST' : 'GET',
    headers: body ? {'Content-Type': 'application/json'} : {},
    body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(4000)});
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
  return result;
}
const now = () => Date.now() + (state?.offsetMs || 0);
const asset = id => assets.find(item => item.id === id);
const current = () => asset(state?.role === 'request' ? state.requestId : state?.masterId);
function requireOwner() { if (!owned) throw new Error('Activate this tab first'); }
async function save(observation) {
  requireOwner();
  if (observation) state.observation = observation;
  state.commandId = crypto.randomUUID();
  const result = await api('checkpoint', {token, revision, state});
  revision = result.revision;
  log('checkpoint-ack', {commandId: state.commandId, revision, role: state.role, position: state.position});
}
function samplePosition() {
  if (!swapping && Number.isFinite(audio.currentTime) && audio.readyState >= 1) {
    state.position = audio.currentTime;
    if (state.role === 'master') state.masterPosition = state.position;
  }
}
function analysis() {
  if (!context) {
    context = new AudioContext();
    mediaNode = context.createMediaElementSource(audio);
    analyser = context.createAnalyser();
    analyser.fftSize = 2048;
    mediaNode.connect(analyser);
    analyser.connect(context.destination);
    const values = new Float32Array(analyser.fftSize);
    const spectrum = new Float32Array(analyser.frequencyBinCount);
    const draw = () => {
      analyser.getFloatTimeDomainData(values);
      rms = Math.sqrt(values.reduce((sum, v) => sum + v*v, 0) / values.length);
      peakRms = Math.max(peakRms, rms);
      analyser.getFloatFrequencyData(spectrum);
      let loudest = 0;
      for (let i = 1; i < spectrum.length; i++) if (spectrum[i] > spectrum[loudest]) loudest = i;
      dominantHz = rms > .00001 ? loudest * context.sampleRate / analyser.fftSize : 0;
      $('rms').value = rms;
      $('analysis').textContent = ` RMS ${rms.toFixed(5)} · peak ${peakRms.toFixed(5)} · ${dominantHz.toFixed(0)} Hz · ${context.state}`;
      requestAnimationFrame(draw);
    };
    draw();
  }
  return context.resume(); // invoked immediately in the activation gesture
}
function mediaEvent(name, act) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error(`Timed out waiting for ${name}`)), 8000);
    const ok = () => finish();
    const bad = () => finish(new Error(`Audio failed (${audio.error?.code}): ${audio.error?.message || 'unknown'}`));
    function finish(error) {
      clearTimeout(timer); audio.removeEventListener(name, ok); audio.removeEventListener('error', bad);
      error ? reject(error) : resolve();
    }
    audio.addEventListener(name, ok, {once:true});
    audio.addEventListener('error', bad, {once:true});
    try { act(); } catch (e) { finish(e); }
  });
}
async function playBounded() {
  let timer;
  try {
    await Promise.race([audio.play(), new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('Play timed out')), 8000);
    })]);
  } catch (error) {
    audio.pause();
    throw error;
  } finally { clearTimeout(timer); }
}
async function load(position, shouldPlay) {
  const item = current();
  if (!item) throw new Error('Selected media missing; prepare it again');
  swapping = true;
  const started = performance.now();
  try {
    audio.pause();
    await mediaEvent('loadedmetadata', () => { audio.src = item.url; audio.load(); });
    const target = Math.min(position, Math.max(0, audio.duration - .01));
    if (target > 0) await mediaEvent('seeked', () => { audio.currentTime = target; });
    const actual = audio.currentTime;
    if (Math.abs(actual - target) > .35) throw new Error('Seek failed practical 350ms tolerance');
    const measurement = {role: state.role, requested: target, actual,
      errorSeconds: Math.abs(actual-target), loadSeekMs: performance.now()-started, mime: item.mime, codec: item.codec};
    measurements.push(measurement);
    if (measurements.length > 100) measurements.shift();
    log('ready-seeked', measurement);
    state.position = actual;
    if (state.role === 'master') state.masterPosition = actual;
    // Recheck authority after potentially slow metadata/seek work, before audio.
    await save('ready-seeked');
    if (shouldPlay) {
      await playBounded();
      log('play-ack', {paused: audio.paused, position: audio.currentTime});
    }
    state.paused = !shouldPlay;
    await save(shouldPlay ? 'playing' : 'ready-paused');
  } finally { swapping = false; }
}
async function loadBounded(position, shouldPlay) {
  for (let attempt = 1; attempt <= 2; attempt++) {
    try { await load(position, shouldPlay); return; }
    catch (e) {
      audio.pause(); log('load-failed', {attempt, error: e.message});
      if (!owned) throw e;
      if (attempt === 2) {
        if (state.role === 'request') { await returnMaster('request-technical-failure'); return; }
        state.paused = true; await save('master-error'); throw e;
      }
    }
  }
}
async function startRequest() {
  audio.pause(); // freeze actual position before checkpoint and source swap
  samplePosition();
  state.masterPosition = current().duration <= 360 && audio.ended ? 0 : state.position;
  state.role = 'request'; state.position = 0;
  await save('switching-to-request'); // atomically pins suspended master + request BEFORE loading
  await loadBounded(0, true);
}
async function returnMaster(reason) {
  audio.pause();
  const saved = state.masterPosition;
  log(reason, {savedMasterPosition: saved});
  state.role = 'master'; state.requestId = null;
  state.position = saved; state.periodStarted = now();
  await save('returning-to-master');
  await loadBounded(saved, true);
  log('master-resumed', {saved, actual: audio.currentTime});
}
async function tick() {
  if (!owned || swapping || !current()) return;
  const decision = turnDecision({now:now(), periodStarted:state.periodStarted, role:state.role,
    paused:state.paused, duration:current().duration, ended:audio.ended, hasRequest:!!state.requestId});
  if (decision === 'start-request') await startRequest();
  else if (decision === 'resume-master') await returnMaster('request-ended');
  else if (decision === 'empty-reset' || decision === 'reset-and-loop') {
    state.periodStarted = now(); samplePosition(); await save('empty-turn-reset');
    log('empty-turn-reset');
    if (decision === 'reset-and-loop') await loadBounded(0, true);
  } else if (decision === 'loop-master') await loadBounded(0, true);
  render(decision);
}
async function refresh() {
  const result = await api('status');
  assets = result.assets;
  if (!state) { state = result.player.state; revision = result.player.revision; }
  for (const [id, kind] of [['master','master'],['request','request']]) {
    const select = $(id), previous = select.value;
    const items = assets.filter(a => a.kind === kind);
    const desired = [...(id === 'request' ? [''] : []), ...items.map(a => a.id)];
    if (JSON.stringify([...select.options].map(o => o.value)) === JSON.stringify(desired)) continue;
    select.replaceChildren();
    if (id === 'request') select.add(new Option('Empty turn', ''));
    for (const item of items) {
      select.add(new Option(`${item.source} · ${item.codec} · ${item.duration.toFixed(2)}s · ${item.id.slice(0,8)}`, item.id));
    }
    if ([...select.options].some(o => o.value === previous)) select.value = previous;
    else if (state[id+'Id']) select.value = state[id+'Id'];
  }
  $('jobs').textContent = result.jobs.slice(0,8).map(j => `${j.id.slice(0,8)} ${j.status} ${j.source}${j.error ? '\n'+j.error : ''}`).join('\n') || 'No preparation jobs yet.';
  $('assets').replaceChildren();
  for (const item of assets) {
    const row = document.createElement('div');
    const text = document.createElement('span');
    text.textContent = `${item.id.slice(0,8)} · ${item.source} · ${item.bytes} bytes · prepared ${item.preparationSeconds}s · ${item.pinned?'PINNED':'unused'} `;
    const remove = document.createElement('button'); remove.textContent = 'Delete'; remove.disabled = item.pinned;
    remove.onclick = () => enqueue(async () => { await api('delete',{id:item.id}); await refresh(); });
    row.append(text, remove); $('assets').append(row);
  }
  render();
}
function render(decision = '') {
  $('playback').textContent = `${owned?'This tab owns local proof playback':'Activation required'} · ${state?.role || 'idle'} · ${audio.currentTime.toFixed(3)} / ${Number.isFinite(audio.duration)?audio.duration.toFixed(3):'?'}s · ${audio.paused?'paused':'playing'} ${decision}`;
  $('checkpoint').textContent = JSON.stringify({revision, remainingElapsedSeconds: state?.periodStarted === null ? null : Math.max(0,(PERIOD_MS-(now()-state?.periodStarted))/1000), state}, null, 2);
}
$('prepare').onclick = () => enqueue(async () => {
  const job = await api('prepare',{source:$('source').value,kind:$('kind').value}); log('job-accepted',job); await refresh();
});
$('cleanup').onclick = () => enqueue(async () => { await api('cleanup',{}); await refresh(); });
$('activate').onclick = () => {
  const masterId = $('master').value, requestId = $('request').value || null;
  const resumed = analysis();
  enqueue(async () => {
    await resumed;
    const claimed = await api('claim', {token});
    state = claimed.state; revision = claimed.revision; owned = true; $('error').textContent = '';
    if (!masterId) throw new Error('Prepare/select a master first');
    if (state.masterId !== masterId) {
      state = {...state, masterId, requestId, role:'master', position:0, masterPosition:0,
        periodStarted:now(), paused:false};
    }
    if (state.periodStarted === null) state.periodStarted = now();
    await save('activated');
    await loadBounded(state.position, true);
    await tick(); await refresh();
  });
};
$('offer').onclick = () => enqueue(async () => {
  requireOwner(); if (state.role !== 'master') throw new Error('Only one request per turn');
  state.requestId = $('request').value || null; samplePosition(); await save('request-offered'); await tick(); await refresh();
});
$('pause').onclick = () => enqueue(async () => { requireOwner(); audio.pause(); samplePosition(); state.paused = true; await save('deliberate-pause'); render(); });
$('resume').onclick = () => {
  const resumed = analysis();
  enqueue(async () => { requireOwner(); await resumed; state.paused = false; await tick();
    if (!audio.ended) await playBounded(); samplePosition(); await save('playing'); render(); });
};
$('seekButton').onclick = () => enqueue(async () => {
  requireOwner(); const target = Number($('seek').value);
  if (!Number.isFinite(target) || target < 0 || target >= audio.duration) throw new Error('Seek must be inside current duration');
  await mediaEvent('seeked', () => { audio.currentTime = target; }); samplePosition(); await save('seeked'); render();
});
$('volume').oninput = () => { audio.volume = Number($('volume').value); };
$('advance').onclick = () => enqueue(async () => { requireOwner(); state.offsetMs += PERIOD_MS; samplePosition(); await save('test-clock-advanced'); await tick(); });
$('release').onclick = () => enqueue(async () => {
  requireOwner(); audio.pause(); samplePosition(); state.paused = true; await save('released-paused');
  await api('release',{token}); owned = false; render();
});
$('reset').onclick = () => enqueue(async () => {
  requireOwner(); audio.pause(); state = {...state,masterId:null,requestId:null,role:'master',position:0,masterPosition:0,paused:true,periodStarted:null,offsetMs:0};
  await save('cleared'); await api('release',{token}); owned = false; audio.removeAttribute('src'); audio.load(); await refresh();
});
for (const name of ['loadedmetadata','playing','pause','waiting','stalled','seeking','seeked','ended','error']) {
  audio.addEventListener(name, () => {
    log(name, {position:audio.currentTime, duration:Number.isFinite(audio.duration)?audio.duration:null});
    if (name === 'error' && owned && !swapping) enqueue(async () => {
      if (state.role === 'request') await returnMaster('request-runtime-error');
      else { audio.pause(); samplePosition(); state.paused = true; await save('master-error'); throw new Error('Master media failed; activate to retry'); }
    });
  });
}
// Stop locally if checkpoint/lease renewal fails. Do not continue unacknowledged audio.
setInterval(() => {
  if (!owned || heartbeatPending) return;
  heartbeatPending = true;
  enqueue(async () => { try { if (!owned) return; samplePosition(); await save(state.paused?'paused':audio.readyState<3?'buffering':'playing'); }
    finally { heartbeatPending = false; } });
}, 1000);
setInterval(() => {
  if (tickPending) return;
  tickPending = true;
  enqueue(async () => { try { await tick(); } finally { tickPending = false; } });
}, 200);
setInterval(() => { if (['master','request'].includes(document.activeElement?.id)) return; refresh().catch(e => { $('error').textContent = e.message; }); }, 3000);
window.addEventListener('pagehide', () => {
  audio.pause();
  if (owned) fetch('/api/release', {method:'POST', headers:{'Content-Type':'application/json'},
    body:JSON.stringify({token}), keepalive:true}).catch(() => {});
});
// Read-only inspection for the Firefox verification script; all actions use visible UI.
window.proof = {inspect: () => ({state:structuredClone(state),revision,owned,swapping,
  currentTime:audio.currentTime,duration:audio.duration,paused:audio.paused,readyState:audio.readyState,
  rms,peakRms,dominantHz,contextState:context?.state,events:structuredClone(events),measurements:structuredClone(measurements)})};
await refresh();
