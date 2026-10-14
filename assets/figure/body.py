"""The figure's body, its kit, hair, coat, shirt-number panel and variations.

The body is modelled around the skeleton's joints (`rig.JOINTS`) as signed
distance shapes (see `shapes.py`): a trunk lofted from measured sections,
muscles as ellipsoids, limbs as rounded cones, a face with brow, eyes, nose,
mouth and ears, hands with fingers and a thumb, and boots with soles. The kit
is modelled into the same surface: a shirt that sits a little off the body with
a collar, short sleeves and a hem, shorts that flare, socks with a turned-down
top over shin pads, and boots. The surface is meshed, decimated to the game
budget, cut along the kit's edges and split into the material regions the page
recolours.

`build_body(armature)` adds to the scene, all parented and skinned to the
armature:

- `body`: the figure, with materials skin, shirt, sleeve, hands, shorts, legs,
  socks, boots and the fixed eyes;
- `coat`: a manager's coat over the same body (material `coat`), hidden;
- `number`: the shirt-number panel on the back (material `number`), with UVs
  for the number's texture as read from behind;
- `hair_*`: one mesh per hair style (material `hair`), each carrying the brows,
  so the page shows exactly one;

and shape keys, exported as morph targets, that vary build and face. It returns
the names the page needs for `figure.json`.
"""

import math

import bmesh
import bpy
import numpy as np
from mathutils import Vector
from mathutils.bvhtree import BVHTree

import hair as hair_styles
import rig
import shapes as S
from meshes import collapse, keep_vertices, material, mesh_object, smooth
from shapes import Box, Cone, Cut, Ellipsoid, Footprint, Loft, Plane, Shell, Union, Within, frame
from shapes import both as _both

STEP = 0.0025  # m: the grid the body is sampled on
# The body's triangles (eyes excluded; a figure adds one hair mesh): the trunk and
# limbs, the rest of the head with the hands, and the face with the ears.
BODY_TRIANGLES = (4400, 1400, 1950)

J = {name: np.array(p, dtype=np.float64) for name, p in rig.JOINTS.items()}

REGIONS = ("skin", "shirt", "sleeve", "hands", "shorts", "legs", "socks", "boots")
FIXED = ("eyes",)
MORPHS = ("build_slim", "build_broad", "face_wide", "face_long", "jaw_strong", "nose_big")

class Segment:
    """A limb segment between two joints, with a frame: x out to the side, y to the front."""

    def __init__(self, a, b):
        self.a, self.b = J[a], J[b]
        self.axes = frame(self.b - self.a)
        self.length = float(np.linalg.norm(self.b - self.a))
        self.axis = self.axes[2]

    def at(self, t, out=0.0, front=0.0):
        return self.a + (self.b - self.a) * t + out * self.axes[0] + front * self.axes[1]

    def muscle(self, t, radii, out=0.0, front=0.0):
        return Ellipsoid(self.at(t, out, front), radii, self.axes)


UPPER_ARM = Segment("shoulder_L", "elbow_L")
FOREARM = Segment("elbow_L", "wrist_L")
HAND = Segment("wrist_L", "hand_tip_L")
THIGH = Segment("hip_L", "knee_L")
SHIN = Segment("knee_L", "ankle_L")

# The kit's edges, on the left limbs (the right mirror them): a point and the
# direction along the limb, beyond which the next region starts.
EDGES = {
    "sleeve": (UPPER_ARM.at(0.50), UPPER_ARM.axis),
    "wrist": (FOREARM.at(0.97), FOREARM.axis),
    "shorts": (THIGH.at(0.60), THIGH.axis),
    "sock": (SHIN.at(0.20), SHIN.axis),
    "boot": (SHIN.at(0.93), SHIN.axis),
}
SHIRT_HEM = 0.955  # m: height of the shirt's hem over the shorts, at the top of the hips
# The top of the collar: a plane through the neck, lower at the front.
COLLAR = (np.array([0.0, 0.03, 1.490]), np.array([0.0, -0.30, 1.0]) / math.hypot(0.30, 1.0))
NECK = Cone((0.0, 0.030, 1.42), (0.0, 0.025, 1.625), 0.066, 0.056)


def _keep_before(shape, edge, offset=0.0):
    """The part of `shape` before a kit edge (towards the trunk)."""
    point, axis = EDGES[edge]
    return Within(shape, Plane(point + axis * offset, axis, shape.lo - 0.1, shape.hi + 0.1))


def _keep_after(shape, edge, offset=0.0):
    point, axis = EDGES[edge]
    return Within(shape, Plane(point + axis * offset, -axis, shape.lo - 0.1, shape.hi + 0.1))


def _below(shape, z):
    return Within(shape, Plane((0, 0, z), (0, 0, 1), shape.lo - 0.1, shape.hi + 0.1))


def _above(shape, z):
    return Within(shape, Plane((0, 0, z), (0, 0, -1), shape.lo - 0.1, shape.hi + 0.1))


# The trunk -------------------------------------------------------------------------

# Sections of the trunk: z, half width, half depth to the front, to the back, centre y.
TRUNK = [
    (0.845, 0.128, 0.074, 0.082, 0.020),
    (0.88, 0.154, 0.088, 0.100, 0.022),
    (0.93, 0.166, 0.096, 0.106, 0.020),
    (0.98, 0.157, 0.098, 0.096, 0.018),
    (1.04, 0.148, 0.102, 0.092, 0.020),
    (1.10, 0.152, 0.108, 0.094, 0.020),
    (1.17, 0.160, 0.116, 0.102, 0.022),
    (1.24, 0.170, 0.121, 0.108, 0.024),
    (1.31, 0.176, 0.121, 0.112, 0.026),
    (1.37, 0.176, 0.112, 0.110, 0.028),
    (1.42, 0.162, 0.092, 0.096, 0.030),
    (1.47, 0.124, 0.062, 0.072, 0.032),
    (1.51, 0.075, 0.045, 0.055, 0.032),
]


