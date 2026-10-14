"""The figure's animation clips, made procedurally on the skeleton from rig.py.

Every clip is built the same way: a function of time returns a pose as a set of
readable channels (where the pelvis is, how the spine bends, where each foot is
on the ground and how it rolls, how each arm swings, where the head looks), and
a small solver turns that pose into bone rotations with two-bone inverse
kinematics for the legs (and, where a hand must reach a point, the arms). The
pose is sampled and keyed on every frame at 30 frames per second, so feet that
are planted stay exactly planted.

Conventions (Blender coordinates, metres, degrees):

- The figure faces -Y with its left at +X; "ahead" is -Y.
- `root` never moves. The engine moves the player; a clip only moves the body
  around the root, so a dive goes horizontal over the root rather than metres
  away from it.
- Locomotion loops are one full cycle, in place. The left foot plants at t = 0
  and the right foot at half the cycle. A planted foot slides opposite to the
  direction of travel at exactly the clip's `speed`, so the page plays a loop
  at ground speed / speed and the feet stay planted on the grass.
- Kicks are right-footed and meet the ball 0.6 m ahead of the root, where the
  engine carries it.
- `_L` clips go towards the figure's own left.

Angle channels, all relative to the rest pose: `flex` bends forwards, `side`
bends towards the figure's left, `twist` and `yaw` turn towards the figure's
left. For a foot, `pitch` raises the toes (negative lifts the heel); for an arm,
`flex` swings it forwards, `abd` raises it out to the side, `twist` turns it
inwards (the elbow out, the forearm across the body) and `elbow` bends it.

`build_clips(armature)` creates one Action per clip, each in its own NLA track
so the glTF exporter's ACTIONS mode writes it as one animation with the clip's
name, and returns the clip metadata that build.py writes to figure.json.
"""

import math

import bpy
from mathutils import Matrix, Quaternion, Vector

FPS = 30

X = Vector((1.0, 0.0, 0.0))
Y = Vector((0.0, 1.0, 0.0))
Z = Vector((0.0, 0.0, 1.0))
AHEAD = Vector((0.0, -1.0, 0.0))

HEEL_BACK = 0.03  # the heel's contact point, behind the ankle, on the sole
TOE_BEND_MAX = 50.0  # degrees the toes bend at the ball before the foot pivots on the tip

# --------------------------------------------------------------------------
# Rotation helpers


def rot(axis, degrees):
    return Quaternion(Vector(axis).normalized(), math.radians(degrees))


def euler(flex=0.0, side=0.0, twist=0.0):
    """Twist about Z, then flex about X, then side bend about Y (rest axes)."""
    return rot(Z, twist) @ rot(X, flex) @ rot(Y, side)


def frame(x_hint, y_axis):
    """An orthonormal basis with Y exactly along `y_axis` and X near `x_hint`."""
    y = y_axis.normalized()
    x = (x_hint - y * x_hint.dot(y)).normalized()
    z = x.cross(y)
    return Matrix((x, y, z)).transposed()


def lerp(a, b, w):
    return a + (b - a) * w


def smoothstep(x):
    x = min(1.0, max(0.0, x))
    return x * x * (3.0 - 2.0 * x)


# --------------------------------------------------------------------------
# Curves: monotone cubic interpolation through keys, so motion eases into and
# out of every held or extreme value without overshooting it.


class Curve:
    def __init__(self, keys, period=None):
        self.keys = sorted(keys)
        self.period = period
        if period is not None:
            # Wrap one key either side so the slopes at the seam are smooth.
            first, last = self.keys[0], self.keys[-1]
            self.keys = [(last[0] - period, last[1])] + self.keys + [(first[0] + period, first[1])]
        self.slopes = self._slopes()

    def _slopes(self):
        k = self.keys
        n = len(k)
        if n == 1:
            return [0.0]
        d = [(k[i + 1][1] - k[i][1]) / (k[i + 1][0] - k[i][0]) for i in range(n - 1)]
        m = [0.0] * n
        for i in range(1, n - 1):
            if d[i - 1] * d[i] <= 0.0:
                m[i] = 0.0
            else:
                h0 = k[i][0] - k[i - 1][0]
                h1 = k[i + 1][0] - k[i][0]
                w0, w1 = 2 * h1 + h0, h1 + 2 * h0
                m[i] = (w0 + w1) / (w0 / d[i - 1] + w1 / d[i])
        if self.period is None:
            m[0] = 0.0
            m[-1] = 0.0
        return m

    def __call__(self, t):
        k = self.keys
        if self.period is not None:
            t = (t - k[1][0]) % self.period + k[1][0]
        if t <= k[0][0]:
            return k[0][1]
        if t >= k[-1][0]:
            return k[-1][1]
        lo, hi = 0, len(k) - 1
        while hi - lo > 1:
            mid = (lo + hi) // 2
            if k[mid][0] <= t:
                lo = mid
            else:
                hi = mid
        t0, v0 = k[lo]
        t1, v1 = k[hi]
        h = t1 - t0
        s = (t - t0) / h
        s2, s3 = s * s, s * s * s
        return (
            (2 * s3 - 3 * s2 + 1) * v0
            + (s3 - 2 * s2 + s) * h * self.slopes[lo]
            + (-2 * s3 + 3 * s2) * v1
            + (s3 - s2) * h * self.slopes[hi]
        )


