"""The hair styles, each with the brows, laid over the head's surface.

Each style is a signed distance shape: a layer over the scalp inside the
hairline (`Hairline`), thicker where the style has volume and thinning to a
couple of millimetres at its edge, or a crop of curls. Every style carries the
brows, so a figure shows exactly one hair mesh and `hair_bald` is the brows
alone. `build_hair(head, collection)` meshes each style, trims the part inside
the head, decimates it to its budget and gives it the `hair` material; body.py
then skins it to the head and adds the face shape keys.
"""

import numpy as np

import shapes as S
from meshes import collapse, keep_vertices, material, mesh_object, smooth
from shapes import Cone, Cut, Ellipsoid, Layer, Shell, Union, Within, both

HAIR_STEP = 0.002  # m: the grid the hair is sampled on
HAIR_STYLES = ("hair_bald", "hair_buzz", "hair_short", "hair_curly", "hair_swept", "hair_bun")

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
    region = Union([top] + both([sideburn]), k=0.01)
    ear = Ellipsoid((0.080, 0.012, 1.664), (0.030, 0.034, 0.040))
    return Cut(region, Union(both([ear])), k=0.008)


def _brows(head):
    """Two brows, a few millimetres proud of the skin above the eyes."""
    inner = Ellipsoid((0.021, -0.093, 1.7005), (0.013, 0.02, 0.0044), S.rotation(ry=0.10))
    outer = Ellipsoid((0.043, -0.085, 1.7035), (0.015, 0.02, 0.0034), S.rotation(ry=-0.10))
    return Within(Shell(head, 0.0024), Union(both([inner, outer]), k=0.004))


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


def build_hair(head, collection):
    """One mesh per hair style, each with the brows, over the `head` shape; returns them."""
    brows = _brows(head)
    lo, hi = np.array([-0.15, -0.16, 1.55]), np.array([0.15, 0.17, 1.88])
    made = []
    for name, style in _hair_styles(head).items():
        shape = brows if style is None else Union([style, brows])
        verts, quads = S.mesh_field(shape, HAIR_STEP, lo, hi)
        # Drop the part of the layer inside the head; its open edge is hidden there.
        verts, quads = keep_vertices(verts, quads, head.at(verts) > -0.0012)
        obj = mesh_object(name, smooth(verts, quads, 1), quads, collection)
        collapse(obj, HAIR_TRIANGLES[name])
        obj.data.materials.append(material("hair"))
        for poly in obj.data.polygons:
            poly.use_smooth = True
        made.append(obj)
    return made