def shoulders():
    """The shoulder girdle, left side: shoulder blade, trapezius and deltoid."""
    blade = Ellipsoid((0.085, 0.085, 1.34), (0.062, 0.030, 0.075))
    trapezius = Cone((0.035, 0.040, 1.488), (0.175, 0.035, 1.468), 0.040, 0.036)
    neck_slope = Cone((0.0, 0.045, 1.53), (0.10, 0.04, 1.478), 0.035, 0.030)
    deltoid = Ellipsoid(UPPER_ARM.at(0.10, out=0.021, front=0.002), (0.058, 0.064, 0.092), UPPER_ARM.axes)
    deltoid_front = Ellipsoid(UPPER_ARM.at(0.14, out=0.004, front=0.026), (0.038, 0.036, 0.068), UPPER_ARM.axes)
    return [blade, trapezius, neck_slope, deltoid, deltoid_front]


def trunk_core(chest=True):
    """The trunk with its muscles; without `chest` for the shirt, which hides the pectorals."""
    trunk = Loft(TRUNK, power=2.4, cap=0.03)
    pecs = Ellipsoid((0.070, -0.058, 1.335), (0.086, 0.030, 0.064), S.rotation(rz=-0.12))
    lats = Ellipsoid((0.125, 0.040, 1.26), (0.050, 0.064, 0.125), S.rotation(ry=0.22))
    glute = Ellipsoid((0.072, 0.072, 0.905), (0.078, 0.060, 0.085))
    return Union([trunk] + _both(([pecs] if chest else []) + [lats, glute] + shoulders()), k=0.035)


# How the shorts hang from the waist to the crotch: sections as for the trunk.
SHORTS = [
    (0.835, 0.150, 0.086, 0.096, 0.020),
    (0.88, 0.162, 0.096, 0.106, 0.020),
    (0.94, 0.168, 0.100, 0.110, 0.020),
    (0.99, 0.160, 0.102, 0.100, 0.020),
]

# How the shirt hangs from the chest over the waist: sections as for the trunk.
DRAPE = [
    (0.92, 0.166, 0.104, 0.108, 0.020),
    (0.96, 0.166, 0.106, 0.106, 0.020),
    (1.00, 0.164, 0.110, 0.102, 0.020),
    (1.10, 0.165, 0.118, 0.100, 0.021),
    (1.20, 0.172, 0.126, 0.106, 0.023),
    (1.28, 0.176, 0.128, 0.110, 0.025),
    (1.34, 0.176, 0.122, 0.112, 0.027),
]


def neck_core():
    neck = NECK
    sterno = Cone((0.050, 0.020, 1.635), (0.022, -0.012, 1.520), 0.016, 0.013)
    nape = Ellipsoid((0.0, 0.060, 1.56), (0.050, 0.030, 0.070))
    return Union([neck, nape] + _both([sterno]), k=0.02)


# The head --------------------------------------------------------------------------

EYE = np.array([0.0330, -0.0712, 1.684])  # left eyeball centre
EYE_RADIUS = 0.0124
CRANIUM = Ellipsoid((0.0, 0.012, 1.708), (0.080, 0.096, 0.092))


def head_core():
    face = Ellipsoid((0.0, -0.028, 1.650), (0.069, 0.068, 0.070))
    jaw = Ellipsoid((0.0, -0.018, 1.607), (0.059, 0.068, 0.045))
    chin = Ellipsoid((0.0, -0.072, 1.578), (0.026, 0.022, 0.021))
    muzzle = Ellipsoid((0.0, -0.068, 1.613), (0.040, 0.031, 0.034))
    jaw_line = Cone((0.054, 0.014, 1.615), (0.018, -0.074, 1.572), 0.011, 0.011)
    cheek = Ellipsoid((0.052, -0.060, 1.660), (0.024, 0.022, 0.016))
    brow = Cone((0.010, -0.0900, 1.700), (0.050, -0.0770, 1.704), 0.0105, 0.0060)
    buccal = Ellipsoid((0.044, -0.050, 1.628), (0.021, 0.026, 0.026))
    head = Union([CRANIUM, face, jaw, chin, muzzle] + _both([jaw_line, cheek, brow, buccal]), k=0.028)
    # Sockets for the eyes, then lids around them.
    socket = Ellipsoid(EYE + (0.0, -0.017, 0.002), (0.0200, 0.0160, 0.0140))
    head = Cut(head, Union(_both([socket])), k=0.006)
    lid = Shell(Ellipsoid(EYE, (EYE_RADIUS,) * 3), 0.0016)
    box = (lid.lo - 0.01, lid.hi + 0.01)
    upper = Within(lid, Plane(EYE + (0, 0, 0.0068), (0, 0.30, -1.0), *box))
    lower = Within(lid, Plane(EYE - (0, 0, 0.0080), (0, 0.30, 1.0), *box))
    behind = Plane(EYE + (0, 0.004, 0), (0, 1, 0), *box)
    head = Union([head] + _both([Within(upper, behind), Within(lower, behind)]), k=0.0025)
    # Nose: bridge, tip and wings.
    bridge = Cone((0.0, -0.0860, 1.686), (0.0, -0.1090, 1.641), 0.0058, 0.0095)
    tip = Ellipsoid((0.0, -0.1060, 1.6365), (0.0120, 0.0112, 0.0108))
    wing = Ellipsoid((0.0130, -0.0950, 1.6335), (0.0098, 0.0098, 0.0082))
    nose = Union([bridge, tip] + _both([wing]), k=0.006)
    head = Union([head, nose], k=0.006)
    nostril = Ellipsoid((0.0068, -0.1020, 1.6275), (0.0040, 0.0050, 0.0030))
    head = Cut(head, Union(_both([nostril])), k=0.002)
    # Mouth: lips and the line between them.
    upper_lip = Ellipsoid((0.0, -0.0910, 1.6110), (0.0235, 0.012, 0.0075))
    lower_lip = Ellipsoid((0.0, -0.0885, 1.5975), (0.0215, 0.012, 0.0085))
    head = Union([head, upper_lip, lower_lip], k=0.005)
    head = Cut(head, Ellipsoid((0.0, -0.0995, 1.6047), (0.0225, 0.012, 0.0013)), k=0.0015)
    # Ears: a shell with the hollow carved from the outside.
    ear_axes = S.rotation(rx=0.25, rz=-0.12)
    ear = Ellipsoid((0.0790, 0.010, 1.665), (0.013, 0.022, 0.031), ear_axes)
    hollow = Ellipsoid((0.0885, 0.008, 1.661), (0.0060, 0.0135, 0.0205), ear_axes)
    ear = Cut(ear, hollow, k=0.003)
    return Union([head] + _both([ear]), k=0.006)