def hermite(p0, v0, p1, v1, s, h):
    """Cubic Hermite between (p0, v0) and (p1, v1) over a span of h seconds."""
    s2, s3 = s * s, s * s * s
    return (
        p0 * (2 * s3 - 3 * s2 + 1)
        + v0 * (h * (s3 - 2 * s2 + s))
        + p1 * (-2 * s3 + 3 * s2)
        + v1 * (h * (s3 - s2))
    )


class Path:
    """A smooth path through points in time with given end velocities."""

    def __init__(self, points, v_start, v_end):
        self.points = points  # [(t, Vector)]
        n = len(points)
        self.vel = [None] * n
        self.vel[0] = v_start
        self.vel[-1] = v_end
        for i in range(1, n - 1):
            (ta, pa), (tb, pb) = points[i - 1], points[i + 1]
            self.vel[i] = (pb - pa) / (tb - ta)

    def __call__(self, t):
        pts = self.points
        if t <= pts[0][0]:
            return pts[0][1].copy()
        for i in range(len(pts) - 1):
            t0, p0 = pts[i]
            t1, p1 = pts[i + 1]
            if t <= t1:
                h = t1 - t0
                return hermite(p0, self.vel[i], p1, self.vel[i + 1], (t - t0) / h, h)
        return pts[-1][1].copy()


# --------------------------------------------------------------------------
# The pose: a flat dict of channels. Missing channels take these defaults,
# which are a relaxed upright stand.

SIDES = ("L", "R")

NEUTRAL = {
    # Pelvis offset from its rest position (m) and its rotation (deg).
    "hx": 0.0, "hy": 0.0, "hz": -0.015,
    "hyaw": 0.0, "hpitch": 0.0, "hroll": 0.0,
    "sflex": 0.0, "sside": 0.0, "stwist": 0.0,
    "cflex": 0.0, "cside": 0.0, "ctwist": 0.0,
    # Where the head looks, relative to the root (deg); `look_body` follows the chest instead.
    "look_yaw": 0.0, "look_down": 4.0, "look_tilt": 0.0, "look_body": 0.0,
}
for _s in SIDES:
    _sign = 1.0 if _s == "L" else -1.0
    NEUTRAL.update({
        # Foot: ground reference point under the ankle (root space, m) and rotation.
        f"f{_s}x": 0.10 * _sign, f"f{_s}y": 0.0, f"f{_s}z": 0.0,
        f"f{_s}yaw": 6.0 * _sign, f"f{_s}pitch": 0.0, f"f{_s}roll": 0.0,
        f"f{_s}toe": 0.0, f"f{_s}flat": 1.0,
        # 1 moves the foot with the pelvis (airborne), 0 keeps it in root space.
        f"f{_s}space": 0.0,
        f"k{_s}out": 6.0,  # knee points this far outwards
        # Arm, relative to hanging straight down at the side, palm in.
        f"a{_s}elev": 0.0, f"a{_s}prot": 0.0,
        f"a{_s}flex": 0.0, f"a{_s}abd": 8.0, f"a{_s}twist": 0.0,
        f"a{_s}elbow": 12.0, f"a{_s}pron": 0.0, f"a{_s}wrist": 0.0,
        # Hand reach: weight, wrist target (root space) and elbow direction.
        f"a{_s}ik": 0.0, f"a{_s}ix": 0.0, f"a{_s}iy": 0.0, f"a{_s}iz": 0.0,
        f"a{_s}pole": 0.0,
    })


# --------------------------------------------------------------------------
# The solver: pose channels -> world rotation of every bone -> pose-bone values.


class Skeleton:
    def __init__(self, armature):
        bones = armature.data.bones
        self.names = []
        pending = [b for b in bones if b.parent is None]
        while pending:
            b = pending.pop(0)
            self.names.append(b.name)
            pending.extend(b.children)
        self.parent = {b.name: b.parent.name if b.parent else None for b in bones}
        self.head = {b.name: b.head_local.copy() for b in bones}
        self.tail = {b.name: b.tail_local.copy() for b in bones}
        self.rest = {b.name: b.matrix_local.to_quaternion() for b in bones}
        self.len = {b.name: b.length for b in bones}
        self.pelvis = self.head["hips"].copy()


class Solved:
    """A solved pose: world rotations, pelvis translation and joint positions."""

    def __init__(self, sk):
        self.sk = sk
        self.world = {}
        self.offset = Vector()
        self.pos = {}

    def fk(self):
        sk = self.sk
        for name in sk.names:
            parent = sk.parent[name]
            if parent is None:
                self.pos[name] = sk.head[name].copy()
            elif name == "hips":
                self.pos[name] = sk.head[name] + self.offset
            else:
                self.pos[name] = self.pos[parent] + self.world[parent] @ (sk.head[name] - sk.head[parent])
        return self

    def point(self, bone, rest_point):
        """Where a point fixed to `bone` (given at rest) is in this pose."""
        return self.pos[bone] + self.world[bone] @ (Vector(rest_point) - self.sk.head[bone])

    def basis(self):
        """Pose-bone rotation (and the hips' location) for every bone."""
        sk = self.sk
        out = {}
        for name in sk.names:
            parent = sk.parent[name]
            w_parent = self.world[parent] if parent else Quaternion()
            local = w_parent.inverted() @ self.world[name]
            r = sk.rest[name]
            out[name] = (r.inverted() @ local @ r).normalized()
        loc = sk.rest["hips"].inverted() @ self.offset
        return out, loc


