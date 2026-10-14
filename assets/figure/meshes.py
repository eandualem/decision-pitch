"""Blender mesh helpers shared by the body, the hair and the coat.

Turning a sampled surface into a mesh object, collapsing it to a triangle
budget, smoothing it, trimming it, and the plain materials the page recolours.
"""

import bpy
import numpy as np

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
    "trousers": (0.06, 0.06, 0.07),
    "trim": (0.85, 0.85, 0.85),
}



def keep_vertices(verts, quads, keep):
    """The mesh made of the faces whose vertices all pass `keep`, without loose vertices."""
    quads = quads[np.all(keep[quads], axis=1)]
    used = np.zeros(len(verts), dtype=bool)
    used[quads.ravel()] = True
    index = np.full(len(verts), -1)
    index[used] = np.arange(used.sum())
    return verts[used], index[quads]


def mesh_object(name, verts, faces, collection):
    mesh = bpy.data.meshes.new(name)
    mesh.from_pydata([tuple(v) for v in verts], [], [tuple(int(i) for i in f) for f in faces])
    mesh.validate(clean_customdata=False)
    obj = bpy.data.objects.new(name, mesh)
    collection.objects.link(obj)
    return obj


def collapse(obj, triangles, movable=None):
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


def smooth(verts, faces, iterations=2, factor=0.5):
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


def material(name):
    mat = bpy.data.materials.get(name)
    if mat is not None:
        return mat
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes.get("Principled BSDF")
    colour = COLOURS.get(name, (0.8, 0.8, 0.8))
    bsdf.inputs["Base Color"].default_value = (*colour, 1.0)
    bsdf.inputs["Roughness"].default_value = {"boots": 0.4, "eyes": 0.8}.get(name, 0.75)
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