def scalp():
    """The skull without the face, for laying hair on."""
    back = Ellipsoid((0.0, 0.030, 1.64), (0.062, 0.070, 0.070))
    return Union([CRANIUM, back], k=0.02)


# Limbs -----------------------------------------------------------------------------

def arm_core():
    upper = Cone(UPPER_ARM.at(0.0), UPPER_ARM.at(1.0), 0.050, 0.039)
    biceps = UPPER_ARM.muscle(0.52, (0.036, 0.033, 0.090), front=0.015)
    triceps = UPPER_ARM.muscle(0.38, (0.039, 0.034, 0.100), front=-0.017, out=0.004)
    elbow = Ellipsoid(UPPER_ARM.at(1.0, front=-0.008), (0.036, 0.031, 0.031), UPPER_ARM.axes)
    fore = Cone(FOREARM.at(0.0), FOREARM.at(1.0), 0.041, 0.026)
    flexors = FOREARM.muscle(0.28, (0.044, 0.036, 0.090), front=0.004)
    wrist = Ellipsoid(FOREARM.at(1.0), (0.028, 0.020, 0.016), FOREARM.axes)
    return Union([upper, biceps, triceps, elbow, fore, flexors, wrist], k=0.02)


def hand_core():
    """A relaxed hand: palm towards the thigh, fingers together and a little curled."""
    x, y, z = HAND.axes  # x: back of the hand, y: thumb side, z: towards the fingertips
    w = HAND.a

    def p(along, thumb=0.0, back=0.0):
        return w + z * along + y * thumb + x * back

    palm = Box(p(0.050, 0.002, 0.0), (0.0135, 0.039, 0.044), HAND.axes, round=0.011)
    heel = Ellipsoid(p(0.022, 0.0, -0.002), (0.016, 0.032, 0.026), HAND.axes)
    thenar = Ellipsoid(p(0.040, 0.022, -0.010), (0.012, 0.016, 0.026), HAND.axes)
    parts = [palm, heel, thenar]
    fingers = ((0.027, 0.070, 0.0086), (0.009, 0.078, 0.0088), (-0.009, 0.073, 0.0084), (-0.026, 0.058, 0.0075))
    for offset, length, radius in fingers:
        base = p(0.092, offset, 0.0)
        bend = -0.30  # curl towards the palm (-x)
        mid = base + z * (length * 0.5) + x * (length * 0.5 * math.sin(bend * 0.6))
        end_dir = z * math.cos(bend * 1.6) + x * math.sin(bend * 1.6)
        tip = mid + end_dir * (length * 0.5)
        parts += [Cone(base, mid, radius, radius * 0.95), Cone(mid, tip, radius * 0.95, radius * 0.82)]
    knuckle = Cone(p(0.090, 0.030, 0.002), p(0.090, -0.028, 0.002), 0.0095, 0.0085)
    thumb_a = p(0.024, 0.024, -0.006)
    thumb_b = p(0.058, 0.044, -0.016)
    thumb_c = p(0.088, 0.050, -0.024)
    parts += [knuckle, Cone(thumb_a, thumb_b, 0.0115, 0.0098), Cone(thumb_b, thumb_c, 0.0098, 0.0082)]
    return Union(parts, k=0.004)


def leg_core():
    thigh = Cone(THIGH.at(0.0, out=0.010), THIGH.at(1.0), 0.082, 0.050)
    quads = THIGH.muscle(0.42, (0.062, 0.052, 0.170), front=0.024, out=0.006)
    vastus = THIGH.muscle(0.78, (0.040, 0.038, 0.075), front=0.018, out=-0.026)
    lateral = THIGH.muscle(0.68, (0.040, 0.040, 0.110), front=0.010, out=0.024)
    outer = THIGH.muscle(0.35, (0.050, 0.050, 0.160), out=0.022)
    hamstring = THIGH.muscle(0.48, (0.056, 0.046, 0.160), front=-0.030)
    adductor = THIGH.muscle(0.22, (0.046, 0.052, 0.120), out=-0.034, front=0.004)
    knee = Ellipsoid(THIGH.at(1.0, front=0.006), (0.050, 0.046, 0.045), THIGH.axes)
    patella = Ellipsoid(THIGH.at(0.985, front=0.040), (0.022, 0.012, 0.026), THIGH.axes)
    shin = Cone(SHIN.at(0.0), SHIN.at(1.0), 0.047, 0.030)
    calf = SHIN.muscle(0.26, (0.050, 0.042, 0.115), front=-0.030, out=-0.004)
    calf_outer = SHIN.muscle(0.30, (0.040, 0.036, 0.100), front=-0.022, out=0.016)
    ankle = Ellipsoid(SHIN.at(1.0), (0.034, 0.030, 0.030), SHIN.axes)
    return Union([thigh, quads, vastus, lateral, outer, hamstring, adductor, knee, patella, shin, calf, calf_outer,
                  ankle],
                 k=0.025)


