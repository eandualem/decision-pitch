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

import compact

FPS = 30  # clips are timed in frames of 1/30 s
KEYS = 2  # and keyed this many times a frame, so a quick foot's arc survives the linear interpolation

X = Vector((1.0, 0.0, 0.0))
Y = Vector((0.0, 1.0, 0.0))
Z = Vector((0.0, 0.0, 1.0))
AHEAD = Vector((0.0, -1.0, 0.0))

HEEL_BACK = 0.03  # the heel's contact point, behind the ankle, on the sole
# Shoulder shrug: from an arm raised this far from hanging (deg) to fully, the shoulder
# rises and draws back by these angles.
SHRUG_FROM, SHRUG_FULL = 80.0, 160.0
SHRUG_UP, SHRUG_BACK = 25.0, 8.0
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
        # Hand reach: weight, wrist target (root space) and how far the elbow turns out.
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

        # Arms. As an arm rises above the shoulder the shoulder shrugs up and back with it,
        # as a real one does, so the skin over the joint rides up instead of collapsing.
        for s in SIDES:
            sign = 1.0 if s == "L" else -1.0

            def clavicle(arm_dir):
                local = w["chest"].inverted() @ arm_dir
                raised = math.degrees(math.acos(max(-1.0, min(1.0, -local.z))))  # 0 hanging, 180 overhead
                k = smoothstep((raised - SHRUG_FROM) / (SHRUG_FULL - SHRUG_FROM))
                elev = p[f"a{s}elev"] + SHRUG_UP * k
                prot = p[f"a{s}prot"] - SHRUG_BACK * k
                w[f"shoulder_{s}"] = w["chest"] @ rot(Y, -elev * sign) @ rot(Z, -prot * sign)

            # Hanging straight down, elbow hinge pointing inwards so it bends forwards.
            u = Vector((0.0, 0.0, -1.0))
            e = Vector((-1.0, 0.0, 0.0))
            q_arm = rot(X, -p[f"a{s}flex"]) @ rot(Y, -p[f"a{s}abd"] * sign) @ rot(u, p[f"a{s}twist"] * sign)
            u = w["chest"] @ (q_arm @ u)
            e = w["chest"] @ (q_arm @ e)
            f = rot(e, p[f"a{s}elbow"]) @ u
            clavicle(u)
            ik = p[f"a{s}ik"]
            if ik > 0.0:
                u_fk, f_fk, e_fk = u, f, e
                target = Vector((p[f"a{s}ix"], p[f"a{s}iy"], p[f"a{s}iz"]))
                # Elbow points backwards and out, turned by the pole channel.
                pole = w["chest"] @ (rot(Z, -p[f"a{s}pole"] * sign) @ Vector((0.35 * sign, 1.0, -0.2)))
                arm = self.arm[s]
                for i in range(3):  # the shrug moves the shoulder the reach starts from
                    if i:
                        clavicle(u)
                    shoulder_pos = self._chain_pos(out, f"upper_arm_{s}", w)
                    e_ik, u_ik, f_ik, _ = self.two_bone(shoulder_pos, target, arm["upper"], arm["fore"], pole)
                    u = u_fk.lerp(u_ik, ik).normalized()
                    f = f_fk.lerp(f_ik, ik).normalized()
                    e = e_fk.lerp(e_ik, ik)
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
                 stance_pitch, swing_pitch, swing_path, body, drop=0.4):
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
            v_on.z -= drop  # the foot comes down onto the grass rather than skimming it
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
    def __init__(self, name, frames, sample, loop, speed=None, direction=None, contact=None, duty=None, **info):
        self.name = name
        self.direction = direction
        self.frames = frames
        self.sample = sample  # time (s) -> pose channels
        self.loop = loop
        self.speed = speed
        self.contact = contact
        self.duty = duty  # a loop's share of the cycle each foot is on the grass
        self.info = info  # more of figure.json's description

    def meta(self):
        out = {"loop": self.loop, "duration": round(self.frames / FPS, 4)}
        if self.speed is not None:
            out["speed"] = self.speed
            out["direction"] = self.direction
        if self.contact is not None:
            out["contact"] = round(self.contact, 4)
        if self.duty is not None:
            out["duty"] = round(self.duty, 4)
        out.update(self.info)
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
                          hpitch=2.0, lean=3.0, chest_yaw=8.0, look_down=6.0, flex_bob=0.7),
            **arm_swing(u, -2.0, 17.0, 28.0, 10.0, abd=7.0, twist=4.0, pron=10.0),
        },
    )
    return Clip("walk", gait.frames, gait, loop=True, speed=gait.speed, direction="forward", duty=gait.duty)


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
            **arm_swing(u, -5.0, 35.0, 88.0, 14.0, abd=13.0, twist=-2.0),
        },
    )
    return Clip("jog", gait.frames, gait, loop=True, speed=gait.speed, direction="forward", duty=gait.duty)


def sprint_clip(solver):
    path_L = [(0.25, (0.08, 0.38, 0.50)), (0.5, (0.09, -0.04, 0.62)), (0.75, (0.08, -0.32, 0.42))]
    gait = Gait(
        solver, frames=14, speed=7.2, direction=AHEAD, duty=0.22,
        land={"L": (0.06, -0.17), "R": (-0.06, -0.17)},
        yaw={"L": 4.0, "R": -4.0},
        stance_pitch=[(0.0, -12.0), (0.3, -5.0), (0.55, -10.0), (1.0, -64.0)],
        swing_pitch=[(0.25, -62.0), (0.55, -32.0), (0.85, -18.0)],
        swing_path={"L": path_L, "R": _mirror_path(path_L)},
        body=lambda u: {
            **trunk_cycle(u, 0.22, hz=-0.07, bob=0.02, run=True, sway=0.006, hyaw=9.0, hroll=4.0,
                          hpitch=9.0, lean=18.0, chest_yaw=8.0, look_down=-2.0),
            # The whole body leans: the hips run a little ahead of the feet.
            "hy": -0.06,
            **arm_swing(u, -2.0, 50.0, 90.0, 16.0, abd=12.0, twist=-4.0),
        },
    )
    return Clip("sprint", gait.frames, gait, loop=True, speed=gait.speed, direction="forward", duty=gait.duty)



def backpedal_clip(solver):
    path_L = [(0.3, (0.09, -0.22, 0.20)), (0.6, (0.095, 0.06, 0.26)), (0.85, (0.09, 0.26, 0.19))]
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
    return Clip("backpedal", gait.frames, gait, loop=True, speed=gait.speed, direction="back", duty=gait.duty)


def strafe_clip(solver, side):
    """A quick side shuffle towards `side` in the jockeying stance, the leading foot reaching
    out and the other closing up to it: footwork for defending, so it is in that set."""
    return JOCKEY.shuffle(solver, f"strafe_{side}", "jockey", 90.0 if side == "L" else -90.0, 2.5, 16, 0.30,
                          height=0.19)


def strafe_L_clip(solver):
    return strafe_clip(solver, "L")


def strafe_R_clip(solver):
    return strafe_clip(solver, "R")


# --------------------------------------------------------------------------
# Loops in every direction. The page blends the loops of the two directions either
# side of the way a player travels against the way it faces, so each direction
# has a loop at a walk and at a jog. Off to the side and back on a diagonal the
# player opens its hips towards the travel and steps across, the chest turned
# half as far and the head still on the play, as a player keeping its shape while
# watching the ball does: every direction but straight back then steps alike and
# blends with its neighbours. Straight back is a backward walk or a backpedal.
# Each is made for the figure's left and mirrored for its right.

ANGLES = {"forward": 0.0, "forward_left": 45.0, "left": 90.0, "back_left": 135.0,
          "back": 180.0, "back_right": -135.0, "right": -90.0, "forward_right": -45.0}
NAMES = {0.0: "forward", 45.0: "forward_left", 90.0: "left", 135.0: "back_left", 180.0: "back",
         -45.0: "forward_right", -90.0: "right", -135.0: "back_right"}
MIRRORED = {"forward_left": "forward_right", "left": "right", "back_left": "back_right"}
HIPS = {45.0: 22.0, 90.0: 55.0, 135.0: 80.0}  # how far the pelvis opens towards the travel


def heading(angle):
    """The unit vector `angle` degrees anticlockwise from the way the figure faces."""
    a = math.radians(angle)
    return Vector((math.sin(a), -math.cos(a), 0.0))


def steps(angle, speed, frames, duty, ahead, width, hips=0.0, spread=0.0, swing=(), out=0.0):
    """Where both feet land and how they swing, for a loop travelling at `angle`.

    Each foot keeps to its own side of the pelvis, turned `hips` degrees: `width`
    out along the pelvis's side-to-side axis, then `spread` further across the
    travel, so feet passing on a diagonal clear each other. A foot lands `ahead`
    of that point along the travel and is carried back `speed * duty * T` on the
    grass. `swing` lists (k, along, z): at fraction k of the swing the ankle is
    `along` of the way from where it lifted to where it lands (more than 1
    reaches past it) and `z` high, for both feet or as {side: [...]}; `out`
    takes it that much wider of the other foot, and a fourth number moves that
    point across the travel, to its left. Returns `land` and `swing_path` for
    Gait, in root space.
    """
    d = heading(angle)
    n = heading(angle + 90.0)  # across the travel, to its left
    side = rot(Z, hips) @ X
    across = math.copysign(1.0, side.dot(n))
    stance = speed * duty * frames / FPS
    land, paths = {}, {}
    for s, sign in (("L", 1.0), ("R", -1.0)):
        base = side * (width * sign) + n * (spread * across * sign)
        on = base + d * ahead
        off = on - d * stance
        land[s] = (on.x, on.y)
        paths[s] = []
        for k, along, z, *aside in (swing[s] if isinstance(swing, dict) else swing):
            point = off.lerp(on, along) + n * (out * across * sign + sum(aside))
            paths[s].append((k, (point.x, point.y, z)))
    return land, paths


def turned(p, hips, chest):
    """Turn the pelvis `hips` degrees and the chest to `chest` degrees from the way the
    figure faces (towards its left is positive), the head still looking that way. The
    pelvis's sway and surge turn with it."""
    p["hyaw"] += hips
    twist = chest - hips
    p["stwist"] += 0.4 * twist
    p["ctwist"] += 0.6 * twist
    shift = rot(Z, hips) @ Vector((p["hx"], p["hy"], 0.0))
    p["hx"], p["hy"] = shift.x, shift.y
    return p


