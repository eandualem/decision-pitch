"""Observed football statistics for the managers, without opponent internals."""

from collections import Counter

from decision_pitch import pitch
from decision_pitch.physics import STEP


class Performance:
    def __init__(self, match):
        self.match = match
        self.players = {pid: Counter() for pid in match.everyone}
        self.territory = [Counter(), Counter()]

    def observe(self, events):
        m = self.match
        if m.phase == "play" and m.owner is not None:
            p = m.player(m.owner)
            self.players[p.id]["possession"] += STEP
            x = m.ball.x * m.attack(p.team)
            third = "defensive" if x < -pitch.LENGTH / 6 else "attacking" if x > pitch.LENGTH / 6 else "middle"
            self.territory[p.team][third] += STEP
        # A tackle/catch followed by a kick in one step remains two contacts here,
        # even though the renderer only shows the kick. Copy totals, without recounting.
        for pid, contacts in m.contacts.items():
            counts = self.players[pid]
            counts["touches"] = sum(contacts.values())
            counts["kicks"] = contacts["kick"] + contacts["throw"]
            counts["tackles"] = contacts["tackle"] + contacts["poke"]
            counts["saves/catches"] = contacts["save"] + contacts["catch"]
        for event in events:
            pid = event.get("player")
            if pid in self.players:
                if event["kind"] == "foul":
                    self.players[pid]["fouls"] += 1

    @staticmethod
    def describe(counts):
        return (f"{counts['possession']:.1f}s possession, " +
                ", ".join(f"{counts[key]} {key}" for key in ("touches", "kicks", "tackles", "saves/catches", "fouls")))

    def team(self, team):
        counts = Counter()
        for pid, stats in self.players.items():
            if self.match.player(pid).team == team:
                counts.update(stats)
        zones = self.territory[team]
        return (self.describe(counts) + f"; {self.match.score[team]} goals; possession seconds by third: " +
                ", ".join(f"{key} {zones[key]:.1f}" for key in ("defensive", "middle", "attacking")))
