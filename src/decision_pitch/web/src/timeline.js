// Plays the match a short, fixed delay behind the newest snapshot, so snapshots that
// arrive unevenly are still drawn evenly. Times are seconds: `now` on the page's clock,
// `t` on the server's match clock. No three.js here, so it can be tested on its own.
// Sampling and releasing reuse their results: nothing is allocated per frame.

const DELAY = 0.1; // s behind the newest snapshot: about three snapshots of slack
const WINDOW = 0.5; // s of arrivals the clock offset is judged over
const HISTORY = 3; // s of arrivals kept to tell whether the server keeps real time
const SLEW = 0.08; // s per s the render clock may run fast or slow to correct the offset
const SNAP = 0.25; // s off beyond which the render clock jumps instead (start, stall)
const KEEP = 4; // s of snapshots kept: a hidden page's backlog is dropped beyond it
const LATE = 1; // s behind the render time after which a released event is stale
const MOST_EVENTS = 1000;
const MOST_ARRIVALS = 512;

// Two snapshots may be blended within one period, going forward, across a restart too, so
// play does not hitch as it stops. A restart puts players right by inches; a player or
// ball it places far off is drawn there at once (players.js), never swept across the pitch.
export const continuous = (a, b) => a.period === b.period && b.t > a.t;

export function createTimeline({ delay = DELAY, window = WINDOW, slew = SLEW, snap = SNAP, keep = KEEP } = {}) {
  let snapshots = []; // oldest first; the first is at or before the render time
  let events = [];
  // Arrivals, oldest first in a ring: page time, and page time − server time.
  const arrivedAt = new Float64Array(MOST_ARRIVALS);
  const arrivedOffset = new Float64Array(MOST_ARRIVALS);
  let first = 0;
  let count = 0;
  let offset = null; // the page-minus-server clock offset the render time is drawn on
  let lastNow = null;
  let time = -Infinity; // the render time, on the server's clock
  const frame = { before: null, after: null, alpha: 1, time: 0, latest: null };
  const due = [];

  function dropOldest() {
    first = (first + 1) % MOST_ARRIVALS;
    count--;
  }

  function reset() {
    snapshots = [];
    events = [];
    first = count = 0;
    offset = lastNow = null;
    time = -Infinity;
  }

  // How much later than its own time each snapshot arrives, per second, when the server
  // runs slower than real time: the rise of the least-delayed arrivals, oldest to newest.
  function drift(now) {
    if (!count || now - arrivedAt[first] < 2 * window) return 0;
    let oldest = Infinity;
    let oldestAt = 0;
    let newest = Infinity;
    let newestAt = 0;
    for (let i = 0; i < count; i++) {
      const k = (first + i) % MOST_ARRIVALS;
      if (arrivedAt[k] <= arrivedAt[first] + window && arrivedOffset[k] < oldest) {
        oldest = arrivedOffset[k];
        oldestAt = arrivedAt[k];
      }
      if (arrivedAt[k] >= now - window && arrivedOffset[k] < newest) {
        newest = arrivedOffset[k];
        newestAt = arrivedAt[k];
      }
    }
    return newestAt > oldestAt ? Math.min(0.5, Math.max(0, (newest - oldest) / (newestAt - oldestAt))) : 0;
  }

  // The least-delayed recent arrival is the truest offset, since lateness only ever adds
  // to it; each is carried forward by the server's drift to now.
  function target(now, rate) {
    let best = Infinity;
    for (let i = 0; i < count; i++) {
      const k = (first + i) % MOST_ARRIVALS;
      if (arrivedAt[k] >= now - window) best = Math.min(best, arrivedOffset[k] + rate * (now - arrivedAt[k]));
    }
    return best === Infinity ? offset : best;
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
      if (count === MOST_ARRIVALS) dropOldest();
      const k = (first + count++) % MOST_ARRIVALS;
      arrivedAt[k] = now;
      arrivedOffset[k] = now - snapshot.t;
      while (count > 1 && arrivedAt[first] < now - HISTORY) dropOldest();
    },

    pushEvent(event, now) {
      events.push(event);
      if (events.length > MOST_EVENTS) events.shift();
    },

    // The two snapshots around the render time at page time `now`, and how far between
    // them it is, or null before the first snapshot. Holds a snapshot rather than blend
    // into the next period, and holds the newest when none has come after it. The result
    // is reused by the next call.
    sample(now) {
      if (!snapshots.length) return null;
      const rate = drift(now);
      const wanted = target(now, rate);
      if (offset === null || Math.abs(wanted - offset) > snap) offset = wanted;
      else {
        const dt = Math.max(0, now - lastNow);
        offset += rate * dt; // a server slower than real time is drawn as slowly
        offset += Math.max(-slew * dt, Math.min(slew * dt, wanted - offset));
      }
      lastNow = now;
      const newest = snapshots.at(-1);
      // Never ahead of the data, and never backwards: a dry buffer pauses play, then the
      // offset slews back so it catches up without a jump.
      time = Math.max(time, Math.min(now - offset - delay, newest.t));
      offset = Math.max(offset, now - delay - time);
      while (snapshots.length > 1 && snapshots[1].t <= time) snapshots.shift();
      const before = snapshots[0];
      const after = snapshots[1];
      const blend = after && time >= before.t && continuous(before, after);
      frame.before = before;
      frame.after = blend ? after : before;
      frame.alpha = blend ? (time - before.t) / (after.t - before.t) : 1;
      frame.time = time;
      frame.latest = newest;
      return frame;
    },

    // The events the render time has reached, in order. The list is reused by the next call.
    release() {
      due.length = 0;
      while (events.length && !(events[0].t > time)) due.push(events.shift());
      return due;
    },

    // Whether a released event is already well behind what is drawn (after a stall), so
    // only bookkeeping should see it.
    late(event) {
      return time - event.t > LATE;
    },
  };
}
