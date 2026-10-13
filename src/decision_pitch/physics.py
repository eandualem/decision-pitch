"""Ball and player physics, advanced one fixed step at a time.

Players move in two dimensions as discs; the ball moves in three, rolls, flies,
bounces and hits the goal frame."""

from __future__ import annotations

import math
from dataclasses import dataclass

from decision_pitch import pitch

STEP = 1 / 60  # seconds per physics step
GRAVITY = 9.81

BALL_RADIUS = 0.11
DRAG = 0.013  # quadratic air drag per metre: ½ρ·Cd·A / m for a size-5 ball
ROLLING = 1.2  # m/s², how fast grass slows a rolling ball
BOUNCE = 0.55  # share of its vertical speed a ball keeps bouncing off grass
GRIP = 0.85  # share of its horizontal speed it keeps on each bounce
SETTLE = 1.0  # m/s: a ball landing slower than this stops bouncing and rolls
FRAME_BOUNCE = 0.6  # share of its speed into a post or crossbar it keeps
MAX_TRAVEL = 0.08  # m a ball may move in one substep: under half the ball-to-frame reach

PLAYER_RADIUS = 0.4
TOP_SPEED = 7.5  # m/s
ACCELERATION = 4.0  # m/s²
TURN_RATE = 9.0  # rad/s standing still; a running player turns more slowly


@dataclass
class Ball:
    x: float = 0.0
    y: float = 0.0
    z: float = BALL_RADIUS
    vx: float = 0.0
    vy: float = 0.0
    vz: float = 0.0

    def place(self, x: float, y: float) -> None:
        self.x, self.y, self.z = x, y, BALL_RADIUS
        self.vx = self.vy = self.vz = 0.0


@dataclass
class Player:
    id: int
    team: int
    number: int
    name: str
    position: str  # GK, DF, MF or FW
    home: tuple[float, float]  # formation spot, for a team attacking towards +x
    x: float = 0.0
    y: float = 0.0
    vx: float = 0.0
    vy: float = 0.0
    heading: float = 0.0

    @property
    def speed(self) -> float:
        return math.hypot(self.vx, self.vy)


def _frame() -> list[tuple[tuple[float, float, float], tuple[float, float, float]]]:
    """Both goals' posts and crossbars, as segments between centre lines."""
    y = pitch.GOAL_WIDTH / 2 + pitch.POST_RADIUS
    z = pitch.GOAL_HEIGHT + pitch.POST_RADIUS
    segments = []
    for x in (-pitch.HALF_LENGTH, pitch.HALF_LENGTH):
        segments += [((x, -y, 0.0), (x, -y, z)), ((x, y, 0.0), (x, y, z)), ((x, -y, z), (x, y, z))]
    return segments


FRAME = _frame()


def step_ball(ball: Ball, dt: float = STEP) -> None:
    # A fast ball moves in short substeps, so it cannot pass through a post or the bar.
    speed = math.sqrt(ball.vx**2 + ball.vy**2 + ball.vz**2)
    substeps = max(1, math.ceil(speed * dt / MAX_TRAVEL))
    for _ in range(substeps):
        _step_ball(ball, dt / substeps)


def _step_ball(ball: Ball, dt: float) -> None:
    rolling = ball.z <= BALL_RADIUS and ball.vz == 0
    if rolling:
        h = math.hypot(ball.vx, ball.vy)
        if h > 0:
            keep = max(0.0, h - (ROLLING + DRAG * h * h) * dt) / h
            ball.vx *= keep
            ball.vy *= keep
    else:
        ball.vz -= GRAVITY * dt
        k = DRAG * math.sqrt(ball.vx**2 + ball.vy**2 + ball.vz**2) * dt
        ball.vx -= k * ball.vx
        ball.vy -= k * ball.vy
        ball.vz -= k * ball.vz
    ball.x += ball.vx * dt
    ball.y += ball.vy * dt
    ball.z += ball.vz * dt
    if ball.z < BALL_RADIUS:
        ball.z = BALL_RADIUS
        if ball.vz < -SETTLE:
            ball.vz *= -BOUNCE
            ball.vx *= GRIP
            ball.vy *= GRIP
        else:
            ball.vz = 0.0
    for a, b in FRAME:
        _hit_segment(ball, a, b)


