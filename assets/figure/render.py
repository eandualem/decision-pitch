"""Render stills of the figure headless, to check it by eye.

    /Applications/Blender.app/Contents/MacOS/Blender --background --factory-startup \\
        --python assets/figure/render.py -- --out /path/to/stills [options]

Options:
    --blend PATH        the figure to render (default: assets/figure/figure.blend)
    --views LIST        comma-separated: front, side, back, face, lineup, coat, keeper
                        (default: all of them)
    --clip NAME         pose the figure with a clip; with --frames, one still per frame
    --frames LIST       comma-separated frame numbers of --clip (default: 0)
    --view NAME         the camera for --clip stills (default: side)
    --camera X,Y,Z,TX,TY,TZ,LENS
                        a custom camera (location, target, focal length in mm),
                        rendered as <out>/camera.png
    --engine NAME       eevee (default) or workbench

Each still is written as <out>/<view>.png, or <out>/<clip>_<frame>_<view>.png.
"""

import argparse
import math
import os
import sys

import bpy
from mathutils import Vector

HERE = os.path.dirname(os.path.abspath(__file__))

SKIN = [(0.80, 0.60, 0.48), (0.56, 0.38, 0.28), (0.36, 0.22, 0.14), (0.20, 0.12, 0.08), (0.70, 0.50, 0.36)]
HAIR = [(0.04, 0.03, 0.02), (0.20, 0.12, 0.06), (0.55, 0.40, 0.20), (0.02, 0.02, 0.02), (0.35, 0.16, 0.07)]
KITS = {
    "home": {"shirt": (0.70, 0.08, 0.10), "shorts": (0.95, 0.95, 0.95), "socks": (0.70, 0.08, 0.10)},
    "away": {"shirt": (0.10, 0.25, 0.65), "shorts": (0.10, 0.25, 0.65), "socks": (0.95, 0.95, 0.95)},
    "keeper": {"shirt": (0.95, 0.75, 0.05), "shorts": (0.05, 0.05, 0.05), "socks": (0.95, 0.75, 0.05),
               "sleeve": (0.95, 0.75, 0.05), "hands": (0.15, 0.55, 0.20)},
    "manager": {"shirt": (0.85, 0.85, 0.88), "sleeve": (0.85, 0.85, 0.88), "shorts": (0.08, 0.08, 0.10),
                "legs": (0.08, 0.08, 0.10), "socks": (0.08, 0.08, 0.10), "coat": (0.12, 0.13, 0.16)},
}
LINEUP = [
    {"kit": "home", "skin": 1, "hair": "hair_short", "hair_colour": 0, "height": 1.78, "morphs": {}},
    {"kit": "home", "skin": 3, "hair": "hair_curly", "hair_colour": 3, "height": 1.88,
     "morphs": {"build_broad": 0.8, "jaw_strong": 0.6}},
    {"kit": "home", "skin": 0, "hair": "hair_swept", "hair_colour": 2, "height": 1.72,
     "morphs": {"build_slim": 0.7, "face_long": 0.6, "nose_big": 0.5}},
    {"kit": "away", "skin": 4, "hair": "hair_bun", "hair_colour": 4, "height": 1.83,
     "morphs": {"face_wide": 0.7}},
    {"kit": "away", "skin": 2, "hair": "hair_buzz", "hair_colour": 0, "height": 1.93,
     "morphs": {"build_broad": 0.4, "nose_big": 0.8}},
    {"kit": "away", "skin": 0, "hair": "hair_bald", "hair_colour": 1, "height": 1.75,
     "morphs": {"build_slim": 0.3, "face_wide": 0.4, "jaw_strong": 0.8}},
]
CAMERAS = {
    # name: (location, target, focal length mm)
    "front": ((0.0, -5.2, 1.0), (0.0, 0.0, 0.93), 80),
    "side": ((5.2, 0.0, 1.0), (0.0, 0.0, 0.93), 80),
    "back": ((0.0, 5.2, 1.0), (0.0, 0.0, 0.93), 80),
    "face": ((0.16, -0.75, 1.70), (0.0, -0.02, 1.665), 85),
    "three_quarter": ((2.6, -4.2, 1.3), (0.0, 0.0, 0.93), 80),
}


def parse():
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    parser = argparse.ArgumentParser(prog="render.py")
    parser.add_argument("--out", required=True)
    parser.add_argument("--blend", default=os.path.join(HERE, "figure.blend"))
    parser.add_argument("--views", default="front,side,back,face,lineup,coat,keeper")
    parser.add_argument("--clip")
    parser.add_argument("--frames", default="0")
    parser.add_argument("--view", default="side")
    parser.add_argument("--engine", default="eevee")
    parser.add_argument("--camera")
    return parser.parse_args(argv)