def mirrored(clip, name, direction):
    """A loop mirrored left to right, half a cycle on so that its left foot still lands first."""
    shift = clip.frames / FPS / 2.0
    return Clip(name, clip.frames, lambda t: mirror(clip.sample(t + shift)), loop=True, speed=clip.speed,
                direction=direction, duty=clip.duty, **clip.info)


def walk_turned_clip(solver, angle, name):
    """A walk on a diagonal or to the side: the pelvis and feet turn towards the travel,
    the shoulders half as far and the head not at all."""
    frames, duty, speed = 32, 0.62, 1.4
    hips = HIPS[angle]
    across = angle - hips  # the travel against the pelvis
    land, paths = steps(angle, speed, frames, duty, ahead=0.34, width=0.075, hips=hips, spread=0.04,
                        swing=[(0.3, 0.35, 0.20), (0.6, 0.71, 0.125), (0.85, 1.03, 0.12)], out=0.012)
    toes = hips + 0.65 * across  # the feet point nearly along the travel

    def body(u):
        p = trunk_cycle(u, duty, hz=-0.045 - 0.03 * hips / 80.0, bob=0.016, run=False, sway=0.022, hyaw=6.0, hroll=4.0,
                        hpitch=2.0, lean=3.0, chest_yaw=8.0, look_down=6.0, flex_bob=0.7)
        p.update(arm_swing(u, -2.0, 17.0, 28.0, 10.0, abd=7.0, twist=4.0, pron=10.0))
        return turned(p, hips, 0.5 * hips)

    gait = Gait(
        solver, frames=frames, speed=speed, direction=heading(angle), duty=duty, land=land,
        yaw={"L": 7.0 + toes, "R": -7.0 + toes},
        stance_pitch=[(0.0, 14.0), (0.12, 0.0), (0.45, 0.0), (0.65, -8.0), (0.85, -26.0), (1.0, -52.0)],
        swing_pitch=[(0.15, -38.0), (0.45, -6.0), (0.75, 6.0), (0.95, 12.0)],
        swing_path=paths, body=body,
    )
    return Clip(name, frames, gait, loop=True, speed=speed, direction=NAMES[angle], duty=duty)


def jog_turned_clip(solver, angle, name):
    """A jog on a diagonal or to the side, turned like the walk and leaning into the travel."""
    frames, duty, speed = 21, 0.30, 4.0
    hips = HIPS[angle]
    across = angle - hips
    land, paths = steps(angle, speed, frames, duty, ahead=0.27, width=0.06, hips=hips, spread=0.035,
                        swing=[(0.25, 0.13, 0.33), (0.5, 0.545, 0.42), (0.78, 1.14, 0.26)], out=0.02)
    toes = hips + 0.65 * across

    def body(u):
        p = trunk_cycle(u, duty, hz=-0.07 - 0.03 * hips / 80.0, bob=0.024, run=True, sway=0.012, hyaw=7.0, hroll=4.0,
                        hpitch=4.0, lean=9.0, chest_yaw=9.0, look_down=2.0)
        p["sside"] += 0.4 * 9.0 * math.sin(math.radians(across))
        p.update(arm_swing(u, -5.0, 36.0 - 0.1 * hips, 88.0, 14.0, abd=13.0, twist=-2.0))
        return turned(p, hips, 0.5 * hips)

    gait = Gait(
        solver, frames=frames, speed=speed, direction=heading(angle), duty=duty, land=land,
        yaw={"L": 5.0 + toes, "R": -5.0 + toes},
        stance_pitch=[(0.0, 4.0), (0.12, 0.0), (0.45, 0.0), (0.75, -25.0), (1.0, -62.0)],
        swing_pitch=[(0.2, -60.0), (0.5, -30.0), (0.8, 0.0)],
        swing_path=paths, body=body,
    )
    return Clip(name, frames, gait, loop=True, speed=speed, direction=NAMES[angle], duty=duty)


def walk_B_clip(solver):
    """A walk backwards: the foot reaches back and lands on the ball, rolls flat and
    leaves from the heel."""
    frames, duty, speed = 24, 0.58, 1.4
    land, paths = steps(180.0, speed, frames, duty, ahead=0.40, width=0.085,
                        swing=[(0.3, 0.22, 0.14), (0.6, 0.66, 0.16), (0.85, 1.03, 0.13)], out=0.01)

    def body(u):
        p = trunk_cycle(u, duty, hz=-0.07, bob=0.012, run=False, sway=0.02, hyaw=-4.0, hroll=3.0,
                        hpitch=3.0, lean=4.0, chest_yaw=-5.0, look_down=4.0, flex_bob=0.6)
        p.update(arm_swing(u, 2.0, -12.0, 30.0, 8.0, abd=9.0, twist=4.0, pron=10.0))
        return p

    gait = Gait(
        solver, frames=frames, speed=speed, direction=heading(180.0), duty=duty, land=land,
        yaw={"L": 8.0, "R": -8.0},
        stance_pitch=[(0.0, -16.0), (0.2, 0.0), (0.75, 0.0), (1.0, 10.0)],
        swing_pitch=[(0.25, 6.0), (0.6, -8.0), (0.9, -16.0)],
        swing_path=paths, body=body, drop=0.3,
    )
    return Clip("walk_B", frames, gait, loop=True, speed=speed, direction="back", duty=duty)


def jog_B_clip(solver):
    """A quick backpedal at a jog, low, on the balls of the feet, leaning over them."""
    frames, duty, speed = 12, 0.36, 3.6
    land, paths = steps(180.0, speed, frames, duty, ahead=0.22, width=0.09,
                        swing=[(0.3, 0.18, 0.21), (0.6, 0.68, 0.26), (0.85, 1.04, 0.19)], out=0.008)

    def body(u):
        p = trunk_cycle(u, duty, hz=-0.10, bob=0.016, run=True, sway=0.012, hyaw=4.0, hroll=3.0,
                        hpitch=7.0, lean=12.0, chest_yaw=5.0, look_down=-6.0, flex_bob=1.0)
        p.update(arm_swing(u, 10.0, 24.0, 82.0, 8.0, abd=16.0, twist=4.0))
        return p

    gait = Gait(
        solver, frames=frames, speed=speed, direction=heading(180.0), duty=duty, land=land,
        yaw={"L": 8.0, "R": -8.0},
        stance_pitch=[(0.0, -16.0), (0.3, -4.0), (0.7, -4.0), (1.0, -18.0)],
        swing_pitch=[(0.3, -22.0), (0.6, -30.0), (0.85, -22.0)],
        swing_path=paths, body=body,
    )
    return Clip("jog_B", frames, gait, loop=True, speed=speed, direction="back", duty=duty)


# --------------------------------------------------------------------------
# Running with the ball. The page carries the ball ahead of the feet and meets it
# with the right boot at each dribble loop's `touch`: the phase at which the right
# toe reaches furthest ahead, low, as it swings through to plant at half the
# cycle. The toe meets the ball about where the engine carries it.

TOUCH = 0.4
TOUCH_REACH = 0.48  # m ahead of the root the right toe reaches at the touch: the ball's back
TOUCH_HEIGHT = 0.035  # m: the toe's height there, low behind the ball


def dribble_clip(solver, name, speed, frames, duty, ahead, low, lean, look, arms, angle=0.0, hips=0.0,
                 lift=0.28, aside=-0.02):
    """Running with the ball at the feet: shorter, quicker strides than the run, knees
    bent, the body over the ball and the eyes on it, the arms out for balance. The
    right foot swings through low and reaches furthest ahead at TOUCH, at the back of
    the ball (`aside` of the line the figure faces along), then pulls back a little to
    plant at half the cycle."""
    k = (TOUCH + 0.5 - duty) / (1.0 - duty)  # how far through its swing the right foot is at the touch
    hold = 0.04  # of the swing: the toe holds its furthest reach this long either side of the touch
    swing = {
        "L": [(0.25, 0.13, lift), (0.5, 0.55, lift + 0.03), (0.78, 1.08, 0.20)],
        "R": [(0.25, 0.13, lift), (0.55, 0.6, 0.20), (k - hold, 1.15, 0.10, 0.0), (k + hold, 1.15, 0.10, 0.0)],
    }

    def make(swing):
        land, paths = steps(angle, speed, frames, duty, ahead=ahead, width=0.065, hips=hips, spread=0.02 if hips else 0.0,
                            swing=swing, out=0.015)
        across = angle - hips
        toes = hips + 0.65 * across

        def body(u):
            p = trunk_cycle(u, duty, hz=-low, bob=0.018, run=True, sway=0.016, hyaw=5.0, hroll=4.0,
                            hpitch=6.0, lean=lean, chest_yaw=6.0, look_down=look, flex_bob=1.2)
            p.update(arm_swing(u, -2.0, arms[0], 84.0, 10.0, abd=arms[1], twist=-4.0))
            return turned(p, hips, 0.5 * hips) if hips else p

        return Gait(
            solver, frames=frames, speed=speed, direction=heading(angle), duty=duty, land=land,
            yaw={"L": 6.0 + toes, "R": -6.0 + toes},
            stance_pitch=[(0.0, 2.0), (0.15, 0.0), (0.45, 0.0), (0.75, -22.0), (1.0, -55.0)],
            swing_pitch=[(0.2, -55.0), (0.5, -25.0), (0.8, -4.0), (0.95, 0.0)],
            swing_path=paths, body=body,
        )

    # Aim the right toe at the back of the ball at the touch, as `aim` does for a kick.
    tip = solver.sk.tail["toe_R"]
    target = Vector((aside, -TOUCH_REACH, TOUCH_HEIGHT))
    d, n = heading(angle), heading(angle + 90.0)
    span = speed * duty * frames / FPS
    for _ in range(4):
        gait = make(swing)
        err = target - solver.solve(gait(TOUCH * gait.T)).point("toe_R", tip)
        for i in (-2, -1):
            at, along, z, across = swing["R"][i]
            swing["R"][i] = (at, along + err.dot(d) / span, z + err.z, across + err.dot(n))
    gait = make(swing)
    return Clip(name, frames, gait, loop=True, speed=speed, direction=NAMES.get(angle, "forward"), duty=duty,
                set="dribble", touch=TOUCH)