class Solver:
    def __init__(self, armature):
        self.sk = Skeleton(armature)
        sk = self.sk
        self.leg = {}
        self.arm = {}
        for s in SIDES:
            ankle = sk.head[f"foot_{s}"]
            self.leg[s] = {
                "thigh": sk.len[f"thigh_{s}"],
                "shin": sk.len[f"shin_{s}"],
                "ref": Vector((ankle.x, ankle.y, 0.0)),
                "heel": Vector((ankle.x, ankle.y + HEEL_BACK, 0.0)),
                "ball": Vector((sk.head[f"toe_{s}"].x, sk.head[f"toe_{s}"].y, 0.0)),
                "ball_joint": sk.head[f"toe_{s}"].copy(),
                "tip": Vector((sk.tail[f"toe_{s}"].x, sk.tail[f"toe_{s}"].y, 0.0)),
                "ankle": ankle.copy(),
            }
            self.arm[s] = {
                "upper": sk.len[f"upper_arm_{s}"],
                "fore": sk.len[f"forearm_{s}"],
            }

    # -- feet ---------------------------------------------------------------

    def foot(self, s, p):
        """Ankle position and world rotations of foot and toe, in root space.

        The foot's reference point (under the ankle, on the sole) is placed at
        (fx, fy, fz) and the foot is turned by `yaw`. A positive pitch raises
        the toes about the heel; a negative pitch lifts the heel about the ball
        with the toes flat, then about the tip of the toes once they are bent
        as far as they go.
        """
        leg = self.leg[s]
        F = Vector((p[f"f{s}x"], p[f"f{s}y"], p[f"f{s}z"]))
        qyaw = rot(Z, p[f"f{s}yaw"])
        lat = qyaw @ X

        def ground(point):
            return qyaw @ (point - leg["ref"]) + F

        ankle = ground(leg["ankle"])
        pitch = p[f"f{s}pitch"]
        if pitch >= 0.0:
            q = rot(lat, -pitch)
            pivot = ground(leg["heel"])
            ankle = pivot + q @ (ankle - pivot)
            q_foot = q @ qyaw
            q_toe_flat = q_foot
        else:
            lift = -pitch
            first = min(lift, TOE_BEND_MAX)
            q1 = rot(lat, first)
            ball = ground(leg["ball_joint"])  # the toes stay flat, so the joint stays put
            ankle = ball + q1 @ (ankle - ball)
            q_foot = q1 @ qyaw
            q_toe_flat = qyaw
            if lift > TOE_BEND_MAX:
                q2 = rot(lat, lift - TOE_BEND_MAX)
                tip = ground(leg["tip"])
                ankle = tip + q2 @ (ankle - tip)
                q_foot = q2 @ q_foot
                q_toe_flat = q2 @ q_toe_flat
        roll = p[f"f{s}roll"]
        if roll:
            q_foot = rot(q_foot @ Y, roll if s == "L" else -roll) @ q_foot
        foot_lat = q_foot @ X
        q_toe_bent = rot(foot_lat, -p[f"f{s}toe"]) @ q_foot
        q_toe = q_toe_bent.slerp(q_toe_flat, p[f"f{s}flat"]) if pitch < 0.0 else q_toe_bent
        return ankle, q_foot, q_toe

    # -- limbs --------------------------------------------------------------

    @staticmethod
    def two_bone(root, target, l1, l2, pole, hinge_hint=None):
        """Directions of the two bones of a limb reaching from root to target.

        The middle joint bends towards `pole`. Returns (hinge axis, first bone
        direction, second bone direction, reach ratio)."""
        v = target - root
        d = v.length
        reach = d / (l1 + l2)
        d = min(max(d, abs(l1 - l2) + 1e-4), (l1 + l2) * 0.99995)
        dirv = v.normalized()
        pole_perp = pole - dirv * pole.dot(dirv)
        if pole_perp.length < 1e-6:
            pole_perp = hinge_hint.cross(dirv) if hinge_hint is not None else Vector((0, -1, 0))
        hinge = pole_perp.normalized().cross(dirv).normalized()
        a1 = math.acos(max(-1.0, min(1.0, (l1 * l1 + d * d - l2 * l2) / (2 * l1 * d))))
        first = Quaternion(hinge, -a1) @ dirv
        joint = root + first * l1
        second = (root + dirv * d - joint).normalized()
        return hinge, first, second, reach

    def solve(self, p):
        sk = self.sk
        out = Solved(sk)
        w = out.world
        w["root"] = Quaternion()
        out.offset = Vector((p["hx"], p["hy"], p["hz"]))
        q_hips = rot(Z, p["hyaw"]) @ rot(X, p["hpitch"]) @ rot(Y, p["hroll"])
        w["hips"] = q_hips
        w["spine"] = q_hips @ euler(p["sflex"], p["sside"], p["stwist"])
        w["chest"] = w["spine"] @ euler(p["cflex"], p["cside"], p["ctwist"])

        # Head: looks where the channels say, the neck sharing the turn.
        look = rot(Z, p["look_yaw"]) @ rot(X, p["look_down"]) @ rot(Y, p["look_tilt"])
        if p["look_body"] > 0.0:
            look = look.slerp(w["chest"] @ rot(X, p["look_down"]), p["look_body"])
        rel = w["chest"].inverted() @ look
        w["neck"] = w["chest"] @ Quaternion().slerp(rel, 0.45)
        w["head"] = look

        pelvis = sk.pelvis + out.offset

        def with_pelvis(point):
            return pelvis + q_hips @ (point - sk.pelvis)

        # Legs.
        self.reach = {}
        for s in SIDES:
            sign = 1.0 if s == "L" else -1.0
            ankle, q_foot, q_toe = self.foot(s, p)
            if p.get(f"f{s}ankle") is not None:
                ankle = p[f"f{s}ankle"].copy()  # a swinging foot follows its own path
            space = p[f"f{s}space"]
            if space > 0.0:
                ankle = ankle.lerp(with_pelvis(ankle), space)
                q_foot = q_foot.slerp(q_hips @ q_foot, space)
                q_toe = q_toe.slerp(q_hips @ q_toe, space)
            hip = with_pelvis(sk.head[f"thigh_{s}"])
            yaw_foot = rot(Z, p[f"f{s}yaw"]) @ AHEAD
            yaw_hips = q_hips @ AHEAD
            pole = (yaw_foot + yaw_hips).normalized()
            pole = rot(q_hips @ Z, p[f"k{s}out"] * sign) @ pole
            leg = self.leg[s]
            hinge, d1, d2, reach = self.two_bone(hip, ankle, leg["thigh"], leg["shin"], pole)
            self.reach[s] = reach
            for bone, d in ((f"thigh_{s}", d1), (f"shin_{s}", d2)):
                w[bone] = (frame(hinge, d) @ sk.rest[bone].to_matrix().transposed()).to_quaternion()
            w[f"foot_{s}"] = q_foot
            w[f"toe_{s}"] = q_toe

        # Arms.
        for s in SIDES:
            sign = 1.0 if s == "L" else -1.0
            q_clav = w["chest"] @ rot(Y, -p[f"a{s}elev"] * sign) @ rot(Z, -p[f"a{s}prot"] * sign)
            w[f"shoulder_{s}"] = q_clav
            # Hanging straight down, elbow hinge pointing inwards so it bends forwards.
            u = Vector((0.0, 0.0, -1.0))
            e = Vector((-1.0, 0.0, 0.0))
            q_arm = rot(X, -p[f"a{s}flex"]) @ rot(Y, -p[f"a{s}abd"] * sign) @ rot(u, p[f"a{s}twist"] * sign)
            u = w["chest"] @ (q_arm @ u)
            e = w["chest"] @ (q_arm @ e)
            f = rot(e, p[f"a{s}elbow"]) @ u
            ik = p[f"a{s}ik"]
            if ik > 0.0:
                shoulder_pos = self._chain_pos(out, f"upper_arm_{s}", w)
                target = Vector((p[f"a{s}ix"], p[f"a{s}iy"], p[f"a{s}iz"]))
                # Elbow points backwards and out, turned by the pole channel.
                pole = w["chest"] @ (rot(Z, p[f"a{s}pole"] * sign) @ Vector((0.35 * sign, 1.0, -0.2)))
                arm = self.arm[s]
                e_ik, u_ik, f_ik, _ = self.two_bone(shoulder_pos, target, arm["upper"], arm["fore"], pole)
                u = u.lerp(u_ik, ik).normalized()
                f = f.lerp(f_ik, ik).normalized()
                e = e.lerp(e_ik, ik)
            e_upper = (e - u * e.dot(u)).normalized()
            e_fore = (e - f * e.dot(f)).normalized()
            q_pron = rot(f, -p[f"a{s}pron"] * sign)
            e_hand = q_pron @ e_fore
            hand = rot(e_hand, p[f"a{s}wrist"]) @ f
            for bone, x_axis, d in (
                (f"upper_arm_{s}", e_upper, u),
                (f"forearm_{s}", e_fore, f),
                (f"hand_{s}", e_hand, hand),
            ):
                w[bone] = (frame(x_axis, d) @ sk.rest[bone].to_matrix().transposed()).to_quaternion()
        out.fk()
        return out

    def _chain_pos(self, out, bone, w):
        """Head position of `bone` given the rotations solved so far."""
        sk = self.sk
        chain = []
        name = bone
        while name is not None:
            chain.append(name)
            name = sk.parent[name]
        chain.reverse()
        pos = {}
        for name in chain:
            parent = sk.parent[name]
            if parent is None:
                pos[name] = sk.head[name].copy()
            elif name == "hips":
                pos[name] = sk.head[name] + out.offset
            else:
                pos[name] = pos[parent] + w[parent] @ (sk.head[name] - sk.head[parent])
        return pos[bone]