def stage(engine):
    scene = bpy.context.scene
    scene.render.engine = "BLENDER_WORKBENCH" if engine == "workbench" else "BLENDER_EEVEE"
    if engine != "workbench":
        scene.eevee.taa_render_samples = 32
    scene.render.film_transparent = False
    scene.view_settings.view_transform = "Standard"
    world = bpy.data.worlds.new("stills") if scene.world is None else scene.world
    scene.world = world
    world.use_nodes = True
    world.node_tree.nodes["Background"].inputs["Color"].default_value = (0.42, 0.46, 0.52, 1.0)
    world.node_tree.nodes["Background"].inputs["Strength"].default_value = 0.7
    sun = bpy.data.objects.new("sun", bpy.data.lights.new("sun", "SUN"))
    sun.data.energy = 3.2
    sun.data.angle = math.radians(8)
    sun.rotation_euler = (math.radians(50), math.radians(10), math.radians(-35))
    scene.collection.objects.link(sun)
    fill = bpy.data.objects.new("fill", bpy.data.lights.new("fill", "SUN"))
    fill.data.energy = 0.8
    fill.rotation_euler = (math.radians(70), 0, math.radians(150))
    scene.collection.objects.link(fill)
    bpy.ops.mesh.primitive_plane_add(size=40)
    ground = bpy.context.active_object
    mat = bpy.data.materials.new("ground")
    mat.use_nodes = True
    mat.node_tree.nodes["Principled BSDF"].inputs["Base Color"].default_value = (0.16, 0.30, 0.12, 1.0)
    mat.node_tree.nodes["Principled BSDF"].inputs["Roughness"].default_value = 0.95
    ground.data.materials.append(mat)
    cam = bpy.data.objects.new("camera", bpy.data.cameras.new("camera"))
    scene.collection.objects.link(cam)
    scene.camera = cam
    return cam


def aim(cam, location, target, lens):
    cam.location = Vector(location)
    cam.data.lens = lens
    direction = Vector(target) - Vector(location)
    cam.rotation_euler = direction.to_track_quat("-Z", "Y").to_euler()


def colour(mat, rgb):
    bsdf = mat.node_tree.nodes.get("Principled BSDF")
    if bsdf is not None:
        bsdf.inputs["Base Color"].default_value = (*rgb, 1.0)
    mat.diffuse_color = (*rgb, 1.0)


def figure_parts(rig):
    return [o for o in bpy.data.objects if o.parent == rig and o.type == "MESH"]


def clone(rig, location):
    """A copy of the figure with its own mesh data and materials."""
    new_rig = rig.copy()
    bpy.context.scene.collection.objects.link(new_rig)
    new_rig.location = Vector(location)
    for part in figure_parts(rig):
        obj = part.copy()
        obj.data = part.data.copy()
        for i, mat in enumerate(obj.data.materials):
            obj.data.materials[i] = mat.copy()
        obj.parent = new_rig
        for mod in obj.modifiers:
            if mod.type == "ARMATURE":
                mod.object = new_rig
        bpy.context.scene.collection.objects.link(obj)
    return new_rig


def dress(rig, spec):
    """Apply a variation: kit colours, skin, hair style and colour, morphs and height."""
    kit = dict(KITS[spec.get("kit", "home")])
    skin = SKIN[spec.get("skin", 1)]
    paint = {"skin": skin, "sleeve": skin, "hands": skin, "legs": skin, "boots": (0.03, 0.03, 0.03),
             "hair": HAIR[spec.get("hair_colour", 0)], "number": (0.97, 0.97, 0.97)}
    paint.update(kit)
    coat = "coat" in kit
    for part in figure_parts(rig):
        if part.name.startswith("hair_"):
            visible = part.name.split(".")[0] == spec.get("hair", "hair_short")
            part.hide_render = not visible
        if part.name.startswith("coat"):
            part.hide_render = not coat
        for mat in part.data.materials:
            name = mat.name.split(".")[0]
            if name in paint:
                colour(mat, paint[name])
        keys = part.data.shape_keys
        if keys is not None:
            for block in keys.key_blocks[1:]:
                block.value = spec.get("morphs", {}).get(block.name, 0.0)
    scale = spec.get("height", 1.8) / 1.8
    rig.scale = (scale, scale, scale)


# Seven-segment digits: which of the segments a-g each digit lights.
SEGMENTS = {"0": "abcdef", "1": "bc", "2": "abdeg", "3": "abcdg", "4": "bcfg", "5": "acdfg", "6": "acdefg",
            "7": "abc", "8": "abcdefg", "9": "abcdfg"}