def dribble_clips(solver):
    """Close control at a jog, carrying it at a run and at pace, and the knock-on at a sprint,
    the eyes coming up off the ball as the pace rises."""
    return [
        dribble_clip(solver, "dribble_slow", 2.0, 21, 0.40, ahead=0.20, low=0.11, lean=19.0, look=36.0,
                     arms=(18.0, 22.0), lift=0.27),
        dribble_clip(solver, "dribble", 4.0, 16, 0.32, ahead=0.22, low=0.10, lean=18.0, look=32.0, arms=(26.0, 22.0)),
        dribble_clip(solver, "dribble_fast", 6.0, 14, 0.27, ahead=0.20, low=0.09, lean=18.0, look=22.0,
                     arms=(34.0, 18.0), lift=0.34),
        dribble_clip(solver, "dribble_sprint", 7.5, 14, 0.22, ahead=0.17, low=0.10, lean=19.0, look=10.0,
                     arms=(44.0, 14.0), lift=0.42),
    ]


# --------------------------------------------------------------------------
# Defending and shielding: low, wide stances that shuffle, the feet keeping their
# places rather than passing each other. Each set has a stance loop with no speed
# that the page plays when the player stands, and moving loops on the same feet.


def shuffle_steps(angle, speed, frames, duty, feet, swing, clear=0.14):
    """Landing points and swing paths of a shuffle travelling at `angle` from a stance
    with its feet at `feet` ({side: (x, y)}): the foot nearer the travel leads and the
    other follows, each on its own stretch of the travel, never passing (they are moved
    apart along the travel as far as that needs, with `clear` to spare). `swing` lists
    (k, along, z) as for `steps`."""
    d = heading(angle)
    stance = speed * duty * frames / FPS
    along = {s: Vector((*feet[s], 0.0)).dot(d) for s in SIDES}
    lead, trail = ("L", "R") if along["L"] >= along["R"] else ("R", "L")
    short = max(0.0, stance + clear - (along[lead] - along[trail]))
    land, paths = {}, {}
    for s in SIDES:
        centre = Vector((*feet[s], 0.0)) + d * (short / 2.0 if s == lead else -short / 2.0)
        on, off = centre + d * (stance / 2.0), centre - d * (stance / 2.0)
        land[s] = (on.x, on.y)
        paths[s] = [(k, (off.lerp(on, a).x, off.lerp(on, a).y, z)) for k, a, z in swing]
    return land, paths


class Stance:
    """A low stance: where the feet stand, how the body is held over them, and how it
    bounces on the balls of the feet. `body(u, p)` adds the arms and head."""

    def __init__(self, feet, yaw, hips, chest, hz, hy, lean, hpitch, knees, body):
        self.feet, self.yaw, self.hips, self.chest = feet, yaw, hips, chest
        self.hz, self.hy, self.lean, self.hpitch, self.knees = hz, hy, lean, hpitch, knees
        self.body = body

    def trunk(self, u, duty, bob, sway=0.0):
        p = trunk_cycle(u, duty, hz=self.hz, bob=bob, run=True, sway=sway, hyaw=2.0, hroll=2.0,
                        hpitch=self.hpitch, lean=self.lean, chest_yaw=2.0, look_down=0.0, flex_bob=0.8)
        p["hy"] += self.hy
        p["kLout"] = p["kRout"] = self.knees
        p = turned(p, self.hips, self.chest)
        self.body(u, p)
        return p

    def loop(self, solver, name, set_name, frames=36):
        """The stance itself, bouncing lightly and shifting its weight."""
        T = frames / FPS

        def sample(t):
            u = t / T
            p = dict(NEUTRAL)
            p.update(self.trunk(u, 0.5, 0.0))
            p["hz"] += wave2(u, 0.0, 0.008) + wave(u, 0.3, 0.004)
            p["hx"] += wave(u, 0.2, 0.025)
            p["hroll"] += wave(u, 0.2, 2.0)
            p["sside"] -= wave(u, 0.22, 1.2)
            for side in SIDES:
                x, y = self.feet[side]
                p.update({f"f{side}x": x, f"f{side}y": y, f"f{side}yaw": self.yaw[side],
                          f"f{side}pitch": -10.0 + wave2(u, 0.05, 3.0), f"f{side}flat": 1.0})
            return p

        return Clip(name, frames, sample, loop=True, set=set_name)

    def shuffle(self, solver, name, set_name, angle, speed, frames, duty, height=0.16):
        """The stance shuffling at `angle` and `speed`, without the feet passing."""
        land, paths = shuffle_steps(angle, speed, frames, duty, self.feet,
                                    [(0.25, 0.22, height), (0.55, 0.62, height + 0.02), (0.85, 0.95, height - 0.02)])
        gait = Gait(
            solver, frames=frames, speed=speed, direction=heading(angle), duty=duty, land=land, yaw=self.yaw,
            stance_pitch=[(0.0, -10.0), (0.3, -5.0), (0.7, -5.0), (1.0, -18.0)],
            swing_pitch=[(0.3, -10.0), (0.6, -2.0), (0.9, -6.0)],
            swing_path=paths, body=lambda u: self.trunk(u, duty, 0.012),
        )
        return Clip(name, frames, gait, loop=True, speed=speed, direction=NAMES[angle], duty=duty, set=set_name)


def _jockey_arms(u, p):
    """Arms low and out for balance, the head on the ball at the attacker's feet."""
    for side, sign in (("L", 1.0), ("R", -1.0)):
        p.update({f"a{side}flex": 22.0 + wave2(u, 0.1, 2.0), f"a{side}abd": 26.0 + wave2(u, 0.15, 3.0) * sign,
                  f"a{side}elbow": 48.0, f"a{side}twist": 12.0, f"a{side}pron": 30.0, f"a{side}wrist": 10.0})
    p["look_down"] = 14.0
    p["look_yaw"] = 0.0


# Side-on: the left foot forward, the pelvis turned to the right, showing the attacker
# the outside.
JOCKEY = Stance(
    feet={"L": (0.12, -0.15), "R": (-0.17, 0.12)}, yaw={"L": -12.0, "R": -40.0},
    hips=-32.0, chest=-14.0, hz=-0.17, hy=0.03, lean=18.0, hpitch=10.0, knees=24.0, body=_jockey_arms,
)


def jockey_clips(solver):
    """Jockeying: standing side-on, backing off and sliding across in front of the ball,
    at a walk and at a run. The quick side shuffles keep their old names."""
    clips = [JOCKEY.loop(solver, "jockey", "jockey")]
    for angle, way in ((180.0, "B"), (135.0, "BL"), (-135.0, "BR"), (90.0, "L"), (-90.0, "R")):
        clips.append(JOCKEY.shuffle(solver, f"jockey_{way}", "jockey", angle, 1.2, 16, 0.45))
    for angle, way in ((180.0, "B"), (135.0, "BL"), (-135.0, "BR")):
        clips.append(JOCKEY.shuffle(solver, f"jockey_run_{way}", "jockey", angle, 2.6, 14, 0.32, height=0.19))
    return clips


def _shield_arms(u, p):
    """Arms out wide and back to feel the opponent behind, the eyes on the ball and now and
    then over a shoulder."""
    for side, sign in (("L", 1.0), ("R", -1.0)):
        p.update({f"a{side}flex": -18.0 + wave(u, 0.3, 3.0), f"a{side}abd": 48.0 + wave(u, 0.1, 4.0) * sign,
                  f"a{side}elbow": 30.0, f"a{side}twist": -6.0, f"a{side}pron": 10.0, f"a{side}wrist": 5.0})
    p["look_down"] = 28.0
    p["look_yaw"] = 0.0


# Square and wide, the backside out into the opponent behind, over the ball.
SHIELD = Stance(
    feet={"L": (0.21, -0.02), "R": (-0.21, 0.02)}, yaw={"L": 14.0, "R": -14.0},
    hips=0.0, chest=0.0, hz=-0.19, hy=0.07, lean=24.0, hpitch=14.0, knees=12.0, body=_shield_arms,
)


def shield_clips(solver):
    """Shielding: holding the ball with the back to the opponent, backing in and sliding
    to either side."""
    stand = SHIELD.loop(solver, "shield", "shield", frames=72)
    sample = stand.sample

    def looking(t):  # a glance back over each shoulder in turn
        p = sample(t)
        u = t / (stand.frames / FPS)
        glance = smoothstep(1.0 - abs(u - 0.3) / 0.12) - smoothstep(1.0 - abs(u - 0.75) / 0.12)
        p["look_yaw"] += 55.0 * glance
        p["look_down"] -= 14.0 * abs(glance)
        return p

    stand.sample = looking
    clips = [stand]
    for angle, way in ((180.0, "B"), (90.0, "L"), (-90.0, "R")):
        clips.append(SHIELD.shuffle(solver, f"shield_{way}", "shield", angle, 1.0, 18, 0.5))
    return clips


def _both_sides(make):
    """A clip builder for the figure's left and its mirror image for the right."""
    def builder(solver):
        clip = make(solver)
        return [clip, mirrored(clip, clip.name[:-1] + "R", MIRRORED[clip.direction])]
    return builder


walk_FL_clips = _both_sides(lambda solver: walk_turned_clip(solver, 45.0, "walk_FL"))
jog_FL_clips = _both_sides(lambda solver: jog_turned_clip(solver, 45.0, "jog_FL"))
walk_L_clips = _both_sides(lambda solver: walk_turned_clip(solver, 90.0, "walk_L"))
jog_L_clips = _both_sides(lambda solver: jog_turned_clip(solver, 90.0, "jog_L"))
walk_BL_clips = _both_sides(lambda solver: walk_turned_clip(solver, 135.0, "walk_BL"))
jog_BL_clips = _both_sides(lambda solver: jog_turned_clip(solver, 135.0, "jog_BL"))



# --------------------------------------------------------------------------
# One-shots: key poses eased into each other, with overlap.

BALL = Vector((0.0, -0.6, 0.11))  # where the engine carries the ball, 0.11 m radius
BALL_RADIUS = 0.11