def pose(**channels):
    p = dict(NEUTRAL)
    p.update(channels)
    return p


# --------------------------------------------------------------------------
# Locomotion: one gait cycle with exact foot plants.


def wave(u, peak, amp=1.0):
    """A cosine over the cycle phase u that peaks at phase `peak`."""
    return amp * math.cos(2.0 * math.pi * (u - peak))


def wave2(u, peak, amp=1.0):
    """Twice per cycle (once per step), peaking at `peak` and half a cycle on."""
    return amp * math.cos(4.0 * math.pi * (u - peak))


class Gait:
    """A locomotion loop.

    The left foot touches down at phase 0 and the right at 0.5. During its
    stance a foot's reference point moves from `land` opposite to `direction`
    at exactly `speed`, while the foot rolls through `stance_pitch`. In the
    swing the ankle follows `swing_path` (root space) and the foot turns
    through `swing_pitch`; both meet the stance with matching velocity.
    `body(u)` returns the pelvis, trunk, head and arm channels for phase u.
    """

    def __init__(self, solver, frames, speed, direction, duty, land, yaw,
                 stance_pitch, swing_pitch, swing_path, body):
        self.solver = solver
        self.frames = frames
        self.T = frames / FPS
        self.speed = speed
        self.dir = Vector(direction).normalized()
        self.duty = duty
        self.land = {s: Vector((land[s][0], land[s][1], 0.0)) for s in SIDES}
        self.yaw = yaw
        keys = [(k * duty, v) for k, v in stance_pitch]
        keys += [(duty + k * (1.0 - duty), v) for k, v in swing_pitch]
        self.pitch = Curve(keys, period=1.0)
        self.lift_pitch = stance_pitch[-1][1]
        self.body = body
        self.paths = {}
        for s in SIDES:
            ts = duty * self.T
            dt = 1e-3
            off = self._stance_ankle(s, ts)
            v_off = (off - self._stance_ankle(s, ts - dt)) / dt
            on = self._stance_ankle(s, 0.0)
            v_on = (self._stance_ankle(s, dt) - on) / dt
            points = [(ts, off)]
            for k, xyz in swing_path[s]:
                points.append((ts + k * (self.T - ts), Vector(xyz)))
            points.append((self.T, on))
            self.paths[s] = Path(points, v_off, v_on)

    def _stance_channels(self, s, t):
        F = self.land[s] - self.dir * (self.speed * t)
        return {
            f"f{s}x": F.x, f"f{s}y": F.y, f"f{s}z": 0.0,
            f"f{s}yaw": self.yaw[s], f"f{s}pitch": self.pitch(t / self.T),
            f"f{s}toe": 0.0, f"f{s}flat": 1.0, f"f{s}ankle": None,
        }

    def _stance_ankle(self, s, t):
        p = dict(NEUTRAL)
        p.update(self._stance_channels(s, t))
        return self.solver.foot(s, p)[0]

    def foot_channels(self, s, t):
        """The channels of foot `s` at time t after its own touchdown."""
        t = t % self.T
        ts = self.duty * self.T
        if t <= ts:
            return self._stance_channels(s, t)
        k = (t - ts) / (self.T - ts)
        lift = min(-self.lift_pitch, TOE_BEND_MAX) if self.lift_pitch < 0 else 0.0
        land_pitch = self.pitch(0.0)
        toe = lerp(lift, 8.0, smoothstep(k / 0.3))
        flat = 1.0 - smoothstep(k / 0.2)
        if land_pitch < 0:
            # Toes come flat again as a forefoot landing nears the grass.
            toe = lerp(toe, -land_pitch, smoothstep((k - 0.8) / 0.2))
            flat = max(flat, smoothstep((k - 0.8) / 0.2))
        return {
            f"f{s}x": 0.0, f"f{s}y": 0.0, f"f{s}z": 0.0,
            f"f{s}yaw": self.yaw[s], f"f{s}pitch": self.pitch(t / self.T),
            f"f{s}toe": toe, f"f{s}flat": flat, f"f{s}ankle": self.paths[s](t),
        }

    def __call__(self, t):
        u = (t / self.T) % 1.0
        p = dict(NEUTRAL)
        p.update(self.body(u))
        p.update(self.foot_channels("L", t))
        p.update(self.foot_channels("R", t - self.T / 2.0))
        return p


