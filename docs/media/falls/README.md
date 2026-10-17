# Kicks at nothing, stumbles, falls and slides: what they look like

Evidence for issue #65: the figures' new clips as the page plays them from the
snapshot's `move` and `down` (docs/decisions.md, "Mishaps").

| File | What it shows | Source |
|---|---|---|
| `slide-live.jpg` | A defender sliding in at the player on the ball | Live, keyless match, the built-in bots on both teams |
| `slide-down-live.jpg` | The slider on the grass in its slide, before it gets up | Live, bots |
| `air-kick.jpg` | A kick at nothing at a run: the swing, the body leaning back | Scripted feed |
| `tripped.jpg` | A player tripped at a run going down on its knees and hands | Scripted feed |
| `shouldered-off.jpg` | A player shouldered off by an opponent alongside, going down to its side | Scripted feed |
| `getting-up.jpg` | Getting up from its back | Scripted feed |
| `falls.mp4` | 32 s: the live slide (5 s), then the scripted feed from the side: a kick at nothing, a kick at nothing at a sprint that ends on the ground, a trip and a player shouldered off, each getting up, and a stumble | Both |

The scripted feed is `tests/web/motion_replay.py --mishaps`, which sends what
the engine sends for these moments; it was used where a live match would need
many minutes to show one close up, and for the kick at nothing, which comes
from a decision model's late answer and never from the built-in bots. The live
match is `motion_replay.py --live`.

Filmed in headless Chrome for Testing on an Apple M5 at 1600 x 900, the
probe's camera following the player (`?view=follow:ID&side=side`), with the
DevTools screencast, then cropped to 1280 x 720 and encoded with ffmpeg at
30 fps (H.264, CRF 27).