READY = dict(NEUTRAL)
READY.update({
    "fLx": 0.13, "fLy": 0.01, "fLyaw": 9.0, "fRx": -0.13, "fRy": -0.01, "fRyaw": -9.0,
    "hz": -0.035, "hpitch": 2.0, "sflex": 1.0, "cflex": -1.0, "look_down": 3.0,
})
for _s in SIDES:
    READY.update({f"a{_s}flex": 3.0, f"a{_s}abd": 9.0, f"a{_s}elbow": 16.0, f"a{_s}twist": 4.0,
                  f"a{_s}pron": 15.0, f"a{_s}wrist": 6.0})

KEEPER_READY = dict(READY)
KEEPER_READY.update({
    "fLx": 0.19, "fLy": -0.02, "fLyaw": 10.0, "fRx": -0.19, "fRy": -0.02, "fRyaw": -10.0,
    "fLpitch": -6.0, "fRpitch": -6.0,
    "hz": -0.13, "hy": 0.02, "hpitch": 10.0, "sflex": 9.0, "cflex": 3.0, "look_down": -4.0,
    "kLout": 10.0, "kRout": 10.0,
})
for _s in SIDES:
    KEEPER_READY.update({f"a{_s}flex": 32.0, f"a{_s}abd": 28.0, f"a{_s}elbow": 52.0,
                         f"a{_s}twist": -10.0, f"a{_s}pron": 50.0, f"a{_s}wrist": 15.0})


class Shot:
    """A clip from key poses: [(time, {channel: value})].

    Every channel a key mentions eases from key to key; before its first key
    and after its last it holds the base pose (keys are added at 0 and at the
    end). `lag` delays channels by prefix, so arms and head follow the trunk.
    `extra(t, p)` may change the pose afterwards for a procedural detail.
    """

    def __init__(self, base, end, keys, lag=None, extra=None, settle=True, period=None):
        self.base = base
        self.end = end
        self.lag = lag or {}
        self.extra = extra
        self.period = period
        self.keys = {}
        for t, channels in keys:
            for k, v in channels.items():
                self.keys.setdefault(k, {})[t] = v
        for k, ks in self.keys.items():
            if 0.0 not in ks:
                ks[0.0] = base[k]
            if settle and end not in ks:
                ks[end] = base[k]
        self._build()

    def _build(self):
        self.curves = {k: Curve(sorted(ks.items()), self.period) for k, ks in self.keys.items()}

    def nudge(self, t, deltas):
        for k, d in deltas.items():
            self.keys[k][t] = self.keys[k].get(t, self.base[k]) + d
        self._build()

    def _lag(self, k):
        best = 0.0
        best_len = 0
        for prefix, lag in self.lag.items():
            if k.startswith(prefix) and len(prefix) > best_len:
                best, best_len = lag, len(prefix)
        return best

    def __call__(self, t):
        p = dict(self.base)
        for k, c in self.curves.items():
            lag = self._lag(k)
            p[k] = c(t - lag if self.period else max(0.0, t - lag))
        if self.extra is not None:
            self.extra(t, p)
        return p


def aim(solver, shot, t, bone, rest_point, target, channels, passes=4):
    """Move a key's channels (x, y, z in that order) so a point on `bone` meets `target` at t."""
    for _ in range(passes):
        solved = solver.solve(shot(t))
        err = Vector(target) - solved.point(bone, rest_point)
        shot.nudge(t, {channels[0]: err.x, channels[1]: err.y, channels[2]: err.z})
    solved = solver.solve(shot(t))
    return (Vector(target) - solved.point(bone, rest_point)).length


_MIRROR_NEGATE = {"hx", "hyaw", "hroll", "sside", "stwist", "cside", "ctwist", "look_yaw", "look_tilt"}


def mirror(p):
    """The same pose mirrored left to right."""
    out = {}
    for k, v in p.items():
        if k in _MIRROR_NEGATE:
            out[k] = -v
            continue
        for a, b in (("L", "R"), ("R", "L")):
            if len(k) > 1 and k[1] == a and k[0] in "fak":
                other = k[0] + b + k[2:]
                if k[2:] in ("x", "ix") or k[2:] == "yaw":
                    out[other] = -v if v is not None else v
                elif k[2:] == "ankle":
                    out[other] = Vector((-v.x, v.y, v.z)) if v is not None else None
                else:
                    out[other] = v
                break
        else:
            out[k] = v
    return out


def _point(s, x, y, z):
    """A point given for the left side, mirrored to the right."""
    return Vector((x if s == "L" else -x, y, z))


# Points on the right foot, at rest, that meet the ball.
INSTEP_R = Vector((-0.10, -0.10, 0.075))  # the laces, just behind the ball of the foot
INSIDE_R = Vector((-0.055, -0.06, 0.04))  # the inside of the foot, at the arch


def pass_clip(solver):
    contact = 0.40
    keys = [
        (0.12, {"hy": -0.03, "hz": -0.045, "fRpitch": -8.0, "look_down": 16.0}),
        (0.16, {"fLz": 0.05, "fLy": -0.07, "fLpitch": 4.0}),
        (0.28, {"fLx": 0.18, "fLy": -0.20, "fLz": 0.0, "fLpitch": 8.0, "fLyaw": 4.0,
                "hx": 0.05, "hy": -0.10, "hz": -0.065, "hyaw": -14.0, "hpitch": 5.0, "hroll": 2.0,
                "fRx": -0.17, "fRy": 0.20, "fRz": 0.20, "fRyaw": -50.0, "fRpitch": -26.0, "fRflat": 0.0,
                "sflex": 9.0, "cflex": 3.0, "ctwist": 10.0, "sside": 3.0,
                "aLabd": 40.0, "aLflex": 25.0, "aLelbow": 35.0, "aRabd": 30.0, "aRflex": -22.0, "aRelbow": 28.0}),
        (0.33, {"fLpitch": 0.0}),
        (contact, {"fRx": -0.02, "fRy": -0.43, "fRz": 0.05, "fRyaw": -82.0, "fRpitch": 6.0, "fRtoe": 0.0,
                   "hx": 0.05, "hy": -0.13, "hz": -0.075, "hyaw": 4.0, "hpitch": 7.0, "hroll": -2.0,
                   "sflex": 10.0, "cflex": 3.0, "ctwist": -2.0, "sside": 2.0, "look_down": 22.0,
                   "aLabd": 48.0, "aLflex": 28.0, "aLelbow": 30.0, "aRabd": 38.0, "aRflex": 8.0, "aRelbow": 25.0}),
        (0.52, {"fRx": -0.03, "fRy": -0.66, "fRz": 0.10, "fRyaw": -70.0, "fRpitch": 8.0,
                "hy": -0.16, "hyaw": 9.0, "look_down": 24.0}),
        (0.70, {"fRx": -0.12, "fRy": -0.40, "fRz": 0.0, "fRyaw": -22.0, "fRpitch": 6.0, "fRflat": 1.0,
                "hx": 0.01, "hy": -0.17, "hz": -0.05, "sflex": 6.0, "cflex": 1.0, "ctwist": 0.0}),
        (0.78, {"fRpitch": 0.0, "fRyaw": -12.0}),
        (1.10, {"fLx": 0.17, "fLy": -0.20, "fLyaw": 6.0, "fRx": -0.12, "fRy": -0.40, "fRyaw": -10.0,
                "hx": 0.0, "hy": -0.17, "hz": -0.035, "hyaw": 0.0, "hroll": 0.0, "sside": 0.0}),
    ]
    shot = Shot(READY, 1.10, keys, lag={"aL": 0.04, "aR": 0.05, "look": -0.03})
    aim(solver, shot, contact, "foot_R", INSIDE_R, BALL + Vector((0.0, BALL_RADIUS, -0.01)), ("fRx", "fRy", "fRz"))
    return Clip("pass", int(round(1.10 * FPS)), shot, loop=False, contact=contact)


def shot_clip(solver):
    contact = 0.45
    keys = [
        (0.10, {"look_down": 20.0, "hz": -0.045, "fRpitch": -10.0}),
        (0.15, {"fLz": 0.06, "fLy": -0.08, "fLpitch": 4.0}),
        (0.30, {"fLx": 0.21, "fLy": -0.30, "fLz": 0.0, "fLpitch": 12.0, "fLyaw": 6.0,
                "hx": 0.06, "hy": -0.16, "hz": -0.075, "hyaw": -24.0, "hroll": 4.0, "hpitch": 4.0,
                "sflex": 3.0, "cflex": -5.0, "ctwist": 16.0, "sside": 7.0,
                "fRx": -0.10, "fRy": 0.26, "fRz": 0.40, "fRyaw": -12.0, "fRpitch": -62.0, "fRflat": 0.0, "fRtoe": 5.0,
                "aLabd": 80.0, "aLflex": 38.0, "aLelbow": 24.0, "aLtwist": -10.0,
                "aRabd": 38.0, "aRflex": -36.0, "aRelbow": 30.0}),
        (0.36, {"fLpitch": 0.0}),
        (0.395, {"fRx": -0.08, "fRy": 0.02, "fRz": 0.30, "fRyaw": -10.0, "fRpitch": -68.0}),
        # Over the ball at contact: chest above the knee, left arm out wide and up, right arm across.
        (contact, {"fRx": -0.04, "fRy": -0.33, "fRz": 0.06, "fRyaw": -8.0, "fRpitch": -58.0,
                   "hx": 0.05, "hy": -0.26, "hz": -0.09, "hyaw": 8.0, "hroll": -2.0, "hpitch": 10.0,
                   "sflex": 18.0, "cflex": 10.0, "ctwist": -8.0, "sside": 5.0, "look_down": 30.0,
                   "aLabd": 88.0, "aLflex": 32.0, "aLelbow": 28.0, "aLtwist": -10.0,
                   "aRabd": 12.0, "aRflex": 38.0, "aRelbow": 55.0, "aRtwist": 40.0}),
        (0.53, {"fRx": -0.03, "fRy": -0.78, "fRz": 0.36, "fRpitch": -52.0}),
        (0.63, {"fRx": -0.02, "fRy": -1.06, "fRz": 0.74, "fRpitch": -40.0, "fRyaw": -5.0,
                "fLpitch": -22.0, "hy": -0.30, "hz": -0.06, "hyaw": 15.0, "hroll": -3.0,
                "sflex": 12.0, "cflex": 6.0, "ctwist": -12.0, "look_down": 14.0,
                "aLabd": 60.0, "aLflex": -12.0, "aLelbow": 25.0, "aRabd": 14.0, "aRflex": 45.0, "aRtwist": 45.0,
                "aRelbow": 60.0}),
        (0.84, {"fRx": -0.11, "fRy": -0.56, "fRz": 0.0, "fRpitch": 8.0, "fRyaw": -10.0, "fRflat": 1.0, "fRtoe": 0.0,
                "fLpitch": -30.0, "hy": -0.33, "hz": -0.06, "hx": 0.0}),
        (0.93, {"fRpitch": 0.0}),
        (1.10, {"fLpitch": 0.0}),
        (1.30, {"fLx": 0.18, "fLy": -0.30, "fLyaw": 6.0, "fRx": -0.11, "fRy": -0.56, "fRyaw": -10.0,
                "hx": 0.0, "hy": -0.33, "hz": -0.035, "hyaw": 0.0, "hroll": 0.0, "sside": 0.0, "ctwist": 0.0}),
    ]
    shot = Shot(READY, 1.30, keys, lag={"aL": 0.04, "aR": 0.05, "look": -0.03})
    aim(solver, shot, contact, "foot_R", INSTEP_R, BALL + Vector((0.0, BALL_RADIUS * 0.8, 0.0)), ("fRx", "fRy", "fRz"))
    return Clip("shot", int(round(1.30 * FPS)), shot, loop=False, contact=contact)


