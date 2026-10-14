"""The hair styles, each with the brows, laid over the head's surface.

Each style is a signed distance shape: a layer over the scalp inside the
hairline (`Hairline`), thicker where the style has volume and thinning to a
couple of millimetres at its edge, or a crop of curls. Every style carries the
brows, so a figure shows exactly one hair mesh and `hair_bald` is the brows
alone. `build_hair(head, collection)` meshes each style, trims the part inside
the head, decimates it to its budget and gives it the `hair` material; body.py
then skins it to the head and adds the face shape keys.
"""

import bmesh
import bpy
import numpy as np

import shapes as S
from meshes import collapse, keep_vertices, material, mesh_object, smooth
from shapes import Cone, Cut, Ellipsoid, Layer, Shell, Union, Within, both

HAIR_STEP = 0.002  # m: the grid the hair is sampled on
BROW_STEP = 0.001  # m: the brows' finer grid, for a clean edge on something a few millimetres tall
BROW_TRIANGLES = 160  # of each style's budget
HAIR_STYLES = ("hair_bald", "hair_buzz", "hair_short", "hair_curly", "hair_swept", "hair_bun")

class Hairline(S.Shape):
    """Above the hairline: 1.735 m at the middle of the forehead, curving up by about
    2.4 cm to the temples and down again in front of the ears, then down the sides to
    1.595 m at the nape (inside is negative)."""

    lo = np.array([-0.15, -0.16, 1.50])
    hi = np.array([0.15, 0.17, 1.86])

    def field(self, X, Y, Z):
        ax = np.abs(X)
        t = np.clip((ax - 0.010) / 0.042, 0.0, 1.0)
        front = np.clip(-Y / 0.06, 0.0, 1.0)  # the forehead, fading out towards the ears
        temples = 0.024 * t * t * (3.0 - 2.0 * t) * front
        line = 1.735 - 0.70 * (Y + 0.09) + temples
        return (line - Z) * 0.82


def _hair_region():
    """Where hair grows: above the hairline, around the ears, with sideburns."""
    top = Hairline()
    sideburn = Cone((0.076, -0.004, 1.705), (0.074, -0.010, 1.658), 0.0075)
    region = Union([top] + both([sideburn]), k=0.01)
    ear = Ellipsoid((0.080, 0.012, 1.664), (0.030, 0.034, 0.040))
    return Cut(region, Union(both([ear])), k=0.008)


def _surface(head, x, z):
    """Where the front of `head` is at (x, z): its y, found from the front."""
    out, inside = -0.16, -0.04
    for _ in range(40):
        y = (out + inside) / 2
        if head.at(np.array([[x, y, z]]))[0] > 0:
            out = y
        else:
            inside = y
    return (out + inside) / 2


def _brows(head):
    """Two brows a few millimetres proud of the skin above the eyes: level, with a slight
    arch two thirds of the way out, tapering from the inner end to the outer."""
    points = []
    for i in range(7):
        t = i / 6
        x = 0.015 + 0.036 * t
        z = 1.7032 + 0.0034 * np.sin(np.pi * t ** 0.8) - 0.0012 * t * t
        points.append((np.array([x, _surface(head, x, z), z]), 0.0029 - 0.0011 * t))
    parts = [Cone(a, b, ra, rb) for (a, ra), (b, rb) in zip(points, points[1:])]
    return Within(Shell(head, 0.0024), Union(both(parts), k=0.002))


def _hair_styles(head):
    """Each style as a shape: a layer over the scalp, thicker where the style has volume."""
    region = _hair_region()

    def layer(thickness):
        return Layer(head, region, thickness, edge=0.03, edge_min=0.0022)

    def ramp(v, lo, hi):
        return np.clip((v - lo) / (hi - lo), 0.0, 1.0)

    def tufts(X, Y, Z, depth):
        """Soft clumps over the crown: broad and shallow, so the outline stays round."""
        clumps = np.sin(X * 120.0 + 3.0 * np.sin(Y * 40.0)) * np.cos(Y * 70.0 + 1.3 * np.sin(X * 50.0))
        return depth * (0.5 + 0.5 * clumps) * ramp(Z, 1.71, 1.76)

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
                            * ramp(Z, 1.72, 1.76) + tufts(X, Y, Z, 0.0022)),
        "hair_curly": curly,
        "hair_swept": layer(lambda X, Y, Z: 0.004 + 0.022 * ramp(Z, 1.71, 1.78) * (1.0 - 0.4 * ramp(Y, 0.0, 0.10))
                            + 0.006 * ramp(-Y, 0.02, 0.09) * ramp(Z, 1.73, 1.77) + tufts(X, Y, Z, 0.0028)),
        "hair_bun": Union([layer(lambda X, Y, Z: 0.006 + 0.004 * ramp(Z, 1.72, 1.78) + tufts(X, Y, Z, 0.0015)), bun],
                          k=0.012),
    }


HAIR_TRIANGLES = {"hair_bald": 160, "hair_buzz": 520, "hair_short": 900, "hair_curly": 1400,
                  "hair_swept": 1000, "hair_bun": 1000}


def _meshed(shape, step, lo, hi, head, name, collection, triangles):
    """`shape` meshed on a grid of `step`, without the part inside the head (its open edge
    is hidden there), decimated to `triangles`."""
    verts, quads = S.mesh_field(shape, step, lo, hi)
    verts, quads = keep_vertices(verts, quads, head.at(verts) > -0.0012)
    obj = mesh_object(name, smooth(verts, quads, 1), quads, collection)
    collapse(obj, triangles)
    return obj


def build_hair(head, collection):
    """One mesh per hair style, each with the brows, over the `head` shape; returns them."""
    lo, hi = np.array([-0.15, -0.16, 1.55]), np.array([0.15, 0.17, 1.88])
    brows = _meshed(_brows(head), BROW_STEP, np.array([-0.07, -0.12, 1.68]), np.array([0.07, -0.06, 1.725]),
                    head, "brows", collection, BROW_TRIANGLES)
    made = []
    for name, style in _hair_styles(head).items():
        if style is None:
            obj = mesh_object(name, np.zeros((0, 3)), [], collection)
        else:
            obj = _meshed(style, HAIR_STEP, lo, hi, head, name, collection, HAIR_TRIANGLES[name] - BROW_TRIANGLES)
        bm = bmesh.new()
        bm.from_mesh(obj.data)
        bm.from_mesh(brows.data)  # appends the brows
        bm.to_mesh(obj.data)
        bm.free()
        obj.data.materials.append(material("hair"))
        for poly in obj.data.polygons:
            poly.use_smooth = True
        made.append(obj)
    shared = brows.data
    bpy.data.objects.remove(brows)
    bpy.data.meshes.remove(shared)
    return made