def arm_swing(u, flex_mean, flex_amp, elbow_mean, elbow_amp, abd, twist, lag=0.04, pron=0.0):
    """Arms swinging against the legs: the left arm is forwards as the right foot lands."""
    out = {}
    for s, peak in (("L", 0.5), ("R", 0.0)):
        out[f"a{s}flex"] = flex_mean + wave(u, peak + lag, flex_amp)
        out[f"a{s}elbow"] = elbow_mean + wave(u, peak + lag + 0.06, elbow_amp)
        out[f"a{s}abd"] = abd + wave(u, peak + lag + 0.25, 2.0)
        out[f"a{s}twist"] = twist + wave(u, peak + lag, 4.0)
        out[f"a{s}pron"] = pron
        out[f"a{s}wrist"] = 5.0 + wave(u, peak + lag + 0.1, 4.0)
    return out


def trunk_cycle(u, duty, hz, bob, run, sway, hyaw, hroll, hpitch, lean, chest_yaw, look_down,
                flex_bob=1.5, surge=0.0):
    """Pelvis and trunk over a cycle; `run` puts the low point at mid-stance."""
    mid = duty / 2.0
    p = {}
    p["hz"] = hz + (-wave2(u, mid, bob) if run else wave2(u, mid, bob))
    p["hx"] = wave(u, mid, sway)
    p["hy"] = wave2(u, mid + 0.25, surge)
    p["hyaw"] = -wave(u, 0.02, hyaw)
    p["hroll"] = -wave(u, mid, hroll)
    p["hpitch"] = hpitch + wave2(u, mid + 0.05, 1.0)
    chest_world = wave(u, 0.04, chest_yaw)
    twist = chest_world - p["hyaw"]
    p["stwist"] = 0.4 * twist
    p["ctwist"] = 0.6 * twist
    p["sside"] = 0.6 * wave(u, mid, hroll)
    p["cside"] = 0.3 * wave(u, mid, hroll)
    p["sflex"] = 0.45 * lean + wave2(u, mid + 0.03, flex_bob)
    p["cflex"] = 0.55 * lean - hpitch * 0.3
    p["look_down"] = look_down + wave2(u, mid + 0.06, 1.0)
    p["look_yaw"] = wave(u, 0.04, 1.5)
    return p