def control_clip(solver):
    contact = 0.30
    keys = [
        (0.12, {"look_down": 26.0, "hz": -0.05, "hx": 0.03, "fRz": 0.04, "fRy": -0.08, "fRyaw": -40.0,
                "fRflat": 0.0, "fRpitch": 2.0}),
        (contact, {"fRx": -0.02, "fRy": -0.42, "fRz": 0.05, "fRyaw": -80.0, "fRpitch": 6.0,
                   "hx": 0.04, "hy": -0.10, "hz": -0.075, "hyaw": 3.0, "hpitch": 6.0,
                   "sflex": 13.0, "cflex": 4.0, "look_down": 32.0,
                   "aLabd": 32.0, "aLflex": 20.0, "aLelbow": 30.0, "aRabd": 28.0, "aRflex": 5.0, "aRelbow": 26.0}),
        (0.45, {"fRx": -0.07, "fRy": -0.30, "fRz": 0.05, "fRyaw": -50.0, "hy": -0.09, "look_down": 28.0}),
        (0.60, {"fRx": -0.13, "fRy": -0.16, "fRz": 0.0, "fRyaw": -14.0, "fRpitch": 0.0, "fRflat": 1.0,
                "hx": 0.0, "hz": -0.05, "sflex": 6.0, "cflex": 0.0}),
        (0.90, {"fRx": -0.13, "fRy": -0.16, "fRyaw": -10.0, "hy": -0.08, "hz": -0.035}),
    ]
    shot = Shot(READY, 0.90, keys, lag={"aL": 0.04, "aR": 0.05, "look": -0.03})
    aim(solver, shot, contact, "foot_R", INSIDE_R, BALL + Vector((0.0, BALL_RADIUS, -0.01)), ("fRx", "fRy", "fRz"))
    return Clip("control", int(round(0.90 * FPS)), shot, loop=False, contact=contact)


def tackle_clip(solver):
    """A slide tackle: down onto the left hip with the right boot out at the ball, then up again.

    The page plays it on the whole body while the engine carries the player
    along, so the slide itself comes from the engine's motion."""
    contact = 0.40
    end = 1.50
    slide = {
        "hx": 0.07, "hy": 0.34, "hz": -0.74, "hroll": 28.0, "hpitch": -28.0, "hyaw": 10.0,
        "sflex": 9.0, "cflex": 5.0, "sside": -14.0, "cside": -6.0, "look_down": 24.0,
        "fLx": 0.26, "fLy": 0.46, "fLz": 0.045, "fLpitch": -55.0, "fLyaw": 40.0, "fLflat": 0.0, "kLout": 33.0,
        "aLik": 1.0, "aLix": 0.47, "aLiy": 0.48, "aLiz": 0.12, "aLpole": 20.0, "aLwrist": 50.0, "aLpron": 30.0,
        "aRflex": 55.0, "aRabd": 55.0, "aRelbow": 35.0, "aRtwist": -10.0,
    }
    keys = [
        (0.12, {"hz": -0.10, "hy": 0.04, "hpitch": 2.0, "sflex": 4.0, "look_down": 14.0,
                "fRz": 0.04, "fRflat": 0.0, "fRpitch": -8.0}),
        (0.22, {"hz": -0.36, "hy": 0.20, "hroll": 14.0, "hpitch": -8.0, "hyaw": 6.0, "sside": -8.0,
                "fRx": -0.08, "fRy": -0.30, "fRz": 0.10, "fRpitch": 20.0, "fRyaw": -20.0,
                "fLx": 0.18, "fLy": 0.20, "fLpitch": -30.0, "fLflat": 1.0, "kLout": 30.0,
                "aLabd": 40.0, "aLflex": -20.0, "aLelbow": 20.0, "aLik": 0.0, "aRflex": 40.0, "aRabd": 40.0}),
        (0.32, {**slide, "fRx": -0.05, "fRy": -0.48, "fRz": 0.06, "fRpitch": 30.0, "fRyaw": -25.0}),
        (contact, {**slide, "fRx": -0.04, "fRy": -0.50, "fRz": 0.06, "fRpitch": 32.0, "fRyaw": -25.0}),
        (0.70, {**slide, "hy": 0.32, "fRx": -0.05, "fRy": -0.47, "fRz": 0.05, "fRpitch": 25.0, "fRyaw": -20.0,
                "look_down": 16.0}),
        (0.92, {"hx": 0.06, "hy": 0.22, "hz": -0.52, "hroll": 14.0, "hpitch": -4.0, "hyaw": 4.0,
                "sflex": 16.0, "cflex": 6.0, "sside": -6.0, "cside": -2.0, "look_down": 10.0,
                "fRx": -0.12, "fRy": -0.20, "fRz": 0.0, "fRpitch": 0.0, "fRyaw": -12.0, "fRflat": 1.0,
                "fLx": 0.20, "fLy": 0.30, "fLz": 0.0, "fLpitch": -50.0, "fLyaw": 15.0, "fLflat": 1.0, "kLout": 25.0,
                "aLik": 0.6, "aLix": 0.40, "aLiy": 0.20, "aLiz": 0.30,
                "aRflex": 40.0, "aRabd": 30.0, "aRelbow": 40.0}),
        (1.18, {"hx": 0.02, "hy": 0.06, "hz": -0.18, "hroll": 2.0, "hpitch": 10.0, "hyaw": 0.0,
                "sflex": 12.0, "cflex": 3.0, "sside": 0.0, "cside": 0.0, "look_down": 4.0,
                "fLx": 0.15, "fLy": 0.10, "fLpitch": 0.0, "fLyaw": 9.0, "kLout": 8.0,
                "aLik": 0.0, "aLabd": 20.0, "aLflex": 10.0, "aLelbow": 30.0, "aRflex": 15.0, "aRabd": 15.0,
                "aRelbow": 30.0, "aRtwist": 4.0}),
        (end, {"fLx": 0.14, "fLy": 0.06, "fRx": -0.12, "fRy": -0.16, "fRyaw": -10.0, "hy": -0.04, "hx": 0.0}),
    ]
    shot = Shot(READY, end, keys, lag={"aL": 0.04, "aR": 0.06, "look": -0.03})
    toe_head = solver.sk.head["toe_R"]
    aim(solver, shot, contact, "foot_R", toe_head, BALL + Vector((0.0, BALL_RADIUS * 0.9, 0.0)),
        ("fRx", "fRy", "fRz"))
    return Clip("tackle", int(round(end * FPS)), shot, loop=False, contact=contact)


def header_clip(solver):
    contact = 0.56
    air = {"fLpitch": -40.0, "fRpitch": -40.0, "fLflat": 0.0, "fRflat": 0.0}
    keys = [
        (0.22, {"hz": -0.20, "hpitch": 12.0, "sflex": 16.0, "cflex": 4.0, "look_down": -18.0,
                "aLflex": -38.0, "aRflex": -38.0, "aLabd": 16.0, "aRabd": 16.0, "aLelbow": 30.0, "aRelbow": 30.0}),
        (0.36, {"hz": 0.02, "hpitch": 2.0, "sflex": -8.0, "cflex": -8.0, "look_down": -32.0,
                "fLpitch": -45.0, "fRpitch": -45.0, "fLz": 0.0, "fRz": 0.0, "fLflat": 1.0, "fRflat": 1.0,
                "aLflex": 45.0, "aRflex": 45.0, "aLabd": 45.0, "aRabd": 45.0, "aLelbow": 85.0, "aRelbow": 85.0,
                "aLtwist": -20.0, "aRtwist": -20.0}),
        (0.42, {"fLz": 0.06, "fRz": 0.06, **air}),
        (contact, {"hz": 0.28, "hpitch": 4.0, "sflex": 9.0, "cflex": 8.0, "look_down": 12.0,
                   "fLz": 0.33, "fRz": 0.30, "fLy": 0.06, "fRy": 0.04,
                   "aLflex": 20.0, "aRflex": 20.0, "aLabd": 72.0, "aRabd": 72.0, "aLelbow": 75.0, "aRelbow": 75.0,
                   "aLtwist": -25.0, "aRtwist": -25.0}),
        (0.70, {"hz": 0.13, "fLz": 0.14, "fRz": 0.13, "fLy": 0.02, "fRy": 0.0, "look_down": 20.0, "sflex": 12.0}),
        (0.79, {"hz": -0.13, "fLz": 0.0, "fRz": 0.0, "fLpitch": -18.0, "fRpitch": -18.0, "fLflat": 1.0, "fRflat": 1.0,
                "hpitch": 9.0, "sflex": 12.0, "look_down": 12.0,
                "aLflex": 15.0, "aRflex": 15.0, "aLabd": 30.0, "aRabd": 30.0, "aLelbow": 30.0, "aRelbow": 30.0,
                "aLtwist": 0.0, "aRtwist": 0.0}),
        (0.88, {"fLpitch": 0.0, "fRpitch": 0.0, "hz": -0.15}),
        (1.25, {"fLy": 0.01, "fRy": -0.01}),
    ]
    shot = Shot(READY, 1.25, keys, lag={"aL": 0.03, "aR": 0.03, "look": -0.02})
    return Clip("header", int(round(1.25 * FPS)), shot, loop=False, contact=contact)


