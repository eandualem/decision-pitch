"""Fresh off-pitch measurements, kept separate from actual football performance."""

import asyncio
import math
import statistics
import time
from collections import Counter, deque

from decision_pitch.players import OneAtATime, question_for


def timing(times):
    if not times:
        return "latency unmeasured"
    ordered = sorted(times)
    return (f"median {statistics.median(ordered):.3f}s, "
            f"p95 {ordered[max(0, math.ceil(len(ordered) * .95) - 1)]:.3f}s "
            f"({len(ordered)} recent successful samples)")


class Samples:
    def __init__(self):
        self.results = {}

    async def measure(self, match, squad, team, options):
        """One request per candidate per consultation, never applied to the match."""
        while match.paused:
            await asyncio.sleep(.1)
        if match.phase == "full_time":
            return
        # Each candidate sees the same player at the same point in time. Prefer an
        # outfield player; selection conveys no assumption about the model's skill.
        player = next(p for p in match.players if p.team == team and p.position != "GK")
        seat = squad.seats.get(player.id)
        questions = {name: question_for(match, player, model,
                                       seat.action if seat else "hold",
                                       seat.answer if seat else None,
                                       seat.instruction if seat else None, squad.defending[team],
                                       {pid: s.action for pid, s in squad.seats.items()})
                     for name, model in options.items() if model is not None}

        async def ask(name, model):
            while match.paused:
                await asyncio.sleep(.1)
            if match.phase == "full_time":
                return
            async def timed(candidate):
                start = time.perf_counter()
                async with asyncio.timeout(6):
                    answer = await candidate.decide(questions[name])
                if answer.move not in questions[name].options:
                    raise ValueError("invalid probe answer")
                return time.perf_counter() - start

            try:
                if isinstance(model, OneAtATime):
                    async with model.ready(match):
                        if match.phase == "full_time":
                            return
                        elapsed = await timed(model.model)
                else:
                    elapsed = await timed(model)
            except Exception:
                elapsed = None
            result = self.results.setdefault(name, {"times": deque(maxlen=20), "ok": 0, "failed": 0})
            result["failed" if elapsed is None else "ok"] += 1
            if elapsed is not None:
                result["times"].append(elapsed)
            result["at"] = match.t

        await asyncio.gather(*(ask(name, model) for name, model in options.items() if model is not None))

    def describe(self, name, now):
        result = self.results.get(name)
        if result is None:
            return "off-pitch probe: not sampled"
        return (f"off-pitch probe: {result['ok']} valid, {result['failed']} failed; "
                f"{timing(result['times'])}; latest {max(0, now - result['at']):.1f}s ago; "
                "not applied, football quality unmeasured")


def model_performance(staff, team, name):
    """Own-team evidence only, including players that have left the pitch."""
    model = staff.options[team][name]
    seats = [(pid, seat) for pid, seat in staff.squad.seats.items()
             if staff.match.player(pid).team == team and seat.model is model]
    if not seats:
        return "match: not yet fielded; football quality unmeasured"
    counts, late = Counter(), Counter()
    times = []
    for pid, seat in seats:
        counts.update(staff.performance.players[pid])
        late.update(seat.late)
        times.extend(seat.times)
    active = sum(staff.match.player(pid) in staff.match.players for pid, _ in seats)
    positions = Counter(staff.match.player(pid).position for pid, _ in seats)
    return (f"match: {active} currently on pitch, {len(seats)} players observed, roles {dict(positions)}; "
            f"{sum(s.answers for _, s in seats)} answers, {sum(s.failures for _, s in seats)} failures; "
            f"{timing(times)}; {late['no ball']} ball actions returned after possession was lost, "
            f"{late['already played']} already-played answers; {staff.performance.describe(counts)}")