# --------------------------------------------------------------------------
# The clips.


class Clip:
    def __init__(self, name, frames, sample, loop, speed=None, direction=None, contact=None):
        self.name = name
        self.direction = direction
        self.frames = frames
        self.sample = sample  # time (s) -> pose channels
        self.loop = loop
        self.speed = speed
        self.contact = contact

    def meta(self):
        out = {"loop": self.loop, "duration": round(self.frames / FPS, 4)}
        if self.speed is not None:
            out["speed"] = self.speed
            out["direction"] = self.direction
        if self.contact is not None:
            out["contact"] = round(self.contact, 4)
        return out


def _mirror_path(path):
    return [(k, (-x, y, z)) for k, (x, y, z) in path]


def idle_clip(solver):
    frames = 90
    T = frames / FPS

    def sample(t):
        u = t / T
        p = dict(NEUTRAL)
        p.update({
            "fLx": 0.13, "fLy": 0.01, "fLyaw": 9.0,
            "fRx": -0.13, "fRy": -0.01, "fRyaw": -9.0,
            "hx": wave(u, 0.25, 0.018),
            "hy": wave(u, 0.6, 0.006),
            "hz": -0.035 + wave(u, 0.0, 0.004) + wave2(u, 0.25, 0.003),
            "hroll": wave(u, 0.25, 1.6),
            "hyaw": wave(u, 0.1, 1.5),
            "hpitch": 2.0,
            "sside": -wave(u, 0.27, 1.0),
            "sflex": 1.0 + wave(u, 0.0, 0.6),
            "cflex": -1.0 - wave(u, 0.0, 0.8),
            "ctwist": wave(u, 0.15, 1.0),
            "look_yaw": wave(u, 0.35, 9.0) + wave2(u, 0.1, 2.0),
            "look_down": 3.0 + wave(u, 0.8, 2.0),
            "look_tilt": wave(u, 0.3, 1.5),
        })
        for s, sign in (("L", 1.0), ("R", -1.0)):
            p.update({
                f"a{s}elev": wave(u, 0.0, 1.2),
                f"a{s}flex": 3.0 + wave(u, 0.3 if s == "L" else 0.8, 2.0),
                f"a{s}abd": 9.0 + wave(u, 0.25, 1.0) * sign,
                f"a{s}elbow": 16.0 + wave(u, 0.4, 3.0),
                f"a{s}twist": 4.0,
                f"a{s}pron": 15.0,
                f"a{s}wrist": 6.0,
            })
        return p

    return Clip("idle", frames, sample, loop=True)


def walk_clip(solver):
    path_L = [(0.3, (0.085, 0.27, 0.20)), (0.6, (0.09, -0.06, 0.125)), (0.85, (0.085, -0.36, 0.12))]
    gait = Gait(
        solver, frames=32, speed=1.4, direction=AHEAD, duty=0.62,
        land={"L": (0.075, -0.33), "R": (-0.075, -0.33)},
        yaw={"L": 7.0, "R": -7.0},
        stance_pitch=[(0.0, 14.0), (0.12, 0.0), (0.45, 0.0), (0.65, -8.0), (0.85, -26.0), (1.0, -52.0)],
        swing_pitch=[(0.15, -38.0), (0.45, -6.0), (0.75, 6.0), (0.95, 12.0)],
        swing_path={"L": path_L, "R": _mirror_path(path_L)},
        body=lambda u: {
            **trunk_cycle(u, 0.62, hz=-0.045, bob=0.016, run=False, sway=0.022, hyaw=6.0, hroll=4.0,
                          hpitch=2.0, lean=3.0, chest_yaw=6.0, look_down=6.0, flex_bob=0.7),
            **arm_swing(u, -2.0, 16.0, 22.0, 10.0, abd=7.0, twist=4.0, pron=10.0),
        },
    )
    return Clip("walk", gait.frames, gait, loop=True, speed=gait.speed, direction="forward")