def boot():
    """A low boot with a sole, on the left foot."""
    heel = Ellipsoid((0.100, 0.022, 0.048), (0.034, 0.036, 0.046))
    upper = Cone((0.100, 0.003, 0.070), (0.100, 0.000, 0.120), 0.040, 0.037)
    instep = Cone((0.100, -0.012, 0.072), (0.105, -0.125, 0.040), 0.040, 0.034)
    outside = Ellipsoid((0.112, -0.060, 0.034), (0.040, 0.072, 0.032))
    forefoot = Ellipsoid((0.106, -0.130, 0.032), (0.048, 0.050, 0.030))
    toes = Ellipsoid((0.108, -0.172, 0.028), (0.041, 0.044, 0.024))
    shoe = Union([heel, upper, instep, outside, forefoot, toes], k=0.02)
    shoe = _above(shoe, 0.011)
    sole = Footprint(shoe, 0.018, 0.0, 0.012, grow=0.0035, round=0.003)
    return Union([shoe, sole], k=0.002)


# The kit ---------------------------------------------------------------------------

class Figure:
    """The clothed figure as one signed distance shape, and the parts that make it."""

    def __init__(self):
        trunk = trunk_core()
        arm = arm_core()
        leg = leg_core()
        hand = hand_core()
        self.head = head_core()
        self.trunk, self.arm = trunk, arm
        self.skin = Union([neck_core(), self.head], k=0.02)
        figure = Union([trunk, self.skin] + _both([arm, hand, leg]), k=0.02)
        # Shirt: a centimetre off the trunk, down to the hem, with short sleeves and a collar.
        sleeves = _both([_keep_before(arm, "sleeve", -0.009)])
        drape = Loft(DRAPE, power=2.4, cap=0.02)
        shirt = _above(Shell(Union([trunk_core(chest=False), drape] + sleeves, k=0.02), 0.009), SHIRT_HEM)
        point, normal = COLLAR
        neck = NECK
        band = Shell(neck, 0.0065)
        box = (band.lo - 0.1, band.hi + 0.1)
        collar = Within(Within(band, Plane(point, normal, *box)), Plane(point - normal * 0.022, -normal, *box))
        self.shirt = Union([shirt, collar], k=0.004)
        # Shorts: loose over the hips, flaring over the thighs to the hem.
        flare = _keep_before(Cone(THIGH.at(0.12, out=0.004), THIGH.at(0.60, out=0.004, front=-0.002), 0.090, 0.081),
                             "shorts", -0.004)
        seat = Loft(SHORTS, power=2.3, cap=0.025)
        self.shorts = Union([trunk, seat] + _both([_below(flare, SHIRT_HEM - 0.01)]), k=0.03)
        shorts = _below(Shell(self.shorts, 0.004), SHIRT_HEM + 0.03)
        # Socks over shin pads, with a turned-down cuff at the top; boots below.
        padded = Union([leg, SHIN.muscle(0.48, (0.034, 0.012, 0.100), front=0.036)], k=0.012)
        sock = Shell(_keep_after(padded, "sock", 0.003), 0.003)
        cuff = Shell(_keep_before(_keep_after(padded, "sock", 0.008), "sock", 0.032), 0.008)
        self.leg = leg
        shoe = _keep_after(boot(), "boot", 0.0)
        self.shape = Union([figure, self.shirt, shorts] + _both([sock, cuff, shoe]), k=0.003)


# Meshing ---------------------------------------------------------------------------

def _decimate(obj, budgets, tier_of):
    """Bring `obj` to sum(`budgets`) triangles, `budgets[k]` of them in tier k.

    `tier_of(points)` puts each vertex in a tier, 0 the coarsest. Tiers are
    collapsed coarse to fine, each with the others held still, so the face keeps
    the detail the trunk does not need.
    """
    def tiers():
        co = np.empty(len(obj.data.vertices) * 3)
        obj.data.vertices.foreach_get("co", co)
        return tier_of(co.reshape(-1, 3))

    for k in range(len(budgets)):
        tier = tiers()
        finer = 0
        for poly in obj.data.polygons:
            if min(tier[i] for i in poly.vertices) > k:
                finer += len(poly.vertices) - 2
        collapse(obj, sum(budgets[:k + 1]) + finer, tier == k)


def _tier(verts):
    """Decimation tiers: 0 the body, 1 the rest of the head and the hands, 2 the face and ears."""
    q = _side(verts)
    tier = np.zeros(len(verts), dtype=np.int64)
    hands = (np.linalg.norm(q - HAND.at(0.45), axis=1) < 0.11) & (q[:, 2] < J["wrist_L"][2] + 0.01)
    tier[(q[:, 2] > 1.585) | hands] = 1
    face = (q[:, 1] < -0.035) & (q[:, 2] > 1.555) & (q[:, 2] < 1.735)
    ears = np.linalg.norm((q - (0.079, 0.01, 1.665)) / (0.022, 0.032, 0.042), axis=1) < 1.0
    tier[face | ears] = 2
    return tier


# Regions ---------------------------------------------------------------------------

def _distance_to_segment(p, a, b):
    ab = b - a
    t = np.clip(((p - a) @ ab) / (ab @ ab), 0.0, 1.0)
    return np.linalg.norm(p - (a + t[:, None] * ab), axis=1)


def _side(p):
    """Each point's coordinates mirrored onto the left side."""
    q = p.copy()
    q[:, 0] = np.abs(q[:, 0])
    return q


