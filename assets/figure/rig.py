"""The figure's skeleton: one armature shared by players, keepers and managers.

Blender coordinates, metres: Z is up, the figure faces -Y, the soles are at
z = 0 and the figure is 1.80 m tall at scale 1. The figure's left is +X, so
`_L` bones sit at positive x. Proportions follow standard adult anthropometry
(segment lengths as fractions of height). The arms rest in a relaxed A-pose,
45 degrees below horizontal with a slight bend at the elbow, which skins well
for both a run and arms raised overhead.

Bone names have no dots, since three.js drops dots from animation track names.
`root` lies on the ground at the origin and never moves in a clip: the engine
moves the player, and the clips move the body around it.

`build_armature(collection)` is called by build.py; body.py models the body
around `JOINTS`, and clips.py animates the bones.
"""

import bpy
from mathutils import Vector

HEIGHT = 1.80

# Joint positions in metres. Each bone runs from one joint to the next; `heel`
# and `sole_*` are landmarks for modelling and foot contact, not bone ends.
JOINTS = {
    "root": (0.0, 0.0, 0.0),
    "root_tip": (0.0, -0.25, 0.0),
    # Spine: pelvis centre, lumbar, chest, base of the neck, skull, crown.
    "pelvis": (0.0, 0.015, 0.97),
    "spine_base": (0.0, 0.02, 1.07),
    "chest_base": (0.0, 0.025, 1.25),
    "neck_base": (0.0, 0.03, 1.47),
    "head_base": (0.0, 0.015, 1.60),
    "head_top": (0.0, 0.01, HEIGHT),
    # Arms: sternoclavicular joint, shoulder (glenohumeral) joint, elbow, wrist,
    # fingertips of the open hand.
    "clavicle_L": (0.025, 0.0, 1.45),
    "shoulder_L": (0.18, 0.025, 1.43),
    "elbow_L": (0.385, 0.035, 1.225),
    "wrist_L": (0.5626, -0.009, 1.047),
    "hand_tip_L": (0.681, -0.038, 0.928),
    # Legs: hip joint, knee, ankle, ball of the foot, tip of the toes.
    "hip_L": (0.095, 0.0, 0.95),
    "knee_L": (0.10, -0.015, 0.51),
    "ankle_L": (0.10, 0.0, 0.075),
    "ball_L": (0.105, -0.145, 0.025),
    "toe_tip_L": (0.108, -0.215, 0.02),
    # Foot landmarks: back of the heel and the sole under it.
    "heel_L": (0.10, 0.055, 0.03),
    "sole_heel_L": (0.10, 0.03, 0.0),
    "sole_ball_L": (0.105, -0.145, 0.0),
}

# Mirror every _L joint to _R across x = 0.
for _name, (_x, _y, _z) in list(JOINTS.items()):
    if _name.endswith("_L"):
        JOINTS[_name[:-2] + "_R"] = (-_x, _y, _z)

# Bone name -> (head joint, tail joint, parent, connected, roll rule).
# Roll rules: "sagittal" sets the bone's local X to world +X, so bending
# forwards and backwards (spine, legs, feet) is a rotation about local X;
# "forward" points local Z to the front (-Y), so the elbow bends about local X;
# "up" points local Z up (the root lying on the ground).
_SIDED = {
    "shoulder": ("clavicle", "shoulder", "chest", False, "forward"),
    "upper_arm": ("shoulder", "elbow", "shoulder", True, "forward"),
    "forearm": ("elbow", "wrist", "upper_arm", True, "forward"),
    "hand": ("wrist", "hand_tip", "forearm", True, "forward"),
    "thigh": ("hip", "knee", "hips", False, "sagittal"),
    "shin": ("knee", "ankle", "thigh", True, "sagittal"),
    "foot": ("ankle", "ball", "shin", True, "sagittal"),
    "toe": ("ball", "toe_tip", "foot", True, "sagittal"),
}

BONES = {
    "root": ("root", "root_tip", None, False, "up"),
    "hips": ("pelvis", "spine_base", "root", False, "sagittal"),
    "spine": ("spine_base", "chest_base", "hips", True, "sagittal"),
    "chest": ("chest_base", "neck_base", "spine", True, "sagittal"),
    "neck": ("neck_base", "head_base", "chest", True, "sagittal"),
    "head": ("head_base", "head_top", "neck", True, "sagittal"),
}
for _side in ("L", "R"):
    for _bone, (_head, _tail, _parent, _connect, _roll) in _SIDED.items():
        _parent_name = _parent if _parent in BONES else f"{_parent}_{_side}"
        BONES[f"{_bone}_{_side}"] = (
            f"{_head}_{_side}",
            f"{_tail}_{_side}",
            _parent_name,
            _connect,
            _roll,
        )

BONE_NAMES = tuple(BONES)
DEFORM_BONES = tuple(name for name in BONE_NAMES if name != "root")


def _roll_axis(rule, direction):
    """The vector the bone's local Z axis is aligned to."""
    if rule == "sagittal":
        return Vector((1.0, 0.0, 0.0)).cross(direction)
    if rule == "forward":
        return Vector((0.0, -1.0, 0.0))
    return Vector((0.0, 0.0, 1.0))


def build_armature(collection):
    """Build the armature in `collection` and return its object, in object mode."""
    data = bpy.data.armatures.new("rig")
    data.display_type = "OCTAHEDRAL"
    rig = bpy.data.objects.new("rig", data)
    rig.show_in_front = True
    collection.objects.link(rig)

    view_layer = bpy.context.view_layer
    view_layer.objects.active = rig
    rig.select_set(True)
    bpy.ops.object.mode_set(mode="EDIT")

    for name, (head, tail, parent, connected, roll) in BONES.items():
        bone = data.edit_bones.new(name)
        bone.head = JOINTS[head]
        bone.tail = JOINTS[tail]
        direction = (bone.tail - bone.head).normalized()
        bone.align_roll(_roll_axis(roll, direction))
        if parent is not None:
            bone.parent = data.edit_bones[parent]
            bone.use_connect = connected
        bone.use_deform = name != "root"

    bpy.ops.object.mode_set(mode="OBJECT")
    for pose_bone in rig.pose.bones:
        pose_bone.rotation_mode = "QUATERNION"
    return rig
