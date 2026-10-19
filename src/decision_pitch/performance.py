"""Observed football statistics for the managers, without opponent internals."""

from collections import Counter

from decision_pitch import pitch
from decision_pitch.physics import STEP


class Performance:
    def __init__(self, match):
        self.match = match
        self.players = {pid: Counter() for pid in match.everyone}
        self.territory = [Counter(), Counter()]
        self.last_touch = -1.0

    def observe(self, events):
        m = self.match
        if m.phase == "play" and m.owner is not None:
            p = m.player(m.owner)
            self.players[p.id]["possession"] += STEP
            x = m.ball.x * m.attack(p.team)
            third = "defensive" if x < -pitch.LENGTH / 6 else "attacking" if x > pitch.LENGTH / 6 else "middle"
            self.territory[p.team][third] += STEP
        # Staff observes every physics step; the engine retains touches for rendering.
        fresh = [touch for touch in m.touches if touch["t"] > self.last_touch]
        for touch in fresh:
            counts = self.players[touch["player"]]
            counts["touches"] += 1
            kind = touch["kind"]
            if kind in ("kick", "throw"):
                counts["kicks"] += 1
            elif kind in ("tackle", "poke"):
                counts["tackles"] += 1
            elif kind in ("save", "catch"):
                counts["saves"] += 1
        if fresh:
            self.last_touch = max(t["t"] for t in fresh)
        for event in events:
            pid = event.get("player")
            if pid in self.players:
                if event["kind"] == "goal" and m.player(pid).team == event["team"]:
                    self.players[pid]["goals"] += 1
                elif event["kind"] == "foul":
                    self.players[pid]["fouls"] += 1

    @staticmethod
    def describe(counts):
        return (f"{counts['possession']:.1f}s possession, " +
                ", ".join(f"{counts[key]} {key}" for key in ("touches", "kicks", "tackles", "saves", "goals", "fouls")))

    def team(self, team):
        counts = Counter()
        for pid, stats in self.players.items():
            if self.match.player(pid).team == team:
                counts.update(stats)
        zones = self.territory[team]
        return (self.describe(counts) + "; possession seconds by third: " +
                ", ".join(f"{key} {zones[key]:.1f}" for key in ("defensive", "middle", "attacking")))