def _beyond(q, edge, offset=0.0):
    point, axis = EDGES[edge]
    return (q - point - axis * offset) @ axis > 0


def classify(points, figure):
    """The kit region of each point on the body surface."""
    q = _side(points)
    region = np.full(len(points), "shirt", dtype=object)
    region[points[:, 2] < SHIRT_HEM] = "shorts"
    # Neck and head where the skin, not the shirt, makes the surface.
    upper = np.flatnonzero(points[:, 2] > 1.38)
    bare = figure.skin.at(points[upper]) < figure.shirt.at(points[upper]) - 0.0005
    bare &= (points[upper] - COLLAR[0]) @ COLLAR[1] > 0
    region[upper[bare]] = "skin"
    # Arms beyond the sleeve.
    arm_reach = np.minimum(_distance_to_segment(q, J["shoulder_L"], J["elbow_L"]),
                           _distance_to_segment(q, J["elbow_L"], J["hand_tip_L"]))
    on_arm = (arm_reach < 0.11) & _beyond(q, "sleeve")
    region[on_arm] = "sleeve"
    region[on_arm & _beyond(q, "wrist")] = "hands"
    # Legs below the shorts.
    leg_reach = np.minimum(_distance_to_segment(q, J["hip_L"], J["knee_L"]),
                           _distance_to_segment(q, J["knee_L"], J["ankle_L"]))
    foot = q[:, 2] < 0.16
    on_leg = ((leg_reach < 0.14) | foot) & (_beyond(q, "shorts") | foot) & ~on_arm
    region[on_leg] = "legs"
    region[on_leg & _beyond(q, "sock")] = "socks"
    region[on_leg & (_beyond(q, "boot") | (q[:, 2] < 0.075))] = "boots"
    return region


def _cut_edges(bm):
    """Cut the mesh along the kit's edges so each region ends on a clean loop."""
    def cut(point, normal, keep):
        geom = [f for f in bm.faces if keep(np.array(f.calc_center_median()))]
        chosen = set(geom)
        # Lists in mesh order, not sets: a set's order changes from run to run.
        verts = [v for v in bm.verts if any(f in chosen for f in v.link_faces)]
        edges = [e for e in bm.edges if any(f in chosen for f in e.link_faces)]
        bmesh.ops.bisect_plane(bm, geom=verts + edges + geom, dist=1e-5,
                               plane_co=Vector(point), plane_no=Vector(normal))

    for sign in (1, -1):
        def mirrored(v):
            return np.array([v[0] * sign, v[1], v[2]])

        for edge, reach, segs in (
            ("sleeve", 0.11, (("shoulder_L", "elbow_L"),)),
            ("wrist", 0.07, (("elbow_L", "wrist_L"), ("wrist_L", "hand_tip_L"))),
            ("shorts", 0.15, (("hip_L", "knee_L"),)),
            ("sock", 0.10, (("knee_L", "ankle_L"),)),
            ("boot", 0.10, (("knee_L", "ankle_L"),)),
        ):
            point, axis = EDGES[edge]
            a_list = [(mirrored(J[a]), mirrored(J[b])) for a, b in segs]

            def keep(c, a_list=a_list, reach=reach):
                if c[0] * sign < 0:
                    return False
                return min(_distance_to_segment(c[None, :], a, b)[0] for a, b in a_list) < reach

            cut(mirrored(point), mirrored(axis), keep)
    cut((0, 0, SHIRT_HEM), (0, 0, 1), lambda c: abs(c[0]) < 0.24 and c[2] > SHIRT_HEM - 0.1)
    neck_a, neck_b = J["neck_base"] - (0, 0, 0.1), J["head_base"]
    cut(COLLAR[0], COLLAR[1], lambda c: _distance_to_segment(c[None, :], neck_a, neck_b)[0] < 0.075)


def _assign(obj, names, per_face):
    for name in names:
        obj.data.materials.append(material(name))
    index = {name: i for i, name in enumerate(names)}
    obj.data.polygons.foreach_set("material_index", [index[r] for r in per_face])


# Eyes ------------------------------------------------------------------------------

def build_eyes(collection):
    """Two eyeballs, white with a brown iris and a dark pupil, looking ahead.

    Only the front of each eyeball is modelled (rings out from the pupil to a
    little past the side); the back is inside the head. They are their own mesh
    so that only they carry vertex colours.
    """
    segments, rings, reach = 12, 6, math.radians(105)
    verts, faces, colours = [], [], []
    for sign in (1, -1):
        centre = np.array([EYE[0] * sign, EYE[1], EYE[2]])
        first = len(verts)
        verts.append(centre + (0.0, -EYE_RADIUS, 0.0))
        for r in range(1, rings + 1):
            polar = reach * r / rings
            for k in range(segments):
                around = 2 * math.pi * k / segments
                d = np.array([math.sin(polar) * math.cos(around), -math.cos(polar), math.sin(polar) * math.sin(around)])
                verts.append(centre + d * EYE_RADIUS)

        def ring(r, k):
            return first + 1 + (r - 1) * segments + k % segments

        # Wound out from the pupil and then around, so the faces look outwards.
        for k in range(segments):
            faces.append((first, ring(1, k), ring(1, k + 1)))
        for r in range(1, rings):
            for k in range(segments):
                faces.append((ring(r, k), ring(r + 1, k), ring(r + 1, k + 1), ring(r, k + 1)))
    mesh = bpy.data.meshes.new("eyes")
    mesh.from_pydata([tuple(v) for v in verts], [], faces)
    layer = mesh.color_attributes.new("eye_colour", "BYTE_COLOR", "CORNER")
    for poly in mesh.polygons:
        side = 1 if mesh.vertices[poly.vertices[0]].co.x > 0 else -1
        centre = Vector((EYE[0] * side, EYE[1], EYE[2]))
        for loop in poly.loop_indices:
            d = (mesh.vertices[mesh.loops[loop].vertex_index].co - centre).normalized()
            if d.z > 0.45:
                colour = (0.05, 0.035, 0.03, 1.0)  # the lash line under the upper lid
            elif -d.y > 0.93:
                colour = (0.02, 0.015, 0.012, 1.0)
            elif -d.y > 0.80:
                colour = (0.16, 0.09, 0.05, 1.0)
            else:
                colour = (0.80, 0.78, 0.74, 1.0)
            layer.data[loop].color = colour
        poly.use_smooth = True
    obj = bpy.data.objects.new("eyes", mesh)
    collection.objects.link(obj)
    obj.data.materials.append(material("eyes"))
    return obj


