"""Make the exported figure.glb smaller without changing what the page draws.

The glTF exporter writes every bone's translation, rotation and scale for every
clip, keyed on every frame. After export, `compact(path)` rewrites the file:

- a track that holds the bone's rest value throughout is dropped (the page's
  mixer then keeps the rest value, exactly as the track did);
- a track's keys that interpolating their neighbours reproduces, within a
  small tolerance, are dropped (rotations interpolate along the shortest arc,
  as three.js does);
- rotations are stored as normalised 16-bit integers, which glTF allows for
  animation and three.js reads, instead of 32-bit floats;
- all the clips' keys share one buffer view, and the JSON is written without
  spaces.

Everything else in the file, meshes, skin and materials, is kept as it is. The
same input gives the same output, byte for byte.
"""

import json
import math
import struct

ROTATION_TOLERANCE = math.radians(0.05)  # how far a dropped rotation key may be from its interpolation
TRANSLATION_TOLERANCE = 0.0003  # m
REST_TOLERANCE = 1e-5  # a track this close to the rest value throughout is the rest value

FLOAT, SHORT = 5126, 5122
WIDTH = {"SCALAR": 1, "VEC2": 2, "VEC3": 3, "VEC4": 4, "MAT4": 16}
REST = {"translation": [0.0, 0.0, 0.0], "rotation": [0.0, 0.0, 0.0, 1.0], "scale": [1.0, 1.0, 1.0]}


def read_glb(path):
    with open(path, "rb") as f:
        data = f.read()
    magic, version, length = struct.unpack_from("<4sII", data, 0)
    assert magic == b"glTF" and version == 2 and length == len(data)
    json_length, json_type = struct.unpack_from("<I4s", data, 12)
    assert json_type == b"JSON"
    gltf = json.loads(data[20:20 + json_length])
    offset = 20 + json_length
    bin_length, bin_type = struct.unpack_from("<I4s", data, offset)
    assert bin_type == b"BIN\0"
    return gltf, data[offset + 8:offset + 8 + bin_length]


def write_glb(path, gltf, blob):
    text = json.dumps(gltf, separators=(",", ":"), sort_keys=True).encode()
    text += b" " * (-len(text) % 4)
    blob += b"\0" * (-len(blob) % 4)
    length = 12 + 8 + len(text) + 8 + len(blob)
    with open(path, "wb") as f:
        f.write(struct.pack("<4sII", b"glTF", 2, length))
        f.write(struct.pack("<I4s", len(text), b"JSON") + text)
        f.write(struct.pack("<I4s", len(blob), b"BIN\0") + blob)


def values(gltf, blob, index):
    """An accessor's elements as tuples of floats."""
    accessor = gltf["accessors"][index]
    assert accessor["componentType"] == FLOAT and "sparse" not in accessor
    width = WIDTH[accessor["type"]]
    view = gltf["bufferViews"][accessor["bufferView"]]
    start = view.get("byteOffset", 0) + accessor.get("byteOffset", 0)
    stride = view.get("byteStride", 4 * width)
    return [struct.unpack_from(f"<{width}f", blob, start + i * stride) for i in range(accessor["count"])]


# -- interpolation and its error ------------------------------------------------


def lerp(a, b, f):
    return tuple(x + (y - x) * f for x, y in zip(a, b))


def normalised(q):
    n = math.sqrt(sum(c * c for c in q))
    return tuple(c / n for c in q)


def slerp(a, b, f):
    dot = sum(x * y for x, y in zip(a, b))
    if dot < 0.0:
        b, dot = tuple(-c for c in b), -dot
    if dot > 0.9995:
        return normalised(lerp(a, b, f))
    theta = math.acos(min(1.0, dot))
    s = math.sin(theta)
    wa, wb = math.sin((1.0 - f) * theta) / s, math.sin(f * theta) / s
    return tuple(wa * x + wb * y for x, y in zip(a, b))


def angle(a, b):
    dot = abs(sum(x * y for x, y in zip(normalised(a), normalised(b))))
    return 2.0 * math.acos(min(1.0, dot))


def distance(a, b):
    return math.sqrt(sum((x - y) ** 2 for x, y in zip(a, b)))


def kept(times, keys, interpolate, error, tolerance):
    """The indices of the keys to keep: the ends, and every key the interpolation of the
    kept keys around it misses by more than `tolerance` (split where it misses most)."""
    n = len(times)
    keep = {0, n - 1}
    spans = [(0, n - 1)]
    while spans:
        a, b = spans.pop()
        worst, at = tolerance, None
        for i in range(a + 1, b):
            f = (times[i] - times[a]) / (times[b] - times[a])
            e = error(interpolate(keys[a], keys[b], f), keys[i])
            if e > worst:
                worst, at = e, i
        if at is not None:
            keep.add(at)
            spans += [(a, at), (at, b)]
    return sorted(keep)


# -- the rewrite ----------------------------------------------------------------------


