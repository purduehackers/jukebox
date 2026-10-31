import test from 'node:test';
import assert from 'node:assert/strict';
import {turnDecision, PERIOD_MS} from '../web/turn.js';
const base = {now:PERIOD_MS,periodStarted:0,role:'master',paused:false,duration:3600,ended:false,hasRequest:true};
test('mix interrupts, <=6 minute song finishes, strict boundary', () => {
  assert.equal(turnDecision(base),'start-request');
  assert.equal(turnDecision({...base,duration:360}),'due-song-end');
  assert.equal(turnDecision({...base,duration:360,ended:true}),'start-request');
  assert.equal(turnDecision({...base,duration:360.001}),'start-request');
});
test('pause waits; buffering (not deliberate pause) still counts elapsed', () => {
  assert.equal(turnDecision({...base,paused:true}),'due-paused');
  assert.equal(turnDecision({...base,now:PERIOD_MS-1}),'wait');
  assert.equal(turnDecision({...base,paused:false}),'start-request');
});
test('empty 9:15 resets; late 9:17 waits for 9:30', () => {
  assert.equal(turnDecision({...base,hasRequest:false}),'empty-reset');
  assert.equal(turnDecision({...base,hasRequest:false,paused:true}),'empty-reset');
  assert.equal(turnDecision({...base,periodStarted:PERIOD_MS,now:PERIOD_MS+300000,paused:false}),'wait');
  assert.equal(turnDecision({...base,periodStarted:PERIOD_MS,now:PERIOD_MS+120000}),'wait');
  assert.equal(turnDecision({...base,periodStarted:PERIOD_MS,now:PERIOD_MS*2}),'start-request');
});
test('an ended deliberate pause never restarts audio by itself', () => {
  assert.equal(turnDecision({...base,paused:true,ended:true,now:1}),'wait');
  assert.equal(turnDecision({...base,paused:true,ended:true,hasRequest:false}),'empty-reset');
  assert.equal(turnDecision({...base,role:'request',paused:true,ended:true}),'wait');
});
test('exactly one request, fresh interval after return, seek cannot change elapsed input', () => {
  assert.equal(turnDecision({...base,role:'request',ended:false}),'wait');
  assert.equal(turnDecision({...base,role:'request',ended:true}),'resume-master');
  assert.equal(turnDecision({...base,periodStarted:PERIOD_MS}),'wait');
  assert.equal(turnDecision({...base,now:100,position:3500}),'wait');
});
