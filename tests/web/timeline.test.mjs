// Run with node --test tests/web/timeline.test.mjs; no npm dependencies required.
import assert from 'node:assert/strict';
import test from 'node:test';
import { continuous, createTimeline } from '../../src/decision_pitch/web/src/timeline.js';

const STEP = 1 / 30;
const snapshot = (t, phase = 'play', period = 1) => ({ type: 'snapshot', t, phase, period });

// A deterministic stand-in for network and main-thread jitter.
function random(seed) {
  return () => {
    seed = (seed * 1664525 + 1013904223) % 4294967296;
    return seed / 4294967296;
  };
}

// Snapshots every STEP from t = 10, arriving `latency` plus up to `jitter` late; frames at 60 Hz.
function play(timeline, { seconds, jitter = 0.06, latency = 0.02, seed = 7, until = Infinity }) {
  const next = random(seed);
  const arrivals = [];
  for (let k = 0, at = 0; k * STEP < seconds; k++) {
    // One socket delivers in order: a late message holds up the ones behind it.
    at = Math.max(at, 500 + k * STEP + latency + next() * jitter);
    arrivals.push({ at, message: snapshot(10 + k * STEP) });
  }
  const frames = [];
  let a = 0;
  for (let now = 500; now < 500 + seconds; now += 1 / 60) {
    while (a < arrivals.length && arrivals[a].at <= now && arrivals[a].at < 500 + until) {
      timeline.push(arrivals[a].message, arrivals[a].at);
      a++;
    }
    const frame = timeline.sample(now);
    if (frame) frames.push({ now, ...frame });
  }
  return frames;
}

test('continuous blends only within one phase and period, going forward', () => {
  assert.equal(continuous(snapshot(1), snapshot(1.1)), true);
  assert.equal(continuous(snapshot(1), snapshot(1.1, 'corner')), false);
  assert.equal(continuous(snapshot(1, 'kickoff', 1), snapshot(1.1, 'kickoff', 2)), false);
  assert.equal(continuous(snapshot(1.1), snapshot(1)), false);
});

test('nothing to draw before the first snapshot', () => {
  const timeline = createTimeline();
  assert.equal(timeline.sample(1), null);
  assert.deepEqual(timeline.release(), []);
});

test('jittered arrivals are drawn at an even, monotonic pace a fixed delay behind', () => {
  const timeline = createTimeline();
  const frames = play(timeline, { seconds: 8 });
  const settled = frames.filter(frame => frame.now > 502);
  for (let i = 1; i < settled.length; i++) {
    const pace = (settled[i].time - settled[i - 1].time) / (settled[i].now - settled[i - 1].now);
    assert.ok(pace > 0.9 && pace < 1.1, `even pace, got ${pace} at frame ${i}`);
  }
  for (const frame of settled) {
    assert.ok(frame.after !== frame.before, 'never runs dry with 60 ms of jitter');
    assert.ok(frame.alpha >= 0 && frame.alpha <= 1);
    assert.ok(frame.before.t <= frame.time && frame.time <= frame.after.t);
    // On the server's clock, about the delay behind the least-delayed arrival.
    const behind = frame.now - 500 - 0.02 - (frame.time - 10);
    assert.ok(behind > 0.09 && behind < 0.16, `delay ${behind}`);
  }
});

test('the same arrivals interpolated by the last two snapshots stutter; the buffer does not', () => {
  // The old page: blend from the previous snapshot by time since the newest arrived.
  const next = random(3);
  const arrivals = [];
  for (let k = 0, at = 0; k < 240; k++) {
    at = Math.max(at, k * STEP + next() * 0.06);
    arrivals.push({ at, t: k * STEP });
  }
  let before = null; let after = null; let arrived = 0; let a = 0;
  const naive = [];
  const timeline = createTimeline();
  const buffered = [];
  for (let now = 0; now < 8; now += 1 / 60) {
    while (a < arrivals.length && arrivals[a].at <= now) {
      before = after; after = arrivals[a]; arrived = arrivals[a].at;
      timeline.push(snapshot(arrivals[a].t), arrivals[a].at);
      a++;
    }
    if (before && after) {
      const alpha = Math.min(1, (now - arrived) / (after.t - before.t));
      naive.push(before.t + (after.t - before.t) * alpha);
    }
    const frame = timeline.sample(now);
    if (frame) buffered.push(frame.time);
  }
  const worst = (times) => {
    let most = 0;
    for (let i = 61; i < times.length; i++) most = Math.max(most, Math.abs(times[i] - times[i - 1] - 1 / 60));
    return most;
  };
  assert.ok(worst(naive) > 0.02, 'the old approach shows uneven arrival');
  assert.ok(worst(buffered) < 0.003, `buffered motion is even, worst ${worst(buffered)}`);
});

test('a change of phase or period is held, never blended', () => {
  const timeline = createTimeline({ delay: 0 });
  timeline.push(snapshot(1, 'play'), 1);
  timeline.push(snapshot(1 + STEP, 'kickoff'), 1 + STEP);
  let frame = timeline.sample(1.01);
  assert.equal(frame.before.phase, 'play');
  assert.equal(frame.after, frame.before);
  assert.equal(frame.alpha, 1);
  frame = timeline.sample(1 + STEP);
  assert.equal(frame.before.phase, 'kickoff');
  timeline.push(snapshot(1 + 2 * STEP, 'kickoff', 2), 1 + 2 * STEP);
  frame = timeline.sample(1 + 1.5 * STEP);
  assert.equal(frame.before.period, 1);
  assert.equal(frame.after, frame.before, 'half time to the second half is held too');
});