class Packer:
    """Accessors packed one after another into one buffer view."""

    def __init__(self, gltf, view):
        self.gltf = gltf
        self.view = view
        self.data = bytearray()
        self.cache = {}

    def add(self, payload, accessor):
        key = (bytes(payload), json.dumps(accessor, sort_keys=True))
        if key not in self.cache:
            self.data += b"\0" * (-len(self.data) % 4)
            accessor = dict(accessor, bufferView=self.view, byteOffset=len(self.data))
            self.data += payload
            self.gltf["accessors"].append(accessor)
            self.cache[key] = len(self.gltf["accessors"]) - 1
        return self.cache[key]

    def times(self, times):
        payload = struct.pack(f"<{len(times)}f", *times)
        return self.add(payload, {"componentType": FLOAT, "count": len(times), "type": "SCALAR",
                                  "min": [min(times)], "max": [max(times)]})

    def floats(self, keys, kind):
        flat = [c for key in keys for c in key]
        return self.add(struct.pack(f"<{len(flat)}f", *flat), {"componentType": FLOAT, "count": len(keys), "type": kind})

    def shorts(self, keys, kind):
        flat = [max(-32767, min(32767, round(c * 32767))) for key in keys for c in key]
        return self.add(struct.pack(f"<{len(flat)}h", *flat),
                        {"componentType": SHORT, "normalized": True, "count": len(keys), "type": kind})


def compact(path):
    gltf, blob = read_glb(path)
    animated = {s[k] for a in gltf.get("animations", []) for s in a["samplers"] for k in ("input", "output")}
    animated_views = {gltf["accessors"][i]["bufferView"] for i in animated}

    # Keep every other buffer view and accessor, in order, with their bytes.
    views, data, view_index = [], bytearray(), {}
    for i, view in enumerate(gltf["bufferViews"]):
        if i in animated_views:
            continue
        data += b"\0" * (-len(data) % 4)
        start = view.get("byteOffset", 0)
        new = dict(view, byteOffset=len(data))
        data += blob[start:start + view["byteLength"]]
        view_index[i] = len(views)
        views.append(new)
    accessors, accessor_index = [], {}
    for i, accessor in enumerate(gltf["accessors"]):
        if i in animated:
            continue
        accessor = json.loads(json.dumps(accessor))
        if "bufferView" in accessor:
            accessor["bufferView"] = view_index[accessor["bufferView"]]
        for part in ("indices", "values"):
            if part in accessor.get("sparse", {}):
                accessor["sparse"][part]["bufferView"] = view_index[accessor["sparse"][part]["bufferView"]]
        accessor_index[i] = len(accessors)
        accessors.append(accessor)

    old = {"accessors": gltf["accessors"], "bufferViews": gltf["bufferViews"]}
    gltf["accessors"], gltf["bufferViews"] = accessors, views
    for mesh in gltf["meshes"]:
        for primitive in mesh["primitives"]:
            primitive["attributes"] = {k: accessor_index[v] for k, v in primitive["attributes"].items()}
            if "indices" in primitive:
                primitive["indices"] = accessor_index[primitive["indices"]]
            primitive["targets"] = [{k: accessor_index[v] for k, v in target.items()}
                                    for target in primitive.get("targets", [])] or None
            if primitive["targets"] is None:
                del primitive["targets"]
    for skin in gltf.get("skins", []):
        skin["inverseBindMatrices"] = accessor_index[skin["inverseBindMatrices"]]

    # The clips, rewritten into one new buffer view.
    packer = Packer(gltf, len(views))
    source = dict(gltf, **old)
    for animation in gltf.get("animations", []):
        samplers, channels = [], []
        for channel in animation["channels"]:
            sampler = animation["samplers"][channel["sampler"]]
            prop = channel["target"]["path"]
            node = gltf["nodes"][channel["target"]["node"]]
            times = [t for (t,) in values(source, blob, sampler["input"])]
            keys = values(source, blob, sampler["output"])
            rest = node.get(prop, REST[prop])
            if prop == "rotation":
                interpolate, error, tolerance = slerp, angle, ROTATION_TOLERANCE
            else:
                interpolate, error, tolerance = lerp, distance, TRANSLATION_TOLERANCE
            if all(error(key, rest) < REST_TOLERANCE for key in keys):
                continue
            if sampler.get("interpolation", "LINEAR") == "STEP" or all(error(key, keys[0]) < REST_TOLERANCE for key in keys):
                keep = [0]
            else:
                keep = kept(times, keys, interpolate, error, tolerance)
            times = [times[i] for i in keep]
            keys = [keys[i] for i in keep]
            kind = old["accessors"][sampler["output"]]["type"]
            output = packer.shorts(keys, kind) if prop == "rotation" else packer.floats(keys, kind)
            samplers.append({"input": packer.times(times), "output": output})
            channels.append({"sampler": len(samplers) - 1, "target": channel["target"]})
        animation["samplers"], animation["channels"] = samplers, channels
    data += b"\0" * (-len(data) % 4)
    views.append({"buffer": 0, "byteOffset": len(data), "byteLength": len(packer.data)})
    data += packer.data
    gltf["buffers"] = [{"byteLength": len(data)}]
    write_glb(path, gltf, bytes(data))
