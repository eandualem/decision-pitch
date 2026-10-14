// Plays the match a short, fixed delay behind the newest snapshot, so snapshots that
// arrive unevenly are still drawn evenly. Times are seconds: `now` on the page's clock,
// `t` on the server's match clock. No three.js here, so it can be tested on its own.

const DELAY = 0.1; // s behind the newest snapshot: about three snapshots of slack
const WINDOW = 1; // s of arrivals the clock offset is judged over
const SLEW = 0.08; // s per s the render clock may run fast or slow to follow the offset
const SNAP = 0.25; // s off beyond which the render clock jumps instead (start, stall)
const KEEP = 4; // s of snapshots kept: a hidden page's backlog is dropped beyond it
const LATE = 1; // s behind the render time after which a released event is stale
const MOST_EVENTS = 1000;

// Two snapshots may be blended only within one phase of one period, going forward:
// a restart that places players must not sweep them across the pitch.
export const continuous = (a, b) => a.phase === b.phase && a.period === b.period && b.t > a.t;

export function createTimeline({ delay = DELAY, window = WINDOW, slew = SLEW, snap = SNAP, keep = KEEP } = {}) {
  let snapshots = []; // oldest first; the first is at or before the render time
  let events = [];
  let arrivals = []; // [page time, page time − server time], over the last `window`
  let offset = null; // the page-minus-server clock offset the render time is drawn on
  let lastNow = null;
  let time = -Infinity; // the render time, on the server's clock

  function reset() {
    snapshots = [];
    events = [];
    arrivals = [];
    offset = lastNow = null;
    time = -Infinity;
  }

  // The least-delayed arrival is the truest offset: lateness only ever adds to it.
  function target() {
    let best = Infinity;
    for (const [, value] of arrivals) best = Math.min(best, value);
    return best;
  }

  return {
    reset,
    get time() { return time; },
    get size() { return snapshots.length; },

    push(snapshot, now) {
      const newest = snapshots.at(-1);
      if (newest && snapshot.t < newest.t) reset(); // the clock went back: a new stream
      else if (newest && snapshot.t === newest.t) snapshots.pop();
      snapshots.push(snapshot);
      while (snapshots.length > 2 && snapshot.t - snapshots[1].t > keep) snapshots.shift();
      arrivals.push([now, now - snapshot.t]);
      while (arrivals.length > 1 && arrivals[0][0] < now - window) arrivals.shift();
    },

    pushEvent(event, now) {
      events.push(event);
      if (events.length > MOST_EVENTS) events.shift();
    },

    // The two snapshots around the render time at page time `now`, and how far between
    // them it is, or null before the first snapshot. Holds a snapshot rather than blend
    // across a restart, and holds the newest when none has come after it.
    sample(now) {
      if (!snapshots.length) return null;
      const wanted = target();
      if (offset === null || Math.abs(wanted - offset) > snap) offset = wanted;
      else {
        const most = slew * Math.max(0, now - lastNow);
        offset += Math.max(-most, Math.min(most, wanted - offset));
      }
      lastNow = now;
      const newest = snapshots.at(-1);
      // Never ahead of the data, and never backwards: a dry buffer pauses play, then the
      // offset slews back so it catches up without a jump.
      time = Math.max(time, Math.min(now - offset - delay, newest.t));
      offset = Math.max(offset, now - delay - time);
      let i = 0;
      while (i + 1 < snapshots.length && snapshots[i + 1].t <= time) i++;
      if (i) snapshots = snapshots.slice(i);
      const [before, after] = snapshots;
      if (!after || time < before.t || !continuous(before, after)) {
        return { before, after: before, alpha: 1, time, latest: newest };
      }
      return { before, after, alpha: (time - before.t) / (after.t - before.t), time, latest: newest };
    },

    // The events the render time has reached, in order, each marked late if it is
    // already well behind what is drawn (after a stall), so only bookkeeping should see it.
    release() {
      const due = [];
      while (events.length && !(events[0].t > time)) {
        const event = events.shift();
        due.push({ event, late: time - event.t > LATE });
      }
      return due;
    },
  };
}
