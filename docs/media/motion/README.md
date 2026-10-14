# Natural movement: what it looks like

Evidence for issue #58: players who turn, cut, step sideways and diagonally,
slow down and speed up, dribble and stand side-on, with their feet planted
and no two neighbours in step. Recorded at commit `553de80` (the docs commit
on top of it changes nothing on screen) on the engine from #57, where a
player faces one way while it moves another.

| File | What it shows | Source |
|---|---|---|
| `motion-match.mp4` | 103 s cut from a 3 min recording: the broadcast wide shot and close-ups | Live, keyless match, the built-in bots on both teams |
| `motion-knock-laya.mp4` | 22 s: three sprints with the ball, the runner knocking it a few metres ahead and running on to it (five knocks), cut from a 6 min recording | Live, keyless match, the home team played by the local model Laya (the bots never choose to sprint with the ball) |
| `wide-open-play.jpg` | The wide shot in open play | Live, bots (the 3 min recording) |
| `dribble-cut.jpg` | A midfielder cutting with the ball at 5 m/s | Live, bots |
| `sideways-facing-ball.jpg` | A defender side-stepping to keep its place, facing the ball | Live, bots |
| `brake-to-receive.jpg` | A forward braking from 6 m/s as it takes a pass | Live, bots |
| `side-on-stances.jpg` | Two opponents facing each other side-on, stepping sideways | Live, bots |

Nothing here is scripted. The scripted harness (`tests/web/motion_replay.py`
without `--live`) was used only to check the movement while it was built.

## How it was made

1. The page, served exactly as committed, over a real match with the probe
   (`tests/web/motion-probe.mjs`) added to it:

   ```sh
   uv run python tests/web/motion_replay.py --port 8796 --live --ref 553de80
   ```

   For the knock clip, `--home laya,bot` as well (Laya runs locally; no key).
2. Headless Chrome for Testing 151 on an Apple M5 (ANGLE Metal), the page at
   1600 x 900, device pixel ratio 1, vsync on:

   ```sh
   <chrome> --headless=new --remote-debugging-port=9222 --user-data-dir=<new folder> \
     "--screen-info={0,0 1920x1200}" --window-size=1600,1043 \
     --use-angle=metal --enable-gpu --ignore-gpu-blocklist
   ```

3. `node tests/web/motion-record.mjs <folder>` loads the page (a new match
   from kick-off), films every frame with its time while it switches the
   probe's cameras on its default 3 min plan (the wide shot; close-ups that
   follow the player nearest the ball from the side, the front and the
   touchline; two defenders and a goalkeeper keeping their shape), and has
   the probe measure the same frames. The knock clip used one 6 min shot
   following the player nearest the ball, with a second DevTools client
   logging the match's knock touches: 11 knocks, 10 of them with the camera
   on the player who knocked.
4. The frames, put in the order of their times (screencast frames can
   arrive out of order), were cut and encoded with ffmpeg: 30 fps, 1280 x
   720, H.264, two passes at 430 kbps. `motion-match.mp4` is these spans of
   the 3 min recording, in seconds: 2-16, 51-60 and 90-100 (wide shot),
   30.5-49.5 (beside the ball carrier: dribbling and cuts), 70.5-85 (a
   defender keeping its shape), 105.5-125 (in front of the ball carrier: a
   brake to take a pass near 108 s, a lofted pass), 125.8-133 (the home
   goalkeeper) and 150.5-160.5 (from the touchline, two opponents side-on
   near 155 s). Its last 20 s were filmed through a burst of load from other
   work on the machine, so they are left out of the cut.
   `motion-knock-laya.mp4` is 99.5-106, 228.5-236 and 305-313 of its
   recording, chosen clear of such bursts.

## Measured over the full 3 minutes

The probe watches every player's feet in the drawn page. A stance is a run
of frames in which the ball of a foot stays within 2.5 cm of the lowest it
has been; its slip is the foot's median speed over the ground through the
stance, and a stance slides when that is over 20 cm/s, which shows in a
close-up. The engine is seeded, so the "before" run (develop, `84b64a6`:
the human figures of #52 on the #57 engine) played the same match with the
same cameras, recorded right before the "after" run.

| | Before (develop) | After (`553de80`) |
|---|---|---|
| Stances that slide | 81.6% | **15.4%** |
| Median slip | 53.3 cm/s | **0.01 cm/s** |
| 90th percentile slip | 142 cm/s | 72 cm/s |
| Locomotion alone | 81.2% slide | 11.8% |
| Goalkeepers | 69% / 70% | 34% / 28% |

By what the figure was doing through the stance (after): locomotion 6,143
stances, 12% slide; braking 416, 40%; cuts 293, 34-38%; turns on the spot
72, 27-33%; passes and first touches 114, 30-38%; shots 9, 11%; lofted
passes 11, 64%; goalkeeper dives and catches 27, 86-100%.

Lockstep: of the neighbours who moved alike (within 4 m, both faster than
0.8 m/s, velocities within 0.8 m/s) for 300 frames or more, each pair was
within a twentieth of a stride of each other 0-24% of the time (about 10%
by chance; develop 0-32%). Each player moves in its own way: cadence 1.41 to
1.68 strides a second, stride 1.2 to 2.4 m, a forward lean of 4.4 to 9.5
degrees and an arm swing of 0.34 to 0.51 m.

The knock clip's run (6 min, Laya home team): 12.5% of stances slide,
locomotion alone 9.9%.

## Frame rate and cost

Without filming, the page holds 60 fps with vsync on this machine. While
filming, with the screencast running and other work on the machine, the
probe measured the page at 55.9 fps (median 16.7 ms, p99 55 ms; load average
14 to 20) for the after run and 47.6 fps (p99 101 ms; load average 9 to 22)
for the before run. The two differ by when the bursts of load came, not by
the code: per frame, the figures cost about the same CPU time as on develop
(interleaved runs of `tests/web/measure-figures.mjs`: median 0.99-1.01 ms
against 0.94-0.95 ms, p95 3.2-3.5 ms against 2.1-3.0 ms, for 28 figures),
with the same draw calls (366) and triangles.

## Checks at `553de80`

- `uv run pytest`: 184 passed; `node --test tests/web/*.test.mjs`: 153
  passed.
- Rebuilding the figure from `assets/figure/build.py` in a clean copy wrote
  `figure.glb` and `figure.json` byte for byte as committed.
- `figure.glb` is 1,662,928 bytes with 66 clips; a figure is 9,556 to 10,795
  triangles (body 8,988, eyes 280, number 128, hair 160 to 1,399), as before.

## What is not shown, and what still slides

No player shielded the ball while a close-up was on it, so the shield is not
in these files; the page shows it when a player is slow on the ball with an
opponent close behind.

Goalkeepers' dives and catches slide in nearly all their stances, lofted
passes in about two thirds, braking in two fifths, and cuts, turns, passes
and first touches in about a third. Those moments are short; running,
walking, side-stepping and backing off, which is most of a match, are where
the figures hold their feet.