# Building --------------------------------------------------------------------------

def _shape_mesh(shape, step, name, collection, passes=2, lo=None, hi=None):
    verts, quads = S.mesh_field(shape, step, lo, hi)
    if passes:
        verts = smooth(verts, quads, passes)
    return mesh_object(name, verts, quads, collection), verts


# Shirt number ----------------------------------------------------------------------

NUMBER_SIZE = (0.25, 0.27)  # m: width and height of the panel the number is printed in
NUMBER_CENTRE_Z = 1.235


def build_number(body, collection):
    """A panel lying on the back of the shirt, with UVs as read from behind.

    u runs 0 to 1 from the viewer's left (the figure's left, +x) to right; v runs
    0 to 1 from bottom to top in Blender, which glTF stores as 1 to 0, so the
    page's canvas maps upright with flipY off.
    """
    bvh = BVHTree.FromObject(body, bpy.context.evaluated_depsgraph_get())
    cols, rows = 8, 8
    width, height = NUMBER_SIZE
    verts, uvs = [], []
    for j in range(rows + 1):
        for i in range(cols + 1):
            u, v = i / cols, j / rows
            x = width / 2 - u * width
            z = NUMBER_CENTRE_Z - height / 2 + v * height
            hit, normal, _, _ = bvh.ray_cast(Vector((x, 0.5, z)), Vector((0.0, -1.0, 0.0)))
            verts.append(hit + normal * 0.004)
            uvs.append((u, v))
    faces = [(j * (cols + 1) + i, j * (cols + 1) + i + 1, (j + 1) * (cols + 1) + i + 1, (j + 1) * (cols + 1) + i)
             for j in range(rows) for i in range(cols)]
    # Wound to face backwards (+y), the way the panel is seen.
    faces = [f[::-1] for f in faces]
    obj = mesh_object("number", np.array(verts), np.array(faces), collection)
    layer = obj.data.uv_layers.new(name="UVMap")
    for poly in obj.data.polygons:
        for loop in poly.loop_indices:
            layer.data[loop].uv = uvs[obj.data.loops[loop].vertex_index]
        poly.use_smooth = True
    obj.data.materials.append(material("number"))
    return obj


# Coat ------------------------------------------------------------------------------

# A manager's coat is a zip-up track jacket to the hips over track trousers, one
# mesh with the material `coat`. The jacket's sections, as for the trunk:
JACKET = [
    (0.88, 0.172, 0.112, 0.118, 0.020),
    (0.96, 0.170, 0.114, 0.114, 0.020),
    (1.04, 0.165, 0.118, 0.106, 0.020),
    (1.12, 0.168, 0.126, 0.106, 0.022),
    (1.24, 0.178, 0.134, 0.112, 0.024),
    (1.34, 0.180, 0.130, 0.114, 0.027),
    (1.42, 0.165, 0.104, 0.100, 0.030),
    (1.48, 0.124, 0.066, 0.076, 0.032),
    (1.52, 0.075, 0.047, 0.057, 0.032),
]
JACKET_HEM = 0.90
COAT_TRIANGLES = 3800