def number_image(text, size=128):
    """A shirt number drawn as the page draws it: on a transparent square, upright.

    Pixel rows run bottom to top in Blender images, so the top of the digits is
    at the last rows.
    """
    pixels = [0.0] * (size * size * 4)

    def fill(x0, y0, x1, y1):  # in a 0..1 square, y up
        for y in range(int(y0 * size), int(y1 * size)):
            for x in range(int(x0 * size), int(x1 * size)):
                i = (y * size + x) * 4
                pixels[i:i + 4] = [1.0, 1.0, 1.0, 1.0]

    width = 0.8 / len(text)
    for n, digit in enumerate(text):
        x0, x1, t = 0.1 + n * width + 0.04, 0.1 + (n + 1) * width - 0.04, 0.07
        y0, ym, y1 = 0.12, 0.5, 0.88
        bars = {"a": (x0, y1 - t, x1, y1), "g": (x0, ym - t / 2, x1, ym + t / 2), "d": (x0, y0, x1, y0 + t),
                "f": (x0, ym, x0 + t, y1), "b": (x1 - t, ym, x1, y1), "e": (x0, y0, x0 + t, ym),
                "c": (x1 - t, y0, x1, ym)}
        for segment in SEGMENTS[digit]:
            fill(*bars[segment])
    image = bpy.data.images.new("number_" + text, size, size, alpha=True)
    image.pixels[:] = pixels
    return image


def print_number(rig, text):
    """Map a number onto the figure's number panel, as the page does."""
    for part in figure_parts(rig):
        if not part.name.startswith("number"):
            continue
        mat = part.data.materials[0]
        nodes, links = mat.node_tree.nodes, mat.node_tree.links
        bsdf = nodes.get("Principled BSDF")
        tex = nodes.new("ShaderNodeTexImage")
        tex.image = number_image(text)
        tex.interpolation = "Closest"
        links.new(tex.outputs["Color"], bsdf.inputs["Base Color"])
        links.new(tex.outputs["Alpha"], bsdf.inputs["Alpha"])
        if hasattr(mat, "surface_render_method"):
            mat.surface_render_method = "DITHERED"


def pose_clip(rig, name, frame):
    action = bpy.data.actions[name]
    rig.animation_data_create()
    rig.animation_data.action = action
    if hasattr(rig.animation_data, "action_slot") and action.slots:
        rig.animation_data.action_slot = action.slots[0]
    bpy.context.scene.frame_set(int(frame))


def shoot(cam, path, view, size=(600, 800)):
    scene = bpy.context.scene
    scene.render.resolution_x, scene.render.resolution_y = size
    aim(cam, *CAMERAS[view])
    scene.render.filepath = path
    bpy.ops.render.render(write_still=True)
    print("wrote", path)


def main():
    args = parse()
    os.makedirs(args.out, exist_ok=True)
    bpy.ops.wm.open_mainfile(filepath=args.blend)
    rig = bpy.data.objects["rig"]
    # NLA tracks would override a posed clip.
    if rig.animation_data:
        for track in rig.animation_data.nla_tracks:
            track.mute = True
    cam = stage(args.engine)
    dress(rig, LINEUP[0])
    print_number(rig, "17")
    if args.camera and not args.clip:
        pass
    if args.clip:
        for frame in args.frames.split(","):
            pose_clip(rig, args.clip, frame)
            shoot(cam, os.path.join(args.out, f"{args.clip}_{frame}_{args.view}.png"), args.view)
        return
    if args.camera:
        v = [float(n) for n in args.camera.split(",")]
        CAMERAS["camera"] = (tuple(v[0:3]), tuple(v[3:6]), v[6])
        shoot(cam, os.path.join(args.out, "camera.png"), "camera")
        return
    views = args.views.split(",")
    for view in ("front", "side", "back", "three_quarter"):
        if view in views:
            shoot(cam, os.path.join(args.out, f"{view}.png"), view)
    if "face" in views:
        shoot(cam, os.path.join(args.out, "face.png"), "face", (700, 700))
    if "keeper" in views:
        dress(rig, {**LINEUP[1], "kit": "keeper"})
        shoot(cam, os.path.join(args.out, "keeper.png"), "three_quarter")
    if "coat" in views:
        dress(rig, {**LINEUP[0], "kit": "manager", "hair": "hair_swept", "hair_colour": 1})
        shoot(cam, os.path.join(args.out, "coat.png"), "three_quarter")
    if "lineup" in views:
        rig.hide_render = True
        for part in figure_parts(rig):
            part.hide_render = True
        spacing = 0.85
        count = len(LINEUP)
        for i, spec in enumerate(LINEUP):
            copy = clone(rig, ((i - (count - 1) / 2) * spacing, 0.0, 0.0))
            copy.hide_render = False
            for part in figure_parts(copy):
                part.hide_render = False
            dress(copy, spec)
        aim(cam, (0.0, -7.5, 1.1), (0.0, 0.0, 0.95), 50)
        scene = bpy.context.scene
        scene.render.resolution_x, scene.render.resolution_y = 1800, 1000
        scene.render.filepath = os.path.join(args.out, "lineup.png")
        bpy.ops.render.render(write_still=True)
        print("wrote", scene.render.filepath)


main()