def carry(ball: Ball, x: float, y: float) -> None:
    """Move a ball a player is carrying to (x, y) on the ground, in short substeps that
    stop at the goal frame, so a ball cannot be carried through a post."""
    ball.z, ball.vz = BALL_RADIUS, 0.0
    dx, dy = x - ball.x, y - ball.y
    substeps = max(1, math.ceil(math.hypot(dx, dy) / MAX_TRAVEL))
    for _ in range(substeps):
        ball.x += dx / substeps
        ball.y += dy / substeps
        if any([_hit_segment(ball, a, b) for a, b in FRAME]):
            return


def _hit_segment(ball: Ball, a: tuple[float, float, float], b: tuple[float, float, float]) -> bool:
    ab = [b[i] - a[i] for i in range(3)]
    c = (ball.x, ball.y, ball.z)
    t = sum((c[i] - a[i]) * ab[i] for i in range(3)) / sum(v * v for v in ab)
    t = min(1.0, max(0.0, t))
    d = [c[i] - (a[i] + t * ab[i]) for i in range(3)]
    dist = math.sqrt(sum(v * v for v in d))
    reach = BALL_RADIUS + pitch.POST_RADIUS
    if dist >= reach or dist == 0:
        return False
    n = [v / dist for v in d]
    ball.x, ball.y, ball.z = (c[i] + n[i] * (reach - dist) for i in range(3))
    vn = ball.vx * n[0] + ball.vy * n[1] + ball.vz * n[2]
    if vn < 0:
        ball.vx -= (1 + FRAME_BOUNCE) * vn * n[0]
        ball.vy -= (1 + FRAME_BOUNCE) * vn * n[1]
        ball.vz -= (1 + FRAME_BOUNCE) * vn * n[2]
    return True


def step_player(player: Player, tx: float, ty: float, speed: float, dt: float = STEP) -> None:
    """Run towards (tx, ty) at up to `speed`, slowing to arrive, turning at a limited
    rate and accelerating at a limited rate. A speed of 0 stops the player."""
    dx, dy = tx - player.x, ty - player.y
    dist = math.hypot(dx, dy)
    want = 0.0
    if speed > 0 and dist > 0.05:
        want = min(speed, TOP_SPEED, math.sqrt(2 * ACCELERATION * dist))
        turn = (math.atan2(dy, dx) - player.heading + math.pi) % (2 * math.pi) - math.pi
        most = TURN_RATE / (1 + player.speed / 3) * dt
        player.heading = (player.heading + max(-most, min(most, turn)) + math.pi) % (2 * math.pi) - math.pi
        want *= max(0.0, math.cos(turn))  # slow down to turn
    ax = want * math.cos(player.heading) - player.vx
    ay = want * math.sin(player.heading) - player.vy
    change = math.hypot(ax, ay)
    if change > ACCELERATION * dt:
        ax, ay = ax / change * ACCELERATION * dt, ay / change * ACCELERATION * dt
    player.vx += ax
    player.vy += ay
    player.x += player.vx * dt
    player.y += player.vy * dt


def separate(players: list[Player]) -> None:
    """Push overlapping players apart and stop them running into each other."""
    for i, p in enumerate(players):
        for q in players[i + 1 :]:
            dx, dy = q.x - p.x, q.y - p.y
            dist = math.hypot(dx, dy)
            if dist >= 2 * PLAYER_RADIUS:
                continue
            nx, ny = (dx / dist, dy / dist) if dist > 0 else (1.0, 0.0)
            push = (2 * PLAYER_RADIUS - dist) / 2
            p.x -= nx * push
            p.y -= ny * push
            q.x += nx * push
            q.y += ny * push
            closing = (q.vx - p.vx) * nx + (q.vy - p.vy) * ny
            if closing < 0:
                p.vx += closing / 2 * nx
                p.vy += closing / 2 * ny
                q.vx -= closing / 2 * nx
                q.vy -= closing / 2 * ny