def build_coat(figure, collection):
    """A track jacket with a stand collar, a zip, a waistband and cuffs, over trousers."""
    arm = figure.arm
    sleeves = _both([_keep_before(arm, "wrist", -0.03)])
    core = Union([Loft(JACKET, power=2.4, cap=0.02), figure.trunk, figure.shorts, Loft(DRAPE, power=2.4)]
                 + _both(shoulders()) + sleeves, k=0.03)
    jacket = _above(Shell(core, 0.020), JACKET_HEM)
    waistband = Within(_above(Shell(core, 0.024), JACKET_HEM), Plane((0, 0, JACKET_HEM + 0.035), (0, 0, 1),
                                                                      core.lo - 0.1, core.hi + 0.1))
    cuffs = _both([Shell(_keep_after(_keep_before(arm, "wrist", -0.03), "wrist", -0.065), 0.024)])
    point, normal = COLLAR
    band = Shell(NECK, 0.016)
    box = (band.lo - 0.1, band.hi + 0.1)
    collar = Within(Within(band, Plane(point + normal * 0.05, normal, *box)), Plane(point - normal * 0.015, -normal, *box))
    # Hollow below the chest, so the hem and the cuffs are open like cloth.
    top = Cut(Union([jacket, waistband, collar] + cuffs, k=0.004), _below(Shell(core, 0.011), 1.30))
    # The zip: a shallow groove down the middle of the front, through the collar.
    slab = Box((0.0, -0.25, 1.25), (0.0025, 0.13, 0.40))
    top = Cut(top, Cut(slab, Shell(core, 0.015)), k=0.002)
    # Straight legs, just wide enough over the shorts' hem and the socks' cuffs.
    leg = Union([Cone(THIGH.at(0.0, out=0.008), THIGH.at(1.0), 0.094, 0.068),
                 Cone(THIGH.at(0.10, out=0.006), THIGH.at(0.62, out=0.004, front=-0.002), 0.101, 0.098),
                 Cone(SHIN.at(0.0), SHIN.at(1.0), 0.072, 0.058), Shell(figure.leg, 0.014)], k=0.03)
    seat = _below(Shell(figure.shorts, 0.013), 0.99)
    trousers = Union([seat] + _both([_keep_before(leg, "boot", -0.012)]), k=0.03)
    coat = Union([top, trousers], k=0.006)
    figure.jacket_core, figure.trousers = core, trousers
    verts, quads = S.mesh_field(coat, STEP)
    # Open the collar where it closes over the neck.
    verts, quads = keep_vertices(verts, quads, NECK.at(verts) > 0.004)
    obj = mesh_object("coat", smooth(verts, quads, 1), quads, collection)
    collapse(obj, COAT_TRIANGLES)
    # The jacket and the trousers are separate materials, so the page can colour them apart,
    # split along a clean cut just under the jacket's hem.
    bm = bmesh.new()
    bm.from_mesh(obj.data)
    near = [f for f in bm.faces if abs(f.calc_center_median().z - JACKET_HEM) < 0.03]
    chosen = set(near)
    bmesh.ops.bisect_plane(bm, geom=[v for v in bm.verts if any(f in chosen for f in v.link_faces)]
                           + [e for e in bm.edges if any(f in chosen for f in e.link_faces)] + near,
                           dist=1e-5, plane_co=Vector((0.0, 0.0, JACKET_HEM - 0.003)), plane_no=Vector((0.0, 0.0, 1.0)))
    bmesh.ops.triangulate(bm, faces=bm.faces[:])
    bm.to_mesh(obj.data)
    bm.free()
    centres = np.array([p.center for p in obj.data.polygons])
    legs = centres[:, 2] < JACKET_HEM - 0.003  # the jacket ends at its hem; below it are the trousers
    _assign(obj, ["coat", "trousers"], np.where(legs, "trousers", "coat"))
    for poly in obj.data.polygons:
        poly.use_smooth = True
    return obj


# Skinning and variations -----------------------------------------------------------

def _weights(obj):
    """{bone: per-vertex weight} of a skinned mesh."""
    names = [g.name for g in obj.vertex_groups]
    out = {name: np.zeros(len(obj.data.vertices)) for name in names}
    for v in obj.data.vertices:
        for g in v.groups:
            out[names[g.group]][v.index] = g.weight
    return out


def _transfer(obj, source, armature):
    """Skin `obj` like the nearest point of `source`'s surface."""
    from mathutils.interpolate import poly_3d_calc

    weights = _weights(source)
    bvh = BVHTree.FromObject(source, bpy.context.evaluated_depsgraph_get())
    out = {bone: np.zeros(len(obj.data.vertices)) for bone in weights}
    polys = source.data.polygons
    co = source.data.vertices
    for v in obj.data.vertices:
        hit, _, index, _ = bvh.find_nearest(v.co)
        ids = list(polys[index].vertices)
        share = poly_3d_calc([co[i].co for i in ids], hit)
        for bone, values in weights.items():
            out[bone][v.index] = sum(w * values[i] for w, i in zip(share, ids))
    _bind(obj, armature, {b: w for b, w in out.items() if w.max() > 1e-4})
    _limit_weights(obj)


def _points(obj):
    co = np.empty(len(obj.data.vertices) * 3)
    obj.data.vertices.foreach_get("co", co)
    return co.reshape(-1, 3)


def _segment_offset(points, bone):
    head, tail = (J[j] for j in rig.BONES[bone][:2])
    ab = tail - head
    t = np.clip(((points - head) @ ab) / (ab @ ab), 0.0, 1.0)
    return points - (head + t[:, None] * ab)


BUILD = {"hips": 0.06, "spine": 0.08, "chest": 0.10, "neck": 0.10, "shoulder": 0.12, "upper_arm": 0.11,
         "forearm": 0.08, "hand": 0.02, "thigh": 0.08, "shin": 0.06}


def _build(points, weights, gain):
    out = np.zeros_like(points)
    for bone, w in weights.items():
        g = BUILD.get(bone.rstrip("_LR").rstrip("_"), 0.0)
        if g:
            out += (w * g * gain)[:, None] * _segment_offset(points, bone)
    return out


def _clamp(v, lo=0.0, hi=1.0):
    return np.clip(v, lo, hi)


def morph_offsets(name, points, weights):
    """How far each point moves at a shape key's full value. Bones never move."""
    head = weights.get("head", np.zeros(len(points)))
    X, Y, Z = points.T
    out = np.zeros_like(points)
    if name == "build_slim":
        return _build(points, weights, -0.8)
    if name == "build_broad":
        return _build(points, weights, 1.0)
    if name == "face_wide":
        out[:, 0] = X * 0.09 * head * _clamp(1.0 - (Z - 1.72) / 0.10, 0.4, 1.0)
    elif name == "face_long":
        out[:, 2] = -0.085 * np.maximum(0.0, 1.69 - Z) * head
    elif name == "jaw_strong":
        g = _clamp(1.0 - np.abs(Z - 1.597) / 0.04) * (Y < 0.03) * head
        out[:, 0] = X * 0.16 * g
        out[:, 1] = -0.005 * g * _clamp((-Y - 0.03) / 0.04)
    elif name == "nose_big":
        centre = np.array([0.0, -0.098, 1.648])
        f = _clamp(1.0 - np.linalg.norm(points - centre, axis=1) / 0.032) ** 1.5 * (Y < -0.08) * head
        out = (points - np.array([0.0, -0.084, 1.655])) * (0.35 * f)[:, None]
    return out