def jog_clip(solver):
    path_L = [(0.25, (0.07, 0.42, 0.33)), (0.5, (0.08, 0.10, 0.42)), (0.78, (0.07, -0.36, 0.26))]
    gait = Gait(
        solver, frames=22, speed=3.5, direction=AHEAD, duty=0.30,
        land={"L": (0.055, -0.25), "R": (-0.055, -0.25)},
        yaw={"L": 5.0, "R": -5.0},
        stance_pitch=[(0.0, 4.0), (0.12, 0.0), (0.45, 0.0), (0.75, -25.0), (1.0, -62.0)],
        swing_pitch=[(0.2, -60.0), (0.5, -30.0), (0.8, 0.0)],
        swing_path={"L": path_L, "R": _mirror_path(path_L)},
        body=lambda u: {
            **trunk_cycle(u, 0.30, hz=-0.06, bob=0.022, run=True, sway=0.012, hyaw=7.0, hroll=4.0,
                          hpitch=4.0, lean=8.0, chest_yaw=9.0, look_down=2.0),
            **arm_swing(u, -5.0, 35.0, 88.0, 14.0, abd=13.0, twist=6.0),
        },
    )
    return Clip("jog", gait.frames, gait, loop=True, speed=gait.speed, direction="forward")


def sprint_clip(solver):
    path_L = [(0.25, (0.08, 0.48, 0.48)), (0.5, (0.09, 0.0, 0.62)), (0.75, (0.08, -0.40, 0.45))]
    gait = Gait(
        solver, frames=14, speed=7.2, direction=AHEAD, duty=0.22,
        land={"L": (0.06, -0.24), "R": (-0.06, -0.24)},
        yaw={"L": 4.0, "R": -4.0},
        stance_pitch=[(0.0, -10.0), (0.3, -4.0), (0.55, -8.0), (1.0, -68.0)],
        swing_pitch=[(0.25, -65.0), (0.55, -30.0), (0.85, -12.0)],
        swing_path={"L": path_L, "R": _mirror_path(path_L)},
        body=lambda u: {
            **trunk_cycle(u, 0.22, hz=-0.07, bob=0.02, run=True, sway=0.006, hyaw=9.0, hroll=4.0,
                          hpitch=7.0, lean=12.0, chest_yaw=8.0, look_down=-4.0),
            **arm_swing(u, 2.0, 55.0, 90.0, 20.0, abd=12.0, twist=6.0),
        },
    )
    return Clip("sprint", gait.frames, gait, loop=True, speed=gait.speed, direction="forward")



def backpedal_clip(solver):
    path_L = [(0.3, (0.09, -0.22, 0.18)), (0.6, (0.095, 0.06, 0.23)), (0.85, (0.09, 0.27, 0.155))]
    gait = Gait(
        solver, frames=16, speed=2.5, direction=-AHEAD, duty=0.42,
        land={"L": (0.09, 0.24), "R": (-0.09, 0.24)},
        yaw={"L": 8.0, "R": -8.0},
        stance_pitch=[(0.0, -16.0), (0.3, -4.0), (0.7, -4.0), (1.0, -16.0)],
        swing_pitch=[(0.3, -22.0), (0.6, -30.0), (0.85, -22.0)],
        swing_path={"L": path_L, "R": _mirror_path(path_L)},
        body=lambda u: {
            **trunk_cycle(u, 0.42, hz=-0.085, bob=0.014, run=True, sway=0.012, hyaw=4.0, hroll=3.0,
                          hpitch=6.0, lean=10.0, chest_yaw=5.0, look_down=-6.0, flex_bob=1.0),
            **arm_swing(u, 8.0, 20.0, 78.0, 8.0, abd=16.0, twist=4.0),
        },
    )
    return Clip("backpedal", gait.frames, gait, loop=True, speed=gait.speed, direction="back")


