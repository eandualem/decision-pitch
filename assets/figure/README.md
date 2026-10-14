# The human figure

Every person on the pitch and the touchline is one original figure: a rigged,
skinned human body modelled, dressed and animated by the Python scripts in this
folder, run in Blender 5.2 with no window. The page loads it once from
`src/decision_pitch/web/figures/figure.glb`, clones it per person and sets each
team's kit, each person's skin, hair, build and height at run time (see
`docs/decisions.md`, section 6, "Human figures made in Blender").

No third-party model, motion capture, texture or asset pack is used.

## Rebuilding

One command rebuilds everything from the scripts:

```sh
/Applications/Blender.app/Contents/MacOS/Blender --background --factory-startup \
    --python assets/figure/build.py
```

(Elsewhere, run your `blender` binary with the same arguments.) It writes:

- `assets/figure/figure.blend`, the figure to open and restyle in Blender;
- `src/decision_pitch/web/figures/figure.glb`, what the page draws;
- `src/decision_pitch/web/figures/figure.json`, what the page needs to know
  about it: the parts, materials, shape keys, triangle counts and each clip's
  duration, speed and direction or moment of contact.

A rebuild takes about half a minute and writes the same `figure.glb` and
`figure.json`, byte for byte, every time. (The `.blend` differs in a few random
identifiers Blender gives nodes and meshes, never in content.)
`tests/test_figure_asset.py` checks the committed files against the contract
without Blender.

## What is in it

| File | What it makes |
|---|---|
| `rig.py` | The skeleton, `rig`: `root`, `hips`, `spine`, `chest`, `neck`, `head`, and `shoulder`, `upper_arm`, `forearm`, `hand`, `thigh`, `shin`, `foot`, `toe` on each side. |
| `body.py` | The body and kit, the eyes, the shirt-number panel, the manager's coat, the skinning and the shape keys. |
| `hair.py` | The hair styles, each carrying the brows. |
| `clips.py` | The animation clips. |
| `shapes.py` | Signed distance shapes and the surface mesher the body, hair and coat are modelled with. |
| `meshes.py` | Mesh helpers and the plain materials. |
| `build.py` | Runs them in order, saves the `.blend` and exports. |
| `compact.py` | Makes the exported `.glb` smaller without changing what the page draws: drops tracks that hold a bone at rest and keys that interpolating their neighbours reproduces (within 0.05 degrees or 0.3 mm), and stores rotations as 16-bit integers. |
| `render.py` | Draws stills for checking by eye. |

The body is modelled as smooth signed-distance shapes around the skeleton's
joints (a trunk lofted from measured sections, muscles as ellipsoids, limbs as
rounded cones, a face, hands and boots), with the kit modelled into the same
surface. It is meshed, decimated to the game budget (more of it spent on the
face), mirrored so both halves match, cut along the kit's edges and skinned to
the skeleton.

The objects, all children of `rig` and skinned to it:

- `body`: about 9,000 triangles, with one material per kit region: `skin`
  (head and neck), `shirt`, `sleeve` (below the short sleeve), `hands`,
  `shorts`, `legs`, `socks`, `boots`;
- `eyes`: the eyeballs and the line of the mouth, with the fixed material
  `eyes` coloured by vertex colours;
- `number`: the panel the shirt number is printed on, material `number`. Its
  UVs read upright from behind with glTF's convention (the page's canvas
  texture has `flipY` off);
- `hair_bald`, `hair_buzz`, `hair_short`, `hair_curly`, `hair_swept`,
  `hair_bun`: one is shown per figure, material `hair`. Each carries the
  brows, so `hair_bald` is the brows alone;
- `coat`: a manager's zip-up track jacket over track trousers, hidden for
  players, with materials `coat`, `trousers` and `trim` (collar and zip).

Shape keys, exported as morph targets, vary the build and the face:
`build_slim`, `build_broad`, `face_wide`, `face_long`, `jaw_strong`,
`nose_big`. Every part that a key moves carries it under the same name, so
clothes and hair follow the body; none of them moves a bone. Height is the
figure's uniform scale.

## Restyling in Blender

Open `assets/figure/figure.blend`. The kit's colours there are defaults only:
the page paints every region by its material's name, so a team's colours never
need the `.blend`. What the `.blend` is for is shape and cut.

- To change a region's default colour or finish, edit its material.
- To change a garment's shape, edit its mesh in Edit Mode or sculpt it. Keep
  the object's and the materials' names, keep it a child of `rig` with its
  Armature modifier, and give new vertices weights (Weight Paint, or Data
  Transfer from `body`).
- To change where a region ends, reassign faces to the region's material.

Then export without rebuilding, so the hand edit is kept:

```sh
/Applications/Blender.app/Contents/MacOS/Blender --background --factory-startup \
    --python assets/figure/build.py -- --export-only
```

The scripts remain the source of truth: a full rebuild regenerates the
`.blend` and drops hand edits. To keep a change, carry it into the scripts
(the shapes and constants in `body.py` and `hair.py`) and rebuild.

## Checking by eye

```sh
/Applications/Blender.app/Contents/MacOS/Blender --background --factory-startup \
    --python assets/figure/render.py -- --out /tmp/stills
```

renders `front`, `side`, `back`, `face`, `lineup` (six variations side by
side), `coat` and `keeper` stills of the saved figure. `--views` picks some of
them; `--clip jog --frames 0,8 --view side` poses it with a clip, at times
given in frames of 1/30 s (the clips are keyed 60 times a second);
`--ball 0,-0.59,0.11` adds a ball there, to see where a dribble or a kick meets
it; `--camera x,y,z,tx,ty,tz,lens` frames any detail.
