"""The committed human figure keeps the contract the page is built against.

These read the exported figure.glb and figure.json directly, so they run
without Blender: the skeleton's bone names, the material regions, the clips,
the parts figure.json names, and the triangle and file-size budgets.
"""

import json
import struct
from pathlib import Path

import pytest

FIGURES = Path(__file__).resolve().parents[1] / "src" / "decision_pitch" / "web" / "figures"
GLB = FIGURES / "figure.glb"
INFO = FIGURES / "figure.json"

BONES = ["root", "hips", "spine", "chest", "neck", "head"] + [
    f"{bone}_{side}"
    for side in ("L", "R")
    for bone in ("shoulder", "upper_arm", "forearm", "hand", "thigh", "shin", "foot", "toe")
]
REGIONS = ["skin", "shirt", "sleeve", "hands", "shorts", "legs", "socks", "boots"]
LOOPS = ["idle", "walk", "jog", "sprint", "backpedal", "strafe_L", "strafe_R"]
PLAYS = ["pass", "shot", "control", "tackle", "header", "throw_in", "celebrate"]
KEEPER = ["keeper_dive_L", "keeper_dive_R", "keeper_catch", "keeper_catch_high"]
TOUCHLINE = ["instruct", "change", "clap", "protest", "cheer", "despair"]
TOUCHES = ["pass", "shot", "control", "tackle", "header", "throw_in"] + KEEPER

FIGURE_TRIANGLES = 11_000  # body, eyes and the largest hair style: about 10k as a guide
GLB_BYTES = 4_000_000  # a few MB at most


def read_glb(path):
    """The glTF JSON of a .glb file, with its binary chunk under "_bin"."""
    data = path.read_bytes()
    magic, version, length = struct.unpack_from("<4sII", data, 0)
    assert magic == b"glTF" and version == 2 and length == len(data)
    chunk_length, chunk_type = struct.unpack_from("<I4s", data, 12)
    assert chunk_type == b"JSON"
    gltf = json.loads(data[20:20 + chunk_length])
    offset = 20 + chunk_length
    bin_length, bin_type = struct.unpack_from("<I4s", data, offset)
    assert bin_type == b"BIN\0"
    gltf["_bin"] = data[offset + 8:offset + 8 + bin_length]
    return gltf


def floats(gltf, accessor_index):
    """An accessor's float components, as a list of tuples."""
    accessor = gltf["accessors"][accessor_index]
    assert accessor["componentType"] == 5126  # FLOAT
    width = {"SCALAR": 1, "VEC2": 2, "VEC3": 3, "VEC4": 4}[accessor["type"]]
    view = gltf["bufferViews"][accessor["bufferView"]]
    start = view.get("byteOffset", 0) + accessor.get("byteOffset", 0)
    stride = view.get("byteStride", 4 * width)
    return [struct.unpack_from(f"<{width}f", gltf["_bin"], start + i * stride) for i in range(accessor["count"])]


@pytest.fixture(scope="module")
def gltf():
    return read_glb(GLB)


@pytest.fixture(scope="module")
def info():
    return json.loads(INFO.read_text())


def node_named(gltf, name):
    matches = [node for node in gltf["nodes"] if node.get("name") == name]
    assert len(matches) == 1, f"one node named {name}"
    return matches[0]


def mesh_of(gltf, name):
    return gltf["meshes"][node_named(gltf, name)["mesh"]]