def strafe_clip(solver, side):
    """A side-step towards `side`, the leading foot reaching out and the other closing."""
    lead, trail = ("L", "R") if side == "L" else ("R", "L")
    m = 1.0 if side == "L" else -1.0  # +X is the figure's left
    land = {lead: (0.38 * m, -0.01), trail: (-0.08 * m, 0.01)}
    paths = {
        lead: [(0.25, (0.10 * m, 0.0, 0.17)), (0.55, (0.25 * m, -0.02, 0.19)), (0.85, (0.36 * m, -0.01, 0.13))],
        trail: [(0.25, (-0.44 * m, 0.0, 0.17)), (0.55, (-0.28 * m, 0.02, 0.19)), (0.85, (-0.12 * m, 0.01, 0.13))],
    }
    # The left foot always lands at phase 0: when it trails, the body's cycle is offset.
    shift = 0.0

    def body(u):
        v = (u + shift) % 1.0
        p = trunk_cycle(v, 0.30, hz=-0.115, bob=0.012, run=True, sway=0.0, hyaw=2.0, hroll=2.0,
                        hpitch=6.0, lean=8.0, chest_yaw=3.0, look_down=0.0, flex_bob=0.8)
        p["hx"] = 0.02 * m
        p["kLout"] = p["kRout"] = 12.0
        p["sside"] += 2.0 * m
        p["look_yaw"] = 0.0
        for s, sign in (("L", 1.0), ("R", -1.0)):
            p.update({
                f"a{s}flex": 14.0 + wave2(v, 0.15, 3.0),
                f"a{s}abd": 22.0 + wave2(v, 0.1, 6.0) * (1.0 if s == lead else -0.5),
                f"a{s}elbow": 72.0 + wave2(v, 0.2, 6.0),
                f"a{s}twist": 8.0,
                f"a{s}pron": 25.0,
                f"a{s}wrist": 6.0,
            })
        return p

    gait = Gait(
        solver, frames=16, speed=2.5, direction=X * m, duty=0.30,
        land=land,
        yaw={"L": 6.0, "R": -6.0},
        stance_pitch=[(0.0, -8.0), (0.25, 0.0), (0.6, 0.0), (1.0, -24.0)],
        swing_pitch=[(0.3, -20.0), (0.6, -12.0), (0.85, -9.0)],
        swing_path=paths,
        body=body,
    )
    return Clip(f"strafe_{side}", gait.frames, gait, loop=True, speed=gait.speed,
                direction="left" if side == "L" else "right")


def strafe_L_clip(solver):
    return strafe_clip(solver, "L")


def strafe_R_clip(solver):
    return strafe_clip(solver, "R")


CLIP_BUILDERS = [idle_clip, walk_clip, jog_clip, sprint_clip, backpedal_clip, strafe_L_clip, strafe_R_clip]


# --------------------------------------------------------------------------
# Keying.


def sample_clip(solver, clip):
    """Solve every frame of a clip: [(rotations, hips location, solved pose)]."""
    out = []
    for f in range(clip.frames + 1):
        solved = solver.solve(clip.sample(f / FPS))
        rotations, location = solved.basis()
        out.append((rotations, location, solved))
    return out


def _key_action(armature, name, frames, loop):
    action = bpy.data.actions.new(name)
    action.use_fake_user = True
    armature.animation_data.action = action
    bones = [b for b in frames[0][0] if b != "root"]  # the root never moves
    previous = {}
    curves = {}
    for bone in bones:
        path = f'pose.bones["{bone}"].rotation_quaternion'
        curves[(bone, "rot")] = [
            action.fcurve_ensure_for_datablock(armature, path, index=i, group_name=bone) for i in range(4)
        ]
    location_path = 'pose.bones["hips"].location'
    curves[("hips", "loc")] = [
        action.fcurve_ensure_for_datablock(armature, location_path, index=i, group_name="hips") for i in range(3)
    ]
    values = {key: [[] for _ in fcs] for key, fcs in curves.items()}
    for f, (rotations, location, _) in enumerate(frames):
        for bone in bones:
            q = rotations[bone]
            if bone in previous and previous[bone].dot(q) < 0.0:
                q = -q  # keep each bone's quaternions on one hemisphere
            previous[bone] = q
            for i in range(4):
                values[(bone, "rot")][i] += (f, q[i])
        for i in range(3):
            values[("hips", "loc")][i] += (f, location[i])
    for key, fcs in curves.items():
        for fc, co in zip(fcs, values[key]):
            fc.keyframe_points.add(len(co) // 2)
            fc.keyframe_points.foreach_set("co", co)
            for point in fc.keyframe_points:
                point.interpolation = "LINEAR"
            fc.update()
    action.use_frame_range = True
    action.frame_start = 0
    action.frame_end = len(frames) - 1
    action.use_cyclic = loop
    return action


def build_clips(armature):
    """Create one Action per clip on `armature` and return {name: metadata}."""
    scene = bpy.context.scene
    scene.render.fps = FPS
    scene.render.fps_base = 1.0
    for pose_bone in armature.pose.bones:
        pose_bone.rotation_mode = "QUATERNION"
    if armature.animation_data is None:
        armature.animation_data_create()
    solver = Solver(armature)
    meta = {}
    for builder in CLIP_BUILDERS:
        clip = builder(solver)
        frames = sample_clip(solver, clip)
        action = _key_action(armature, clip.name, frames, clip.loop)
        track = armature.animation_data.nla_tracks.new()
        track.name = clip.name
        track.mute = True  # in Blender, play one clip at a time; the exporter reads every track
        strip = track.strips.new(clip.name, 0, action)
        if strip.action_slot is None and action.slots:
            strip.action_slot = action.slots[0]
        armature.animation_data.action = None
        meta[clip.name] = clip.meta()
    scene.frame_start = 0
    scene.frame_end = int(round(max(m["duration"] for m in meta.values()) * FPS))
    return meta
