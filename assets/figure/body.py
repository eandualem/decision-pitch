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

import rig
import shapes as S
from shapes import Box, Cone, Cut, Ellipsoid, Footprint, Layer, Loft, Plane, Shell, Union, Within, frame, mirror

STEP = 0.0025  # m: the grid the body is sampled on
HAIR_STEP = 0.002  # m: the grid the hair is sampled on
# The body's triangles (eyes excluded; a figure adds one hair mesh): the trunk and
# limbs, the rest of the head with the hands, and the face with the ears.
BODY_TRIANGLES = (4700, 1500, 2000)

J = {name: np.array(p, dtype=np.float64) for name, p in rig.JOINTS.items()}

REGIONS = ("skin", "shirt", "sleeve", "hands", "shorts", "legs", "socks", "boots")
FIXED = ("eyes",)
HAIR_STYLES = ("hair_bald", "hair_buzz", "hair_short", "hair_curly", "hair_swept", "hair_bun")
MORPHS = ("build_slim", "build_broad", "face_wide", "face_long", "jaw_strong", "nose_big")

# Default colours in the .blend; the page sets its own per team and per figure.
COLOURS = {
    "skin": (0.56, 0.38, 0.28),
    "shirt": (0.80, 0.80, 0.82),
    "sleeve": (0.56, 0.38, 0.28),
    "hands": (0.56, 0.38, 0.28),
    "shorts": (0.06, 0.08, 0.16),
    "legs": (0.56, 0.38, 0.28),
    "socks": (0.80, 0.80, 0.82),
    "boots": (0.03, 0.03, 0.03),
    "hair": (0.05, 0.035, 0.025),
    "number": (0.05, 0.05, 0.08),
    "coat": (0.10, 0.11, 0.13),
}


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
SHIRT_HEM = 0.905  # m: height of the shirt's hem over the shorts
# The top of the collar: a plane through the neck, lower at the front.
COLLAR = (np.array([0.0, 0.03, 1.490]), np.array([0.0, -0.30, 1.0]) / math.hypot(0.30, 1.0))
NECK = Cone((0.0, 0.030, 1.42), (0.0, 0.018, 1.625), 0.066, 0.056)


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


def _both(shapes):
    """Left-side shapes and their mirror images."""
    return list(shapes) + [mirror(s) for s in shapes]


# The trunk -------------------------------------------------------------------------

# Sections of the trunk: z, half width, half depth to the front, to the back, centre y.
TRUNK = [
    (0.80, 0.135, 0.080, 0.090, 0.020),
    (0.86, 0.160, 0.092, 0.105, 0.022),
    (0.92, 0.166, 0.096, 0.106, 0.020),
    (0.98, 0.156, 0.096, 0.094, 0.018),
    (1.04, 0.146, 0.098, 0.088, 0.020),
    (1.10, 0.150, 0.102, 0.088, 0.020),
    (1.17, 0.158, 0.108, 0.094, 0.022),
    (1.24, 0.168, 0.112, 0.100, 0.024),
    (1.31, 0.174, 0.112, 0.104, 0.026),
    (1.37, 0.174, 0.104, 0.102, 0.028),
    (1.42, 0.160, 0.086, 0.090, 0.030),
    (1.47, 0.122, 0.060, 0.070, 0.032),
    (1.51, 0.075, 0.045, 0.055, 0.032),
]


def shoulders():
    """The shoulder girdle, left side: shoulder blade, trapezius and deltoid."""
    blade = Ellipsoid((0.085, 0.085, 1.34), (0.062, 0.030, 0.075))
    trapezius = Cone((0.035, 0.040, 1.488), (0.175, 0.035, 1.468), 0.040, 0.036)
    neck_slope = Cone((0.0, 0.045, 1.53), (0.10, 0.04, 1.478), 0.035, 0.030)
    deltoid = Ellipsoid(UPPER_ARM.at(0.10, out=0.016, front=0.002), (0.056, 0.062, 0.088), UPPER_ARM.axes)
    deltoid_front = Ellipsoid(UPPER_ARM.at(0.14, out=0.004, front=0.026), (0.038, 0.036, 0.068), UPPER_ARM.axes)
    return [blade, trapezius, neck_slope, deltoid, deltoid_front]