def _hands_on(ball, spread=0.13, back=0.03):
    """Wrist targets holding a ball between the palms."""
    return {"aLik": 1.0, "aRik": 1.0,
            "aLix": ball.x + spread, "aLiy": ball.y + back, "aLiz": ball.z,
            "aRix": ball.x - spread, "aRiy": ball.y + back, "aRiz": ball.z}


def throw_in_clip(solver):
    release = 0.60
    hold = Vector((0.0, -0.30, 1.22))
    behind = Vector((0.0, 0.12, 1.80))
    out = Vector((0.0, -0.26, 1.84))
    after = Vector((0.0, -0.52, 1.36))
    ik_on = {"aLik": 1.0, "aRik": 1.0, "aLpole": 55.0, "aRpole": 55.0}
    keys = [
        (0.12, {**ik_on, **_hands_on(hold), "look_down": 10.0, "hz": -0.05}),
        (0.18, {"fLz": 0.05, "fLy": -0.10}),
        (0.32, {"fLx": 0.11, "fLy": -0.30, "fLz": 0.0, "fLyaw": 4.0, "fLpitch": 6.0,
                "fRx": -0.12, "fRy": 0.10, "fRpitch": -28.0, "fRflat": 1.0,
                "hy": -0.06, "hz": -0.07}),
        (0.38, {"fLpitch": 0.0}),
        (0.44, {**_hands_on(behind, spread=0.135), "aLpole": 80.0, "aRpole": 80.0,
                "hy": -0.02, "hz": -0.08, "hpitch": -6.0, "sflex": -10.0, "cflex": -12.0, "look_down": -12.0}),
        (release, {**_hands_on(out, spread=0.13), "hy": -0.12, "hz": -0.06, "hpitch": 6.0,
                   "sflex": 12.0, "cflex": 9.0, "look_down": 4.0, "fRpitch": -40.0}),
        (0.72, {**_hands_on(Vector((0.0, -0.45, 1.66)), spread=0.15, back=0.0), "aLpole": 50.0, "aRpole": 50.0,
                "sflex": 15.0, "cflex": 10.0}),
        (0.92, {**_hands_on(after, spread=0.15, back=0.0), "aLpole": 30.0, "aRpole": 30.0,
                "hy": -0.13, "sflex": 15.0, "cflex": 8.0, "look_down": 10.0, "fRpitch": -38.0}),
        (1.15, {"aLik": 0.0, "aRik": 0.0, "fRpitch": 0.0, "hy": -0.12, "hz": -0.04, "hpitch": 2.0,
                "sflex": 2.0, "cflex": 0.0, "look_down": 4.0}),
        (1.40, {"fLx": 0.11, "fLy": -0.30, "fLyaw": 4.0, "fRx": -0.12, "fRy": 0.10, "hy": -0.10}),
    ]
    shot = Shot(READY, 1.40, keys, lag={"look": -0.03})
    return Clip("throw_in", int(round(1.40 * FPS)), shot, loop=False, contact=release)


def celebrate_clip(solver):
    end = 4.0
    up = {"aLabd": 150.0, "aRabd": 150.0, "aLflex": 25.0, "aRflex": 25.0, "aLelbow": 15.0, "aRelbow": 15.0,
          "aLpron": -40.0, "aRpron": -40.0}
    keys = [
        (0.30, {"hz": -0.12, "hpitch": 8.0, "sflex": 10.0, "cflex": -6.0, "look_down": -10.0,
                "aLflex": 35.0, "aRflex": 35.0, "aLelbow": 110.0, "aRelbow": 110.0, "aLabd": 30.0, "aRabd": 30.0,
                "fLpitch": 0.0, "fRpitch": 0.0}),
        (0.45, {"hz": 0.0, "fLpitch": -40.0, "fRpitch": -40.0, "fLz": 0.0, "fRz": 0.0, "fLflat": 1.0, "fRflat": 1.0}),
        (0.50, {"fLflat": 1.0, "fRflat": 1.0}),
        (0.56, {"fLz": 0.08, "fRz": 0.08, "fLflat": 0.0, "fRflat": 0.0}),
        (0.70, {"hz": 0.26, "hpitch": 2.0, "sflex": 3.0, "cflex": -2.0, "look_down": -16.0,
                "fLz": 0.26, "fRz": 0.22, "fLpitch": -45.0, "fRpitch": -40.0, "fLy": 0.06,
                "aRflex": 172.0, "aRabd": 12.0, "aRelbow": 8.0, "aLflex": 40.0, "aLelbow": 120.0, "aLabd": 25.0}),
        (0.88, {"hz": 0.10, "fLz": 0.08, "fRz": 0.07, "fLy": 0.02}),
        (1.00, {"hz": -0.14, "fLz": 0.0, "fRz": 0.0, "fLpitch": -12.0, "fRpitch": -12.0, "fLflat": 1.0, "fRflat": 1.0,
                "fLy": 0.01, "hpitch": 8.0, "sflex": 6.0, "look_down": -5.0}),
        (1.15, {"fLpitch": 0.0, "fRpitch": 0.0, "hz": -0.08}),
        (1.50, {**up, "hz": -0.04, "hpitch": 2.0, "sflex": 3.0, "cflex": -2.0, "look_down": -12.0}),
        (1.90, {"aLabd": 158.0, "aRabd": 146.0, "look_tilt": 6.0, "hz": -0.05}),
        (2.30, {"aLabd": 146.0, "aRabd": 156.0, "look_tilt": -4.0, "hz": -0.04}),
        (2.55, {**up}),
        (2.75, {"aLabd": 40.0, "aRabd": 40.0, "aLflex": 40.0, "aRflex": 40.0, "aLelbow": 120.0, "aRelbow": 120.0,
                "hz": -0.09, "sflex": 10.0, "cflex": 2.0, "look_down": 5.0}),
        (2.95, {"aLabd": 110.0, "aRabd": 110.0, "aLelbow": 70.0, "aRelbow": 70.0, "hz": -0.05, "sflex": 3.0,
                "cflex": -1.0, "look_down": -8.0}),
        (3.15, {"aLabd": 40.0, "aRabd": 40.0, "aLelbow": 120.0, "aRelbow": 120.0, "hz": -0.09, "sflex": 10.0,
                "cflex": 2.0, "look_down": 5.0}),
        (3.40, {"aLabd": 55.0, "aRabd": 55.0, "aLelbow": 60.0, "aRelbow": 60.0, "hz": -0.05}),
    ]
    shot = Shot(READY, end, keys, lag={"aL": 0.03, "aR": 0.05, "look": -0.03})
    return Clip("celebrate", int(round(end * FPS)), shot, loop=False)


# -- goalkeeper --------------------------------------------------------------


def keeper_dive_clip(solver, side):
    """A dive to the figure's own left (mirrored for the right).

    The body leaves the ground and lies out horizontally over the root, the
    page carrying the keeper across its goal; it lands on its side, gathers
    the arms in, gets up and steps back over the root."""
    stretch = 0.46
    end = 2.45
    air = {"fLspace": 1.0, "fRspace": 1.0, "fLflat": 0.0, "fRflat": 0.0}
    # Arms go up through the front, so on the ground they can come down in
    # front of the chest without sweeping through the grass.
    arms_up = {"aLabd": 14.0, "aRabd": 10.0, "aLflex": 172.0, "aRflex": 168.0, "aLelbow": 8.0, "aRelbow": 10.0,
               "aLtwist": 0.0, "aRtwist": 0.0, "aLpron": 0.0, "aRpron": 0.0}
    gather = {"aLabd": -14.0, "aRabd": 20.0, "aLflex": 85.0, "aRflex": 80.0, "aLelbow": 95.0, "aRelbow": 100.0,
              "aLtwist": 10.0, "aRtwist": 10.0}
    keys = [
        (0.10, {"hz": -0.18, "hx": 0.04, "hpitch": 12.0, "fLz": 0.0, "fLx": 0.19, "fRx": -0.19, "fLflat": 1.0}),
        (0.13, {"fLz": 0.05, "fLflat": 0.0}),
        (0.22, {"fLx": 0.36, "fLy": -0.06, "fLz": 0.0, "fLpitch": -8.0, "fLflat": 1.0,
                "hx": 0.14, "hz": -0.15, "hroll": 12.0, "sside": 6.0, "cside": 4.0,
                "aLabd": 45.0, "aRabd": 30.0, "aLflex": 100.0, "aRflex": 80.0, "aLelbow": 30.0, "aRelbow": 40.0}),
        (0.30, {"fLpitch": -35.0, "fRpitch": -45.0, "fRflat": 1.0, "fLspace": 0.0, "fRspace": 0.0,
                "hx": 0.22, "hz": -0.08, "hroll": 34.0, "sside": 10.0, "cside": 8.0, "look_body": 0.4,
                "aLabd": 30.0, "aRabd": 24.0, "aLflex": 142.0, "aRflex": 130.0}),
        (0.36, {**air,
                "fLx": 0.12, "fLy": -0.02, "fLz": 0.10, "fLpitch": -35.0,
                "fRx": -0.13, "fRy": 0.0, "fRz": 0.04, "fRpitch": -40.0}),
        (stretch, {**air, **arms_up, "hx": 0.32, "hz": -0.20, "hroll": 80.0, "hpitch": 6.0, "hyaw": 0.0,
                   "sside": 8.0, "cside": 8.0, "sflex": 4.0, "cflex": 0.0, "look_body": 0.85, "look_down": 0.0,
                   "fLx": 0.10, "fLy": -0.02, "fLz": 0.12, "fLpitch": -30.0,
                   "fRx": -0.12, "fRy": 0.02, "fRz": 0.04, "fRpitch": -35.0}),
        (0.64, {"hx": 0.42, "hz": -0.50, "hroll": 87.0, **arms_up, "aLabd": 0.0, "fLx": 0.05}),
        (0.80, {**arms_up, "hx": 0.46, "hz": -0.72, "hroll": 90.0, "sside": -3.0, "cside": -3.0,
                "aLabd": -10.0, "fLx": 0.02, "fLz": 0.10, "fRz": 0.12}),
        (1.05, {**gather, "hx": 0.46, "hz": -0.72, "hroll": 90.0, "look_body": 0.85, "fLx": 0.02,
                "sside": -3.0, "cside": -3.0}),
        (1.25, {**air, **gather, "hx": 0.45, "hz": -0.70, "hroll": 86.0, "fLx": 0.03, "fLz": 0.20, "fRz": 0.18}),
        # Getting up: roll onto the knees and stand.
        (1.40, {"fLspace": 0.35, "fRspace": 0.35, "fLz": 0.26, "fRz": 0.20, "fLpitch": -5.0, "fRpitch": -5.0,
                "fLx": 0.22, "fRx": 0.05, "hroll": 66.0, "hz": -0.61}),
        (1.55, {"hx": 0.40, "hz": -0.48, "hroll": 40.0, "hpitch": 30.0, "sflex": 20.0, "sside": 2.0, "cside": 0.0,
                "look_body": 0.3, "look_down": 15.0,
                "fLspace": 0.0, "fRspace": 0.0, "fLflat": 1.0, "fRflat": 1.0,
                "fLx": 0.48, "fLy": 0.10, "fLz": 0.0, "fLpitch": -60.0,
                "fRx": 0.20, "fRy": -0.10, "fRz": 0.0, "fRpitch": 0.0,
                "aLabd": 30.0, "aRabd": 30.0, "aLflex": 40.0, "aRflex": 30.0, "aLelbow": 30.0, "aRelbow": 40.0,
                "aLtwist": 0.0, "aRtwist": 0.0}),
        (1.90, {"hx": 0.24, "hz": -0.16, "hroll": 4.0, "hpitch": 14.0, "sflex": 10.0, "look_body": 0.0,
                "look_down": 0.0, "fLx": 0.50, "fLy": -0.02, "fLpitch": 0.0, "fRx": 0.17, "fRy": -0.02,
                "aLabd": 26.0, "aRabd": 26.0, "aLflex": 30.0, "aRflex": 30.0, "aLelbow": 50.0, "aRelbow": 50.0}),
        # Back over the root, where the engine has carried the keeper, by stepping across.
        (2.02, {"fRz": 0.05, "fRx": 0.08, "fRflat": 0.0}),
        (2.12, {"fRz": 0.0, "fRx": -0.04, "fRflat": 1.0, "hx": 0.12}),
        (2.22, {"fLz": 0.05, "fLx": 0.33, "fLflat": 0.0}),
        (end, {"hx": 0.0, "hz": -0.13, "hroll": 0.0, "hpitch": 10.0, "sflex": 9.0, "sside": 0.0, "cside": 0.0,
               "fLx": 0.19, "fLy": -0.02, "fLz": 0.0, "fLflat": 1.0, "fRx": -0.04, "fRy": -0.02}),
    ]
    shot = Shot(KEEPER_READY, end, keys, lag={"aL": 0.03, "aR": 0.05})
    name = f"keeper_dive_{side}"
    if side == "L":
        return Clip(name, int(round(end * FPS)), shot, loop=False, contact=stretch)
    return Clip(name, int(round(end * FPS)), lambda t: mirror(shot(t)), loop=False, contact=stretch)