test('a clock that goes back starts a new stream instead of blending backwards', () => {
  const timeline = createTimeline({ delay: 0 });
  timeline.push(snapshot(5), 0);
  timeline.push(snapshot(5 + STEP), STEP);
  timeline.pushEvent({ kind: 'corner', t: 5.5 }, STEP);
  timeline.push(snapshot(1), 0.1);
  assert.equal(timeline.size, 1);
  const frame = timeline.sample(0.1);
  assert.equal(frame.before.t, 1);
  assert.equal(frame.after, frame.before);
  assert.deepEqual(timeline.release(), [], 'the old stream\'s events are dropped');
});

test('a dry buffer holds the newest snapshot, then resumes without a jump', () => {
  const timeline = createTimeline();
  const frames = play(timeline, { seconds: 4, jitter: 0, until: 2 });
  const newest = frames.findLast(frame => frame.now < 502).latest;
  const dry = frames.filter(frame => frame.now > 502.3 && frame.now < 504);
  assert.ok(dry.length > 10);
  for (const frame of dry) {
    assert.equal(frame.before, newest);
    assert.equal(frame.after, newest);
    assert.equal(frame.time, newest.t, 'never runs past the data');
  }
  // A server that stalls 0.2 s sends what it owes in a burst, then keeps time again: play
  // pauses at the newest snapshot, then picks up where it stopped and catches up gradually.
  const resumed = createTimeline();
  for (let k = 0; k < 30; k++) resumed.push(snapshot(10 + k * STEP), 500 + k * STEP);
  let now = 500 + 29 * STEP;
  let time = resumed.sample(now).time;
  for (now += 1 / 60; now < 500 + 35 * STEP; now += 1 / 60) time = resumed.sample(now).time;
  let k = 30;
  for (; k <= 35; k++) resumed.push(snapshot(10 + k * STEP), now);
  for (let i = 0; i < 120; i++, now += 1 / 60) {
    for (; 500 + k * STEP <= now; k++) resumed.push(snapshot(10 + k * STEP), 500 + k * STEP);
    const next = resumed.sample(now).time;
    assert.ok(next - time >= 0 && next - time < 1 / 60 * 1.1, `no jump after a short gap: ${next - time}`);
    time = next;
  }
  assert.ok(now - 500 - (time - 10) < 0.15, 'caught up to about the delay');
});

test('after a long stall the backlog is dropped and play is live again', () => {
  const timeline = createTimeline();
  for (let k = 0; k < 60; k++) timeline.push(snapshot(10 + k * STEP), 500 + k * STEP);
  timeline.sample(500 + 59 * STEP);
  // A hidden page draws nothing for 20 s while snapshots keep arriving.
  for (let k = 60; k < 660; k++) timeline.push(snapshot(10 + k * STEP), 500 + k * STEP);
  assert.ok(timeline.size <= 4 * 30 + 3, `bounded buffer, ${timeline.size}`);
  const frame = timeline.sample(500 + 659 * STEP);
  assert.ok(Math.abs(frame.time - (10 + 659 * STEP - 0.1)) < 0.01, 'live again, a delay behind');
  assert.ok(timeline.size <= 5, 'the backlog behind the render time is gone');
});

test('events are released in order when the render time reaches them', () => {
  const timeline = createTimeline({ delay: 0.1 });
  for (let k = 0; k <= 30; k++) timeline.push(snapshot(10 + k * STEP), 500 + k * STEP);
  timeline.pushEvent({ kind: 'foul', t: 10.5 }, 500.5);
  timeline.pushEvent({ kind: 'yellow', t: 10.5 }, 500.5);
  timeline.pushEvent({ kind: 'free_kick', t: 10.6 }, 500.6);
  timeline.sample(500.55);
  assert.deepEqual(timeline.release(), [], 'the drawn ball has not got there yet');
  timeline.sample(500.601);
  assert.deepEqual(timeline.release().map(({ event, late }) => [event.kind, late]), [['foul', false], ['yellow', false]]);
  timeline.sample(500.69);
  assert.deepEqual(timeline.release(), []);
  timeline.sample(500.701);
  assert.deepEqual(timeline.release().map(({ event }) => event.kind), ['free_kick']);
});

test('events behind a stall are released at once and marked late', () => {
  const timeline = createTimeline();
  timeline.push(snapshot(10), 500);
  timeline.sample(500);
  timeline.pushEvent({ kind: 'substitution', t: 11 }, 501);
  timeline.pushEvent({ kind: 'goal', t: 20 }, 510);
  for (let k = 1; k <= 330; k++) timeline.push(snapshot(10 + k * STEP), 500 + k * STEP);
  timeline.sample(500 + 330 * STEP);
  assert.deepEqual(timeline.release().map(({ event, late }) => [event.kind, late]), [['substitution', true], ['goal', false]]);
});