def trunk_core(chest=True):
    """The trunk with its muscles; without `chest` for the shirt, which hides the pectorals."""
    trunk = Loft(TRUNK, power=2.4, cap=0.03)
    pecs = Ellipsoid((0.070, -0.058, 1.335), (0.086, 0.030, 0.064), S.rotation(rz=-0.12))
    lats = Ellipsoid((0.125, 0.040, 1.26), (0.050, 0.064, 0.125), S.rotation(ry=0.22))
    glute = Ellipsoid((0.072, 0.075, 0.875), (0.078, 0.060, 0.090))
    return Union([trunk] + _both(([pecs] if chest else []) + [lats, glute] + shoulders()), k=0.035)


# How the shorts hang from the waist to the crotch: sections as for the trunk.
SHORTS = [
    (0.745, 0.148, 0.084, 0.094, 0.020),
    (0.80, 0.161, 0.094, 0.104, 0.020),
    (0.88, 0.167, 0.098, 0.109, 0.020),
    (0.94, 0.160, 0.098, 0.098, 0.020),
]

# How the shirt hangs from the chest over the waist: sections as for the trunk.
DRAPE = [
    (0.86, 0.166, 0.100, 0.104, 0.020),
    (0.90, 0.166, 0.100, 0.104, 0.020),
    (1.00, 0.163, 0.104, 0.098, 0.020),
    (1.10, 0.164, 0.110, 0.096, 0.021),
    (1.20, 0.170, 0.116, 0.099, 0.023),
    (1.28, 0.172, 0.118, 0.101, 0.025),
    (1.34, 0.172, 0.112, 0.102, 0.027),
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
    jaw_line = Cone((0.055, 0.014, 1.614), (0.018, -0.075, 1.571), 0.012, 0.012)
    cheek = Ellipsoid((0.052, -0.060, 1.660), (0.024, 0.022, 0.016))
    brow = Cone((0.010, -0.0900, 1.700), (0.050, -0.0770, 1.704), 0.0105, 0.0060)
    buccal = Ellipsoid((0.046, -0.052, 1.625), (0.024, 0.028, 0.028))
    head = Union([CRANIUM, face, jaw, chin, muzzle] + _both([jaw_line, cheek, brow, buccal]), k=0.022)
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
        shorts = _below(Shell(Union([trunk, seat] + _both([_below(flare, SHIRT_HEM - 0.01)]), k=0.03), 0.004),
                        SHIRT_HEM + 0.03)
        # Socks over shin pads, with a turned-down cuff at the top; boots below.
        padded = Union([leg, SHIN.muscle(0.48, (0.034, 0.012, 0.100), front=0.036)], k=0.012)
        sock = Shell(_keep_after(padded, "sock", 0.003), 0.003)
        cuff = Shell(_keep_before(_keep_after(padded, "sock", 0.008), "sock", 0.032), 0.008)
        shoe = _keep_after(boot(), "boot", 0.0)
        self.shape = Union([figure, self.shirt, shorts] + _both([sock, cuff, shoe]), k=0.003)


# Meshing ---------------------------------------------------------------------------

def _keep_vertices(verts, quads, keep):
    """The mesh made of the faces whose vertices all pass `keep`, without loose vertices."""
    quads = quads[np.all(keep[quads], axis=1)]
    used = np.zeros(len(verts), dtype=bool)
    used[quads.ravel()] = True
    index = np.full(len(verts), -1)
    index[used] = np.arange(used.sum())
    return verts[used], index[quads]


def _mesh_object(name, verts, faces, collection):
    mesh = bpy.data.meshes.new(name)
    mesh.from_pydata([tuple(v) for v in verts], [], [tuple(int(i) for i in f) for f in faces])
    mesh.validate(clean_customdata=False)
    obj = bpy.data.objects.new(name, mesh)
    collection.objects.link(obj)
    return obj


def _collapse(obj, triangles, movable=None):
    """Collapse `obj` towards `triangles`; only vertices where `movable` is true may move."""
    current = sum(len(p.vertices) - 2 for p in obj.data.polygons)
    if current <= triangles:
        return
    mod = obj.modifiers.new("decimate", "DECIMATE")
    mod.decimate_type = "COLLAPSE"
    # Symmetric collapse folds triangles over along the centre line; plain collapse does not.
    mod.use_symmetry = False
    mod.use_collapse_triangulate = True
    if movable is not None:
        # Blender's decimation never collapses a vertex of weight 0 in its group.
        group = obj.vertex_groups.new(name="movable")
        group.add(np.flatnonzero(movable).tolist(), 1.0, "REPLACE")
        mod.vertex_group = group.name
    mod.ratio = triangles / current
    bpy.context.view_layer.update()
    evaluated = obj.evaluated_get(bpy.context.evaluated_depsgraph_get())
    mesh = bpy.data.meshes.new_from_object(evaluated)
    old = obj.data
    obj.modifiers.remove(mod)
    obj.data = mesh
    bpy.data.meshes.remove(old)
    if movable is not None:
        obj.vertex_groups.remove(obj.vertex_groups["movable"])
    mesh.name = obj.name


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
        _collapse(obj, sum(budgets[:k + 1]) + finer, tier == k)


def _smooth(verts, faces, iterations=2, factor=0.5):
    """Laplacian smoothing that keeps the volume (alternating shrink and inflate)."""
    n = len(verts)
    edges = np.concatenate([faces[:, [i, (i + 1) % 4]] for i in range(4)])
    edges = np.unique(np.sort(edges, axis=1), axis=0)
    deg = np.maximum(np.bincount(edges.ravel(), minlength=n), 1).astype(np.float64)
    v = verts.copy()
    for _ in range(iterations):
        for f in (factor, -factor * 1.04):
            acc = np.zeros_like(v)
            np.add.at(acc, edges[:, 0], v[edges[:, 1]])
            np.add.at(acc, edges[:, 1], v[edges[:, 0]])
            v = v + f * (acc / deg[:, None] - v)
    return v


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
        verts = {v for f in geom for v in f.verts}
        edges = {e for f in geom for e in f.edges}
        bmesh.ops.bisect_plane(bm, geom=list(verts) + list(edges) + geom, dist=1e-5,
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


# Materials -------------------------------------------------------------------------

def material(name):
    mat = bpy.data.materials.get(name)
    if mat is not None:
        return mat
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes.get("Principled BSDF")
    colour = COLOURS.get(name, (0.8, 0.8, 0.8))
    bsdf.inputs["Base Color"].default_value = (*colour, 1.0)
    bsdf.inputs["Roughness"].default_value = {"boots": 0.4, "eyes": 0.55}.get(name, 0.75)
    mat.diffuse_color = (*colour, 1.0)
    if name == "eyes":
        attr = mat.node_tree.nodes.new("ShaderNodeVertexColor")
        attr.layer_name = "eye_colour"
        mat.node_tree.links.new(attr.outputs["Color"], bsdf.inputs["Base Color"])
    if name in ("coat", "number"):
        mat.use_backface_culling = False
    if name == "number":
        mat.blend_method = "HASHED" if hasattr(mat, "blend_method") else None
    return mat


def _assign(obj, names, per_face):
    for name in names:
        obj.data.materials.append(material(name))
    index = {name: i for i, name in enumerate(names)}
    obj.data.polygons.foreach_set("material_index", [index[r] for r in per_face])


# Eyes ------------------------------------------------------------------------------

def build_eyes(collection):
    """Two eyeballs, white with a brown iris and a dark pupil, looking ahead.

    Only the front of each eyeball is modelled; the back is inside the head. They
    are their own mesh so that only they carry vertex colours.
    """
    bm = bmesh.new()
    colour = bm.loops.layers.color.new("eye_colour")
    for sign in (1, -1):
        centre = Vector((EYE[0] * sign, EYE[1], EYE[2]))
        made = bmesh.ops.create_uvsphere(bm, u_segments=12, v_segments=8, radius=EYE_RADIUS)
        for v in made["verts"]:
            # Turn the sphere's pole to face the front (-y).
            v.co = Vector((v.co.x, -v.co.z, v.co.y)) + centre
        faces = {f for v in made["verts"] for f in v.link_faces}
        back = [f for f in faces if (f.calc_center_median() - centre).y > 0.004]
        bmesh.ops.delete(bm, geom=back, context="FACES")
    for f in bm.faces:
        centre = Vector((EYE[0] * (1 if f.calc_center_median().x > 0 else -1), EYE[1], EYE[2]))
        for loop in f.loops:
            d = (loop.vert.co - centre).normalized()
            ahead = -d.y
            if d.z > 0.45:
                loop[colour] = (0.05, 0.035, 0.03, 1.0)  # the lash line under the upper lid
            elif ahead > 0.93:
                loop[colour] = (0.02, 0.015, 0.012, 1.0)
            elif ahead > 0.80:
                loop[colour] = (0.16, 0.09, 0.05, 1.0)
            else:
                loop[colour] = (0.80, 0.78, 0.74, 1.0)
    mesh = bpy.data.meshes.new("eyes")
    bm.to_mesh(mesh)
    bm.free()
    obj = bpy.data.objects.new("eyes", mesh)
    collection.objects.link(obj)
    obj.data.materials.append(material("eyes"))
    for poly in mesh.polygons:
        poly.use_smooth = True
    return obj


# Building --------------------------------------------------------------------------

def _shape_mesh(shape, step, name, collection, smooth=2, lo=None, hi=None):
    verts, quads = S.mesh_field(shape, step, lo, hi)
    if smooth:
        verts = _smooth(verts, quads, smooth)
    return _mesh_object(name, verts, quads, collection), verts


# Hair ------------------------------------------------------------------------------

class Hairline(S.Shape):
    """Above the hairline: 1.733 m at the middle of the forehead, rising towards the
    temples, then down the sides to 1.595 m at the nape (inside is negative)."""

    lo = np.array([-0.15, -0.16, 1.50])
    hi = np.array([0.15, 0.17, 1.86])

    def field(self, X, Y, Z):
        temples = 7.0 * X * X * np.clip((0.02 - Y) / 0.08, 0.0, 1.0)
        line = 1.733 - 0.70 * (Y + 0.09) + temples
        return (line - Z) * 0.82


def _hair_region():
    """Where hair grows: above the hairline, around the ears, with sideburns."""
    top = Hairline()
    sideburn = Cone((0.076, -0.004, 1.705), (0.074, -0.010, 1.658), 0.0075)
    region = Union([top] + _both([sideburn]), k=0.01)
    ear = Ellipsoid((0.080, 0.012, 1.664), (0.030, 0.034, 0.040))
    return Cut(region, Union(_both([ear])), k=0.008)


def _brows(head):
    """Two brows, a few millimetres proud of the skin above the eyes."""
    inner = Ellipsoid((0.021, -0.093, 1.7005), (0.013, 0.02, 0.0044), S.rotation(ry=0.10))
    outer = Ellipsoid((0.043, -0.085, 1.7035), (0.015, 0.02, 0.0034), S.rotation(ry=-0.10))
    return Within(Shell(head, 0.0024), Union(_both([inner, outer]), k=0.004))


def _hair_styles(head):
    """Each style as a shape: a layer over the scalp, thicker where the style has volume."""
    region = _hair_region()

    def layer(thickness):
        return Layer(head, region, thickness, edge=0.03, edge_min=0.0022)

    def ramp(v, lo, hi):
        return np.clip((v - lo) / (hi - lo), 0.0, 1.0)

    def strands(X, Y, Z, depth):
        """Clumps combed front to back: ridges across the head that wander a little."""
        return depth * np.sin(X * 330.0 + 2.0 * np.sin(Y * 45.0)) * ramp(Z, 1.70, 1.74)

    rng = np.random.default_rng(51)
    curls = []
    for _ in range(170):
        # Points over the scalp, pushed out to the curls' layer.
        theta = rng.uniform(0, 2 * np.pi)
        phi = rng.uniform(0.0, 1.35)
        d = np.array([np.sin(phi) * np.cos(theta), np.sin(phi) * np.sin(theta), np.cos(phi)])
        centre = np.array([0.0, 0.012, 1.705]) + d * np.array([0.098, 0.115, 0.112])
        curls.append(Ellipsoid(centre, (rng.uniform(0.012, 0.017),) * 3))
    curly = Within(Union([Layer(head, region, lambda X, Y, Z: 0.020 + 0 * X, edge=0.03, edge_min=0.003)] + curls,
                         k=0.006), Shell(region, -0.004))
    bun = Ellipsoid((0.0, 0.112, 1.735), (0.030, 0.027, 0.028))
    return {
        "hair_bald": None,
        "hair_buzz": layer(lambda X, Y, Z: 0.0025 + 0 * X),
        "hair_short": layer(lambda X, Y, Z: 0.006 + 0.012 * ramp(Z, 1.70, 1.77) + 0.006 * ramp(-Y, 0.0, 0.08)
                            * ramp(Z, 1.72, 1.76) + strands(X, Y, Z, 0.0025)),
        "hair_curly": curly,
        "hair_swept": layer(lambda X, Y, Z: 0.004 + 0.022 * ramp(Z, 1.71, 1.78) * (1.0 - 0.4 * ramp(Y, 0.0, 0.10))
                            + 0.006 * ramp(-Y, 0.02, 0.09) * ramp(Z, 1.73, 1.77) + strands(X, Y, Z, 0.0035)),
        "hair_bun": Union([layer(lambda X, Y, Z: 0.006 + 0.004 * ramp(Z, 1.72, 1.78) + strands(X, Y, Z, 0.0015)), bun],
                          k=0.012),
    }


HAIR_TRIANGLES = {"hair_bald": 160, "hair_buzz": 520, "hair_short": 900, "hair_curly": 1400,
                  "hair_swept": 1000, "hair_bun": 1000}


def build_hair(figure, collection):
    """One mesh per hair style, each with the brows; inside of the head removed."""
    brows = _brows(figure.head)
    lo, hi = np.array([-0.15, -0.16, 1.55]), np.array([0.15, 0.17, 1.88])
    made = []
    for name, style in _hair_styles(figure.head).items():
        shape = brows if style is None else Union([style, brows])
        verts, quads = S.mesh_field(shape, HAIR_STEP, lo, hi)
        # Drop the part of the layer inside the head; its open edge is hidden there.
        verts, quads = _keep_vertices(verts, quads, figure.head.at(verts) > -0.0012)
        obj = _mesh_object(name, _smooth(verts, quads, 1), quads, collection)
        _collapse(obj, HAIR_TRIANGLES[name])
        obj.data.materials.append(material("hair"))
        for poly in obj.data.polygons:
            poly.use_smooth = True
        made.append(obj)
    return made


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
    obj = _mesh_object("number", np.array(verts), np.array(faces), collection)
    layer = obj.data.uv_layers.new(name="UVMap")
    for poly in obj.data.polygons:
        for loop in poly.loop_indices:
            layer.data[loop].uv = uvs[obj.data.loops[loop].vertex_index]
        poly.use_smooth = True
    obj.data.materials.append(material("number"))
    return obj


# Coat ------------------------------------------------------------------------------

# A manager's coat: sections as for the trunk, hanging straight from the chest to
# mid-thigh around both legs.
COAT = [
    (0.70, 0.196, 0.116, 0.122, 0.018),
    (0.85, 0.190, 0.114, 0.118, 0.020),
    (1.00, 0.177, 0.112, 0.110, 0.020),
    (1.12, 0.175, 0.124, 0.106, 0.022),
    (1.24, 0.180, 0.132, 0.106, 0.024),
    (1.34, 0.180, 0.128, 0.106, 0.027),
    (1.42, 0.165, 0.100, 0.094, 0.030),
    (1.48, 0.122, 0.062, 0.072, 0.032),
    (1.52, 0.075, 0.045, 0.055, 0.032),
]
COAT_HEM = 0.71
COAT_TRIANGLES = 3400


def build_coat(figure, collection):
    """A coat to mid-thigh with a stand-up collar, over trousers to the shoes."""
    sleeves = _both([_keep_before(figure.arm, "wrist", -0.04)])
    core = Union([Loft(COAT, power=2.3, cap=0.02)] + _both(shoulders()) + sleeves, k=0.03)
    outer = _above(Shell(core, 0.022), COAT_HEM)
    point, normal = COLLAR
    band = Shell(NECK, 0.020)
    box = (band.lo - 0.1, band.hi + 0.1)
    collar = Within(Within(band, Plane(point + normal * 0.045, normal, *box)), Plane(point - normal * 0.03, -normal, *box))
    leg = Union([Cone(THIGH.at(0.0, out=0.008), THIGH.at(1.0), 0.090, 0.064), Cone(SHIN.at(0.0), SHIN.at(1.0), 0.064, 0.056),
                 Shell(leg_core(), 0.012)], k=0.03)
    trousers = _keep_before(leg, "boot", -0.012)
    coat = Union([outer, collar] + _both([trousers]), k=0.006)
    verts, quads = S.mesh_field(coat, STEP)
    # Open the coat where its caps cross the body: at the hem, the cuffs and the neck.
    keep = (core.at(verts) > -0.002) | (verts[:, 2] < COAT_HEM - 0.03)
    keep &= NECK.at(verts) > 0.004
    verts, quads = _keep_vertices(verts, quads, keep)
    obj = _mesh_object("coat", _smooth(verts, quads, 2), quads, collection)
    _collapse(obj, COAT_TRIANGLES)
    obj.data.materials.append(material("coat"))
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
    hair = build_hair(figure, collection)
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
        "materials": {"regions": list(REGIONS), "fixed": list(FIXED)},
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