def keeper_dive_L_clip(solver):
    return keeper_dive_clip(solver, "L")


def keeper_dive_R_clip(solver):
    return keeper_dive_clip(solver, "R")


def keeper_catch_clip(solver):
    contact = 0.32
    end = 1.10
    ball = Vector((0.0, -0.46, 1.10))
    chest = Vector((0.0, -0.24, 1.12))
    keys = [
        (0.15, {"aLik": 1.0, "aRik": 1.0, **_hands_on(ball + Vector((0, -0.06, 0.0)), spread=0.12, back=0.05),
                "aLpole": 5.0, "aRpole": 5.0, "aLpron": 70.0, "aRpron": 70.0, "aLwrist": -20.0, "aRwrist": -20.0,
                "hy": -0.04, "hz": -0.15, "look_down": 8.0}),
        (contact, {**_hands_on(ball, spread=0.11, back=0.06), "hy": -0.07, "hz": -0.16, "sflex": 14.0,
                   "cflex": 6.0, "look_down": 14.0}),
        (0.52, {**_hands_on(chest, spread=0.09, back=0.02), "aLpole": -10.0, "aRpole": -10.0,
                "sflex": 18.0, "cflex": 8.0, "hz": -0.17, "look_down": 26.0}),
        (end, {**_hands_on(chest, spread=0.09, back=0.02), "aLik": 1.0, "aRik": 1.0, "aLpole": -10.0,
               "aRpole": -10.0, "aLpron": 70.0, "aRpron": 70.0, "aLwrist": -20.0, "aRwrist": -20.0,
               "hy": -0.05, "hz": -0.08, "sflex": 10.0, "cflex": 4.0, "look_down": 18.0}),
    ]
    shot = Shot(KEEPER_READY, end, keys, lag={"look": -0.03})
    return Clip("keeper_catch", int(round(end * FPS)), shot, loop=False, contact=contact)


def keeper_catch_high_clip(solver):
    contact = 0.50
    end = 1.30
    high = Vector((0.0, -0.24, 2.17))
    chest = Vector((0.0, -0.24, 1.12))
    air = {"fLflat": 0.0, "fRflat": 0.0}
    keys = [
        (0.20, {"hz": -0.21, "hpitch": 14.0, "sflex": 14.0, "look_down": -25.0,
                "aLflex": -20.0, "aRflex": -20.0, "aLabd": 20.0, "aRabd": 20.0, "aLelbow": 35.0, "aRelbow": 35.0}),
        (0.34, {"hz": 0.0, "hpitch": 4.0, "sflex": 0.0, "fLpitch": -45.0, "fRpitch": -45.0, "fLz": 0.0, "fRz": 0.0,
                "fLflat": 1.0, "fRflat": 1.0,
                "aLflex": 120.0, "aRflex": 120.0, "aLabd": 20.0, "aRabd": 20.0, "aLik": 0.0, "aRik": 0.0}),
        (0.40, {"fLz": 0.06, "fRz": 0.06, **air}),
        (contact, {**air, "hz": 0.22, "hpitch": 2.0, "sflex": -4.0, "cflex": -6.0, "look_down": -40.0,
                   "fLz": 0.24, "fRz": 0.20, "fLy": 0.05, "fLpitch": -45.0, "fRpitch": -40.0,
                   "aLik": 1.0, "aRik": 1.0, **_hands_on(high, spread=0.11, back=0.02),
                   "aLpole": 30.0, "aRpole": 30.0, "aLpron": 80.0, "aRpron": 80.0, "aLwrist": -25.0, "aRwrist": -25.0}),
        (0.66, {"hz": 0.06, "fLz": 0.07, "fRz": 0.06, "fLy": 0.01, **_hands_on(chest + Vector((0, -0.05, 0.25)),
                                                                                  spread=0.10, back=0.02),
                "look_down": 0.0, "sflex": 8.0}),
        (0.76, {"hz": -0.15, "fLz": 0.0, "fRz": 0.0, "fLpitch": -15.0, "fRpitch": -15.0, "fLflat": 1.0, "fRflat": 1.0,
                **_hands_on(chest, spread=0.09, back=0.02), "aLpole": -10.0, "aRpole": -10.0,
                "sflex": 16.0, "cflex": 6.0, "hpitch": 12.0, "look_down": 22.0}),
        (0.86, {"fLpitch": -6.0, "fRpitch": -6.0, "hz": -0.17}),
        (end, {"hz": -0.08, "sflex": 10.0, "cflex": 4.0, "look_down": 18.0, "fLy": -0.02}),
    ]
    shot = Shot(KEEPER_READY, end, keys, lag={"look": -0.03}, settle=False)
    return Clip("keeper_catch_high", int(round(end * FPS)), shot, loop=False, contact=contact)


# -- the touchline -------------------------------------------------------------


def instruct_clip(solver):
    end = 2.8
    # The right arm points about 26 degrees right of the way the figure faces, nearly level;
    # the touchline turns a manager that much left of the player it instructs.
    point = {"aRflex": 90.0, "aRabd": 16.0, "aRelbow": 6.0, "aRpron": 70.0, "aRwrist": 0.0, "aRtwist": 0.0}
    hand_on_hip = {"aLik": 1.0, "aLix": 0.215, "aLiy": 0.03, "aLiz": 1.00, "aLpole": 75.0,
                   "aLpron": 40.0, "aLwrist": 25.0}
    keys = [
        (0.28, {**point, **hand_on_hip, "sflex": 4.0, "cflex": 2.0, "stwist": -4.0, "ctwist": -6.0,
                "hz": -0.04, "look_down": 0.0, "look_yaw": -6.0}),
        (0.55, {"aRflex": 82.0, "aRelbow": 28.0, "cflex": 0.0}),
        (0.75, {"aRflex": 94.0, "aRelbow": 4.0, "cflex": 4.0}),
        (1.05, {"aRflex": 82.0, "aRelbow": 26.0, "cflex": 1.0}),
        (1.25, {"aRflex": 94.0, "aRelbow": 4.0, "cflex": 4.0}),
        (1.60, {"aRflex": 90.0, "aRelbow": 10.0}),
        (2.20, {**point, **hand_on_hip, "aRflex": 90.0, "sflex": 4.0, "cflex": 2.0, "stwist": -4.0, "ctwist": -6.0,
                "look_yaw": -6.0}),
    ]
    shot = Shot(READY, end, keys, lag={"aL": 0.05, "look": -0.04})
    return Clip("instruct", int(round(end * FPS)), shot, loop=False)


def _rolling(t, p, start, stop, centre, radius, rate, phase=0.0, spread=0.06):
    """Forearms rolling round each other in front of the chest."""
    w = smoothstep((t - start) / 0.3) * (1.0 - smoothstep((t - stop) / 0.3))
    if w <= 0.0:
        return
    a = 2.0 * math.pi * rate * (t - start) + phase
    for s, sign, off in (("L", 1.0, 0.0), ("R", -1.0, math.pi)):
        p[f"a{s}ik"] = w
        p[f"a{s}ix"] = centre.x + spread * sign
        p[f"a{s}iy"] = centre.y + radius * math.sin(a + off)
        p[f"a{s}iz"] = centre.z + radius * math.cos(a + off)
        p[f"a{s}pole"] = 50.0
        p[f"a{s}pron"] = 60.0