def triangles(gltf, name):
    return sum(gltf["accessors"][p["indices"]]["count"] // 3 for p in mesh_of(gltf, name)["primitives"])


def material_names(gltf, name):
    return [gltf["materials"][p["material"]]["name"] for p in mesh_of(gltf, name)["primitives"]]


def test_the_skeleton_has_every_bone_of_the_contract(gltf, info):
    (skin,) = gltf["skins"]
    joints = [gltf["nodes"][i]["name"] for i in skin["joints"]]
    assert sorted(joints) == sorted(BONES)
    assert info["bones"] == BONES or sorted(info["bones"]) == sorted(BONES)
    assert not any("." in name for name in joints), "three.js drops dots from track names"


def test_every_part_is_skinned_to_the_one_skeleton(gltf, info):
    parts = [info["body"], info["eyes"]] + info["hair"] + [p for p in (info["coat"], info["number"]) if p]
    for name in parts:
        node = node_named(gltf, name)
        assert node.get("skin") == 0, name
        for primitive in mesh_of(gltf, name)["primitives"]:
            assert {"JOINTS_0", "WEIGHTS_0"} <= primitive["attributes"].keys(), name


def test_the_body_is_split_into_the_kit_regions(gltf, info):
    assert info["materials"]["regions"] == REGIONS
    assert sorted(material_names(gltf, info["body"])) == sorted(REGIONS)
    for region in REGIONS:
        primitive = next(p for p in mesh_of(gltf, info["body"])["primitives"]
                         if gltf["materials"][p["material"]]["name"] == region)
        # The page paints regions with plain colours: no vertex colours on the kit.
        assert "COLOR_0" not in primitive["attributes"], region


def test_the_eyes_are_one_fixed_material(gltf, info):
    assert info["materials"]["fixed"] == ["eyes"]
    assert material_names(gltf, info["eyes"]) == ["eyes"]


def test_hair_styles_coat_and_number_use_their_materials(gltf, info):
    for name in info["hair"]:
        assert material_names(gltf, name) == ["hair"], name
    if info["coat"]:
        assert material_names(gltf, info["coat"]) == ["coat"]
    if info["number"]:
        assert material_names(gltf, info["number"]) == ["number"]
        (primitive,) = mesh_of(gltf, info["number"])["primitives"]
        uv = floats(gltf, primitive["attributes"]["TEXCOORD_0"])
        assert min(u for u, _ in uv) == pytest.approx(0, abs=1e-4) and max(u for u, _ in uv) == pytest.approx(1, abs=1e-4)
        assert min(v for _, v in uv) == pytest.approx(0, abs=1e-4) and max(v for _, v in uv) == pytest.approx(1, abs=1e-4)


def test_the_number_reads_upright_from_behind(gltf, info):
    # The figure faces +z in glTF. Seen from behind, its left (+x) is on the viewer's
    # left: u grows to the viewer's right, so it falls with x; v grows downwards.
    (primitive,) = mesh_of(gltf, info["number"])["primitives"]
    uv = floats(gltf, primitive["attributes"]["TEXCOORD_0"])
    position = floats(gltf, primitive["attributes"]["POSITION"])
    top_left = min(range(len(uv)), key=lambda i: uv[i][0] + uv[i][1])
    bottom_right = max(range(len(uv)), key=lambda i: uv[i][0] + uv[i][1])
    assert position[top_left][0] > position[bottom_right][0]
    assert position[top_left][1] > position[bottom_right][1]
    assert max(p[2] for p in position) < -0.05, "on the back"


def test_morph_targets_named_in_figure_json_exist_on_their_meshes(gltf, info):
    for morph, meshes in info["morphs"].items():
        for name in meshes:
            names = mesh_of(gltf, name).get("extras", {}).get("targetNames", [])
            assert morph in names, (morph, name)


def test_every_clip_is_an_animation_described_in_figure_json(gltf, info):
    animations = {a["name"] for a in gltf["animations"]}
    for clip in LOOPS + PLAYS + KEEPER + TOUCHLINE:
        assert clip in animations, clip
        meta = info["clips"][clip]
        assert meta["duration"] > 0, clip
    for clip in LOOPS:
        assert info["clips"][clip]["loop"] is True, clip
    for clip in LOOPS[1:]:
        assert info["clips"][clip]["speed"] > 0, clip
        assert info["clips"][clip]["direction"] in ("forward", "back", "left", "right"), clip
    for clip in TOUCHES:
        meta = info["clips"][clip]
        assert meta["loop"] is False and 0 < meta["contact"] < meta["duration"], clip


def test_a_figure_stays_within_the_triangle_budget(gltf, info):
    hair = max((triangles(gltf, name) for name in info["hair"]), default=0)
    total = triangles(gltf, info["body"]) + triangles(gltf, info["eyes"]) + hair
    assert total <= FIGURE_TRIANGLES
    assert info["triangles"][info["body"]] == triangles(gltf, info["body"])


def test_the_file_stays_small():
    assert GLB.stat().st_size <= GLB_BYTES


def test_the_figure_is_its_stated_height(gltf, info):
    assert info["height"] == pytest.approx(1.8)
    positions = [gltf["accessors"][p["attributes"]["POSITION"]] for p in mesh_of(gltf, info["body"])["primitives"]]
    # glTF is +Y up: the soles at 0 and the crown at the figure's height.
    assert min(p["min"][1] for p in positions) == pytest.approx(0.0, abs=0.005)
    assert max(p["max"][1] for p in positions) == pytest.approx(1.8, abs=0.01)