def _add_morphs(obj):
    """Add every shape key that moves this mesh; returns their names."""
    points = _points(obj)
    weights = _weights(obj)
    added = []
    for name in MORPHS:
        offset = morph_offsets(name, points, weights)
        if np.abs(offset).max() < 1e-5:
            continue
        if obj.data.shape_keys is None:
            obj.shape_key_add(name="Basis", from_mix=False)
        key = obj.shape_key_add(name=name, from_mix=False)
        key.data.foreach_set("co", (points + offset).ravel())
        added.append(name)
    return added


def build_body(armature):
    collection = armature.users_collection[0]
    figure = Figure()
    body, verts = _shape_mesh(figure.shape, STEP, "body", collection)
    _decimate(body, BODY_TRIANGLES, _tier)

    bm = bmesh.new()
    bm.from_mesh(body.data)
    # Decimation is not symmetric; mirror the figure's left half over its right.
    bmesh.ops.symmetrize(bm, input=bm.verts[:] + bm.edges[:] + bm.faces[:], direction="-X", dist=1e-5)
    bmesh.ops.triangulate(bm, faces=bm.faces[:])
    _cut_edges(bm)
    bmesh.ops.triangulate(bm, faces=bm.faces[:])
    centres = np.array([f.calc_center_median() for f in bm.faces])
    regions = classify(centres, figure)
    bm.to_mesh(body.data)
    bm.free()
    body.data.validate(clean_customdata=False)
    _assign(body, list(REGIONS), regions)
    for poly in body.data.polygons:
        poly.use_smooth = True
    _skin(body, armature)

    eyes = build_eyes(collection)
    _bind(eyes, armature, {"head": np.ones(len(eyes.data.vertices))})
    number = build_number(body, collection)
    _transfer(number, body, armature)
    coat = build_coat(figure, collection)
    _transfer(coat, body, armature)
    hair = hair_styles.build_hair(figure.head, collection)
    for obj in hair:
        _bind(obj, armature, {"head": np.ones(len(obj.data.vertices))})
    parts = [body, eyes, number, coat] + hair
    morphs = {}
    for obj in parts:
        for name in _add_morphs(obj):
            morphs.setdefault(name, []).append(obj.name)
    # In the .blend, show the figure as a player with one hair style.
    coat.hide_set(True)
    for obj in hair:
        obj.hide_set(obj.name != "hair_short")
    return {
        "body": body.name,
        "eyes": eyes.name,
        "coat": coat.name,
        "number": number.name,
        "hair": [obj.name for obj in hair],
        "materials": {"regions": list(REGIONS), "fixed": list(FIXED), "coat": ["coat", "trousers"]},
        "morphs": {name: morphs[name] for name in MORPHS if name in morphs},
        "triangles": {p.name: sum(len(f.vertices) - 2 for f in p.data.polygons) for p in parts},
    }


def _bind(obj, armature, weights):
    """Parent `obj` to the armature and skin it with `weights`: {bone: per-vertex weight}."""
    obj.parent = armature
    for bone, values in weights.items():
        group = obj.vertex_groups.new(name=bone)
        for i, w in enumerate(values):
            if w > 1e-4:
                group.add([i], float(w), "REPLACE")
    mod = obj.modifiers.new("rig", "ARMATURE")
    mod.object = armature


def _skin(obj, armature):
    obj.parent = armature
    view_layer = bpy.context.view_layer
    for o in view_layer.objects:
        o.select_set(False)
    obj.select_set(True)
    armature.select_set(True)
    view_layer.objects.active = armature
    bpy.ops.object.parent_set(type="ARMATURE_AUTO")
    obj.select_set(False)
    _smooth_joints(obj)
    _limit_weights(obj)


# Joints whose weights are blended wider than bone heat leaves them: (joint, reach in m).
SOFT_JOINTS = (("shoulder_L", 0.11), ("shoulder_R", 0.11), ("hip_L", 0.13), ("hip_R", 0.13),
               ("knee_L", 0.08), ("knee_R", 0.08), ("elbow_L", 0.07), ("elbow_R", 0.07))


def _smooth_joints(obj, iterations=8, factor=0.5):
    """Spread each vertex's weights towards its neighbours' near the big joints, so the
    skin bends over a wider band and keeps its volume better."""
    weights = _weights(obj)
    names = list(weights)
    w = np.stack([weights[n] for n in names], axis=1)
    points = _points(obj)
    near = np.zeros(len(points))
    for joint, reach in SOFT_JOINTS:
        d = np.linalg.norm(points - J[joint], axis=1)
        near = np.maximum(near, np.clip(1.0 - d / reach, 0.0, 1.0))
    edges = np.array([e.vertices for e in obj.data.edges])
    count = np.maximum(np.bincount(edges.ravel(), minlength=len(points)), 1)[:, None]
    for _ in range(iterations):
        acc = np.zeros_like(w)
        np.add.at(acc, edges[:, 0], w[edges[:, 1]])
        np.add.at(acc, edges[:, 1], w[edges[:, 0]])
        w = w + (factor * near)[:, None] * (acc / count - w)
    groups = obj.vertex_groups
    for j, name in enumerate(names):
        group = groups[name]
        for i in np.flatnonzero(near > 0):
            if w[i, j] > 1e-4:
                group.add([int(i)], float(w[i, j]), "REPLACE")
            else:
                group.remove([int(i)])


def _limit_weights(obj, most=4):
    """Keep each vertex's `most` strongest bones, normalised: what glTF and the page use."""
    groups = obj.vertex_groups
    for v in obj.data.vertices:
        pairs = sorted(((g.weight, g.group) for g in v.groups if g.weight > 1e-4), reverse=True)
        kept = pairs[:most]
        total = sum(w for w, _ in kept) or 1.0
        for index in [g.group for g in v.groups]:
            groups[index].remove([v.index])
        for w, index in kept:
            groups[index].add([v.index], min(1.0, w / total), "REPLACE")