def change_clip(solver):
    end = 2.6
    keys = [
        (0.30, {"sflex": 4.0, "cflex": 2.0, "look_down": 0.0, "hz": -0.04}),
        (2.25, {"sflex": 4.0, "cflex": 2.0}),
    ]
    centre = Vector((0.0, -0.36, 1.24))
    shot = Shot(READY, end, keys, extra=lambda t, p: _rolling(t, p, 0.05, 2.25, centre, 0.075, 1.75))
    return Clip("change", int(round(end * FPS)), shot, loop=False)


def _clapping(t, p, start, stop, centre, rate):
    w = smoothstep((t - start) / 0.3) * (1.0 - smoothstep((t - stop) / 0.3))
    if w <= 0.0:
        return
    beat = 0.5 - 0.5 * math.cos(2.0 * math.pi * rate * (t - start))  # 0 apart .. 1 together
    gap = lerp(0.20, 0.045, beat ** 1.5)
    for s, sign in (("L", 1.0), ("R", -1.0)):
        p[f"a{s}ik"] = w
        p[f"a{s}ix"] = centre.x + gap * sign
        p[f"a{s}iy"] = centre.y
        p[f"a{s}iz"] = centre.z + 0.02 * beat
        p[f"a{s}pole"] = 20.0
        p[f"a{s}pron"] = 0.0
        p[f"a{s}wrist"] = -10.0


def clap_clip(solver):
    end = 2.6
    keys = [(0.30, {"sflex": 3.0, "look_down": -2.0, "hz": -0.04}), (2.25, {"sflex": 3.0})]
    centre = Vector((0.0, -0.36, 1.28))
    shot = Shot(READY, end, keys, extra=lambda t, p: _clapping(t, p, 0.05, 2.25, centre, 2.3))
    return Clip("clap", int(round(end * FPS)), shot, loop=False)


def protest_clip(solver):
    end = 2.6
    spread = {"aLabd": 42.0, "aRabd": 42.0, "aLflex": 34.0, "aRflex": 34.0, "aLelbow": 48.0, "aRelbow": 48.0,
              "aLpron": -95.0, "aRpron": -95.0, "aLwrist": -20.0, "aRwrist": -20.0, "aLtwist": -20.0, "aRtwist": -20.0}
    keys = [
        (0.35, {**spread, "aLelev": 9.0, "aRelev": 9.0, "sflex": -3.0, "cflex": -4.0, "look_down": -6.0,
                "look_yaw": 0.0, "hz": -0.04}),
        (0.70, {"look_yaw": 12.0, "aLabd": 48.0, "aRabd": 48.0}),
        (0.95, {"look_yaw": -12.0}),
        (1.20, {"look_yaw": 10.0, "aLelev": 3.0, "aRelev": 3.0, "aLabd": 40.0, "aRabd": 40.0}),
        (1.45, {"look_yaw": -6.0, "aLelev": 10.0, "aRelev": 10.0, "aLabd": 52.0, "aRabd": 52.0, "aLelbow": 40.0,
                "aRelbow": 40.0}),
        (1.80, {"look_yaw": 0.0, "aLabd": 46.0, "aRabd": 46.0}),
        (2.20, {**spread, "aLelev": 4.0, "aRelev": 4.0, "sflex": -2.0, "cflex": -2.0, "look_down": -2.0}),
    ]
    shot = Shot(READY, end, keys, lag={"aR": 0.03, "look": -0.02})
    return Clip("protest", int(round(end * FPS)), shot, loop=False)


def cheer_clip(solver):
    end = 6.5
    up = {"aLabd": 155.0, "aRabd": 155.0, "aLflex": 20.0, "aRflex": 20.0, "aLelbow": 20.0, "aRelbow": 20.0,
          "aLpron": -30.0, "aRpron": -30.0}
    keys = [(0.35, {**up, "hz": -0.05, "sflex": 2.0, "cflex": -2.0, "look_down": -12.0})]
    t = 0.35
    for i in range(3):  # three small jumps, arms up
        keys += [
            (t + 0.25, {"hz": -0.12, "fLpitch": 0.0, "fRpitch": 0.0, "fLz": 0.0, "fRz": 0.0,
                        "aLabd": 150.0, "aRabd": 150.0}),
            (t + 0.42, {"hz": 0.04, "fLpitch": -38.0, "fRpitch": -38.0}),
            (t + 0.55, {"hz": 0.16, "fLz": 0.13, "fRz": 0.12, "aLabd": 162.0, "aRabd": 160.0}),
            (t + 0.70, {"hz": 0.04, "fLz": 0.0, "fRz": 0.0, "fLpitch": -30.0, "fRpitch": -30.0}),
            (t + 0.85, {"hz": -0.10, "fLpitch": 0.0, "fRpitch": 0.0}),
        ]
        t += 0.95
    keys += [(3.40, {**up, "hz": -0.05, "aLflex": 30.0, "aRflex": 30.0})]
    t = 3.5
    for i in range(4):  # fists clenched and pumped
        keys += [
            (t + 0.12, {"aLabd": 45.0, "aRabd": 45.0, "aLflex": 30.0, "aRflex": 30.0, "aLelbow": 125.0,
                        "aRelbow": 125.0, "hz": -0.08, "sflex": 10.0, "cflex": 2.0, "look_down": 4.0}),
            (t + 0.32, {"aLabd": 100.0, "aRabd": 100.0, "aLelbow": 80.0, "aRelbow": 80.0, "hz": -0.04,
                        "sflex": 2.0, "cflex": -2.0, "look_down": -10.0}),
        ]
        t += 0.55
    keys += [(5.85, {"aLabd": 40.0, "aRabd": 40.0, "aLelbow": 60.0, "aRelbow": 60.0, "hz": -0.04,
                     "sflex": 1.0, "cflex": -2.0, "look_down": 0.0})]
    shot = Shot(READY, end, keys, lag={"aL": 0.02, "aR": 0.04, "look": -0.03})
    return Clip("cheer", int(round(end * FPS)), shot, loop=False)


def despair_clip(solver):
    end = 5.5
    on_head = {"aLik": 1.0, "aRik": 1.0, "aLix": 0.12, "aRix": -0.12, "aLiy": 0.06, "aRiy": 0.06,
               "aLiz": 1.79, "aRiz": 1.79, "aLpole": 20.0, "aRpole": 20.0, "aLpron": 70.0, "aRpron": 70.0,
               "aLwrist": 30.0, "aRwrist": 30.0}
    on_hips = {"aLik": 1.0, "aRik": 1.0, "aLix": 0.215, "aRix": -0.215, "aLiy": 0.03, "aRiy": 0.03,
               "aLiz": 1.0, "aRiz": 1.0, "aLpole": 75.0, "aRpole": 75.0, "aLpron": 40.0, "aRpron": 40.0,
               "aLwrist": 25.0, "aRwrist": 25.0}
    keys = [
        (0.40, {**on_head, "sflex": -5.0, "cflex": -6.0, "look_down": -14.0, "hy": 0.02, "hz": -0.04}),
        (0.90, {"look_tilt": 5.0, "look_down": -10.0, "sflex": -3.0}),
        (1.45, {"look_tilt": -4.0, "look_down": -12.0}),
        (1.80, {**on_head, "look_tilt": 0.0, "sflex": -4.0}),
        (2.35, {**on_hips, "sflex": 9.0, "cflex": 6.0, "look_down": 34.0, "hy": 0.0, "hz": -0.03}),
        (3.60, {"look_yaw": 8.0, "look_down": 30.0, "sflex": 10.0}),
        (4.60, {**on_hips, "look_yaw": -3.0, "look_down": 34.0, "sflex": 9.0, "cflex": 6.0}),
    ]
    shot = Shot(READY, end, keys, lag={"aL": 0.03, "aR": 0.05, "look": -0.04})
    return Clip("despair", int(round(end * FPS)), shot, loop=False)


CLIP_BUILDERS = [
    idle_clip, walk_clip, jog_clip, sprint_clip, backpedal_clip, strafe_L_clip, strafe_R_clip,
    walk_FL_clips, jog_FL_clips, walk_L_clips, jog_L_clips, walk_BL_clips, jog_BL_clips, walk_B_clip, jog_B_clip,
    dribble_clips, jockey_clips, shield_clips,
    pass_clip, shot_clip, control_clip, tackle_clip, header_clip, throw_in_clip, celebrate_clip,
    keeper_dive_L_clip, keeper_dive_R_clip, keeper_catch_clip, keeper_catch_high_clip,
    instruct_clip, change_clip, clap_clip, protest_clip, cheer_clip, despair_clip,
]


# --------------------------------------------------------------------------
# Keying.


def sample_clip(solver, clip):
    """Solve every key of a clip: [(rotations, hips location, solved pose)]."""
    out = []
    for f in range(clip.frames * KEYS + 1):
        solved = solver.solve(clip.sample(f / (FPS * KEYS)))
        rotations, location = solved.basis()
        out.append((rotations, location, solved))
    return out


def _thin(co, tolerance=1e-4):
    """Keyframes [f0, v0, f1, v1, ...] without those the straight line between their
    neighbours reproduces within `tolerance`, so the .blend stays small; the exporter
    samples every frame of the curve again."""
    times, keys = co[0::2], [(v,) for v in co[1::2]]
    out = []
    for i in compact.kept(times, keys, compact.lerp, compact.distance, tolerance):
        out += (times[i], keys[i][0])
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
            co = _thin(co)
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
    scene.render.fps = FPS * KEYS
    scene.render.fps_base = 1.0
    for pose_bone in armature.pose.bones:
        pose_bone.rotation_mode = "QUATERNION"
    if armature.animation_data is None:
        armature.animation_data_create()
    solver = Solver(armature)
    meta = {}
    made = []
    for builder in CLIP_BUILDERS:
        clip = builder(solver)
        made.extend(clip if isinstance(clip, list) else [clip])
    for clip in made:
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
    scene.frame_end = int(round(max(m["duration"] for m in meta.values()) * FPS * KEYS))
    return meta
