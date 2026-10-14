"""Build the human figure and export it for the page.

    /Applications/Blender.app/Contents/MacOS/Blender --background --factory-startup \\
        --python assets/figure/build.py [-- --export-only]

A full build clears the scene, makes the skeleton (rig.py), the body, kit, hair,
coat and number panel (body.py) and the clips (clips.py), saves
assets/figure/figure.blend and exports src/decision_pitch/web/figures/figure.glb,
made smaller by compact.py, with figure.json beside it. The scripts are the source of truth: a full build
regenerates the .blend.

`--export-only` opens the saved figure.blend as it is, for instance after
restyling it by hand, and exports it without rebuilding. The page's description
of the figure (figure.json) is kept in the .blend, so both modes write the same
file for the same figure. Running either twice gives the same output.
"""

import json
import os
import sys

import bpy

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

ROOT = os.path.dirname(os.path.dirname(HERE))
BLEND = os.path.join(HERE, "figure.blend")
OUT = os.path.join(ROOT, "src", "decision_pitch", "web", "figures")
GLB = os.path.join(OUT, "figure.glb")
JSON = os.path.join(OUT, "figure.json")
INFO = "figure_json"  # the scene property that keeps figure.json's content in the .blend


def build():
    import body
    import clips
    import rig

    bpy.ops.wm.read_factory_settings(use_empty=True)
    scene = bpy.context.scene
    armature = rig.build_armature(scene.collection)
    made = body.build_body(armature)
    clip_info = clips.build_clips(armature)
    info = {
        "height": rig.HEIGHT,
        "armature": armature.name,
        "bones": list(rig.BONE_NAMES),
        **made,
        "clips": clip_info,
    }
    scene[INFO] = json.dumps(info, sort_keys=True)
    scene.frame_set(0)
    save(BLEND)
    return info


def save(path):
    """Write the figure's data, without the window manager and screens.

    Those keep a record of the last file operations, with this machine's paths in
    it; the figure needs none of them, and Blender adds a default layout on opening.
    """
    blocks = set()
    for collection in (bpy.data.scenes, bpy.data.collections, bpy.data.objects, bpy.data.meshes,
                       bpy.data.armatures, bpy.data.materials, bpy.data.actions, bpy.data.worlds,
                       bpy.data.shape_keys):
        blocks.update(collection)
    if os.path.exists(path):
        os.remove(path)
    bpy.data.libraries.write(path, blocks, path_remap="NONE", fake_user=False, compress=True)
    check_clean(path)


def check_clean(path):
    """Fail if the saved .blend names a local folder."""
    import zstandard

    with open(path, "rb") as f:
        data = zstandard.ZstdDecompressor().stream_reader(f, read_across_frames=True).read()
    for needle in ("/Users/", "/home/", "/private/", "/var/folders/", ROOT):
        if needle.encode() in data:
            raise SystemExit(f"{path} names a local path ({needle!r}); not saving it like that")


def export(info):
    import compact

    os.makedirs(OUT, exist_ok=True)
    scene = bpy.context.scene
    scene.frame_set(0)
    bpy.ops.export_scene.gltf(
        filepath=GLB,
        export_format="GLB",
        export_yup=True,
        export_apply=False,
        export_texcoords=True,
        export_normals=True,
        export_tangents=False,
        export_materials="EXPORT",
        export_image_format="NONE",
        export_vertex_color="MATERIAL",
        export_shared_accessors=True,
        export_skins=True,
        export_influence_nb=4,
        export_all_influences=False,
        export_def_bones=False,
        export_morph=True,
        export_morph_normal=False,
        export_morph_tangent=False,
        export_morph_animation=False,
        export_animations=True,
        export_animation_mode="ACTIONS",
        export_force_sampling=True,
        export_optimize_animation_size=True,
        export_anim_single_armature=True,
        export_reset_pose_bones=True,
        export_current_frame=False,
        export_anim_slide_to_zero=False,
        export_frame_range=False,
        export_extras=False,
        export_cameras=False,
        export_lights=False,
        use_selection=False,
        use_visible=False,
        use_renderable=False,
    )
    compact.compact(GLB)
    with open(JSON, "w") as f:
        json.dump(info, f, indent=1, sort_keys=True)
        f.write("\n")
    print("exported", GLB, os.path.getsize(GLB), "bytes")


def main():
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    if "--export-only" in argv:
        bpy.ops.wm.open_mainfile(filepath=BLEND)
        info = json.loads(bpy.context.scene[INFO])
    else:
        info = build()
    export(info)


main()
