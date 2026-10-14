# The human figures on the page

Captures of the page at 1280×720 for the change that draws players and managers
as human figures made in Blender (docs/decisions.md, section 6).

| File | What it shows |
|---|---|
| `match-seed0-goal.mp4` | 68 s of a bot match on the wide shot: a throw-in, open play, half-time and the second half, then a goal, the scorer's close-up and the managers' reaction. |
| `wide-open-play.jpg` | Open play on the wide shot, near the penalty area. |
| `restart-goal-kick.jpg` | A goal kick being taken. |
| `goal-close-up.jpg` | The scorer's close-up after the goal. |
| `manager-cutaway.jpg` | The managers reacting to the goal on the touchline. |

## How they were made

The match is the one every page connection plays with the built-in bots
(`uv run decision-pitch --home bot --away bot --half-length 100`). Its first
goal comes about 125 s after the page connects. The server's messages for that
match were recorded as they arrived, then replayed into the real page in a
headless Chrome. The page's clock moved exactly 1/30 s per frame, each frame
received the messages that had arrived by then and was drawn, and every frame
was saved as a screenshot of the page, its overlay included. The video is
therefore an even 30 frames a second whatever the machine's speed. It says
nothing about the frame rate on a laptop, which was measured live in Chrome
(60 fps on an Apple M5 laptop).

The video is H.264 at about 430 kbit/s to keep it small. The stills are taken
from the uncompressed frames.
