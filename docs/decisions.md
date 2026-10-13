# Decisions

Stack and design choices for Decision Pitch, with the reason for each and the
alternative it replaced. Newest last. A decision is recorded here before it is
implemented, and changed here when the implementation teaches us otherwise.

## 1. Stack: a Python match server and a three.js page

**Choice.** One Python package (Python 3.12 or newer, managed with
[uv](https://docs.astral.sh/uv/)) runs the match, the decision models and the
managers. A [Starlette](https://www.starlette.io/) server serves the page and
streams the match to it over one WebSocket bound to `127.0.0.1`. The page is
plain ES modules with [three.js](https://threejs.org/) vendored at a pinned
version, with no bundler and no build step, so it works offline. Tests use
pytest. Everything starts with one command:

```bash
uv run decision-pitch
```

**Why.** This is the stack Decision Arena uses, so its model adapters and
local model launcher carry over with little change (section 3), and API keys
stay in the Python process and never reach the browser.

**Rejected.** A Node or TypeScript server: the adapters would have to be
rewritten, which the brief rules out.

## 2. The engine runs on the server; the page only draws

**Choice.** The match (physics, rules, clock, score) runs in Python as an
authoritative simulation with a fixed 60 Hz physics step. The server sends
snapshots to the page, which interpolates between them and draws the scene.
The engine runs headless as well: a whole match can be played and checked in
a test or from the command line without a browser.

- **Pitch and physics.** The pitch is a flat 105 m × 68 m rectangle.
  Players move in two dimensions as discs with a top speed, acceleration and
  turning rate. The ball moves in three: it rolls with friction, flies with
  gravity and simple drag, and bounces off the ground and the goal frame.
  This is enough for passes, lofted balls, shots, saves and the ball going
  out of play, and keeps the engine small enough to test fully.
- **Rules.** The laws are implemented in stages, each with tests: kick-off,
  ball out of play, throw-ins, goal kicks, corners, goals, fouls and free
  kicks, offside, yellow and red cards, two halves and substitutions. Until a
  law is implemented, the README's rule table lists it as not implemented
  yet; play never skips it silently.
- **Commands.** The engine is driven by one command per player, which lasts
  until it is replaced: hold, run to a point, or kick the ball towards a
  point. A player told to kick runs to the ball and kicks it as soon as it
  can play it. The decision layer turns each model's action into a command.
- **Possession.** The nearest player within reach of a low ball has it and
  carries it as it runs. A goalkeeper reaches further and higher in its own
  penalty area. Kicks get a small aim error that grows with their power,
  from a seeded random generator, so a match can be replayed exactly.
- **Restarts.** The engine holds opponents at the required distance from the
  ball until it is played, and only the restarting team can play it. After
  a goal the players walk back for the kick-off; anyone not in place after
  5 s is moved there, so a model that never walks back cannot stall the
  match.
- **Built-in bot.** Simple rules (keep shape, chase the ball, dribble, pass
  to an open teammate, shoot in range) that play any position, so a full
  match runs with no model at all.
- **Fairness.** Both teams run through the same code with the same physics.
  Each player's state is built by one function, mirrored for the team
  attacking the other way, so neither side gets a different view.

**Why.** Rules and physics are the hard part, and Python tests make them
cheap to check exhaustively. The decision models and managers already live in
the server, so the state they see and the state that is drawn come from one
place. Headless matches also let us compare models without recording video.

**Rejected.** Running the engine in the browser, as Decision Arena does with
its runner engine: there it was inherited, here it would put the rules where
they are hardest to test, and send every one of 22 players' questions back
through the page.

## 3. Decision models: Decision Arena's adapters, copied with attribution

**Choice.** Decision Arena's model adapters (`apis.py`) and local model
launcher (`local.py`) are copied into this package, unchanged except where
noted, with Decision Arena's MIT licence notice kept beside them and the
commit they came from recorded in the file header. The one planned change:
the set of allowed moves becomes a parameter instead of the runner's fixed
five, so the adapters validate soccer actions.

- **Players.** Laya (local), Jev, GPT-6 Luna Decisions, Perplexity Decider,
  Clef and Decision Arena's other registered models, plus built-in bots.
  Keys come from the environment only, under the same variable names Decision
  Arena uses, so one `.env` serves both projects.
- **Keyless by default.** With no keys set, Laya and the built-in bots play
  a full match. Models whose keys are missing are not offered.
- **Tests** use fake models and `httpx.MockTransport` recordings, as Decision
  Arena's do. No test calls a paid API.

**Why.** Decision Arena's adapters are small and depend only on its
`Question` and `Answer` types, but they validate against the runner's move
list, and the brief keeps that repository read-only. A copy lets this project
make the one change it needs today without waiting for a shared package.

**Rejected.** A git dependency on Decision Arena: it would install the whole
runner game and still validate runner moves. A shared package extracted from
both projects is the better long-term shape; it is proposed to Decision
Arena's maintainer once this project's needs are known, not built first.

## 4. Real time, with no turns

**Choice.** Decision Arena's timing approach, moved from the page to the
server. Each player has its own loop: build the player's state, ask its model,
apply the answer as soon as it arrives, ask again. Every player has at most
one question in flight. While it waits, the player keeps doing what it was
last told, and the match never waits for anyone. Each answer's latency is
measured around the model call, and each player is told its own recent
answer time in its state, as in Decision Arena. A failed answer waits 0.5 s
before the next question.

A player's answer is one action from a small fixed set (for example: go to
the ball, hold position, support the attack, mark, tackle, dribble, pass,
shoot), each described in words in the question. The engine turns the action
into movement and a target, such as which teammate to pass to, using simple
rules that are the same for both teams. The exact action set and state text
are decided in the decision-model issue and recorded here.

**Why.** A fixed decision tick would make slow models nearly unable to act
and fast models wait; letting each model act as often as it can answer is the
story the game tells.

**Rejected.** A shared decision tick for all 22 players.

### The action set and the state text

A model chooses one of eight actions, each described to it in a few words:

| Action | What the player does until the next answer |
|---|---|
| `press` | runs at the ball to win it or collect it |
| `hold` | keeps its place in the team's shape (a goalkeeper guards its goal) |
| `support` | moves into space ahead to offer a pass |
| `mark` | stays goal-side of the nearest opponent |
| `dribble` | runs with the ball towards the opponents' goal |
| `pass` | passes to the best-placed open teammate, or clears if none is open |
| `shoot` | shoots inside the post further from the goalkeeper |
| `clear` | kicks the ball long upfield |

Dribble, pass, shoot and clear need the ball: without it the player runs to
the ball first. The action is turned into an engine command on every physics
step, with the built-in bot's rules for where "its place" is and whom to pass
to, so a player keeps acting sensibly while its next answer is on the way.
Once a pass, shot or clearance is made, the player holds its place until the
next answer. At a restart only the taker goes to the ball; if the taker has
not taken it after 8 s, its bot takes it, so a model that never chooses a
kick cannot stall the match.

The state is short, because a local model answers a shorter question faster
(Laya: about 0.2 s for 300 characters, 0.5 s for 700). It is told from the
player's own side: "ahead" is towards the goal it attacks and "left" is as it
faces that goal, so both teams read the same text for the same situation. For
example:

> You are Brook (8), a Harbour midfielder. 05:00, 1st half, Harbour 0-0 Ridge.
> Play is on. You: 9 m into your half, 5 m left of centre, 2 m/s, doing
> support; their goal 62 m. Ball: 2 m behind 8 m right, loose, 12 m/s.
> Teammates: Finch 3 m behind 9 m right; Pike 9 m ahead 3 m right; Ash 2 m
> ahead 13 m left open. Opponents: Drake 9 m right; Cliff 10 m ahead; Frost
> 11 m behind 1 m right. Manager: Stay wide. Your answers take 2.0 s.

The manager line appears once managers can give instructions; the answer time
appears after the player's first answer.

### Local models answer one question at a time

Measured on the development machine (a 10-core Apple Silicon laptop), one Laya
server answering 22 players who all ask at once managed about 2 answers a
second, with answers queued past the 5 s timeout. Given one question at a
time, the same server answers about 4 a second; two servers about 7.6; four
no more than two. So a local model's questions are queued in the order they
are asked and sent one at a time, and each team that chooses a local model
gets its own server, so neither team's players wait behind the other's. A
player's answer time includes its wait in that queue, because that is how long
it waits for its decision. With Laya on all 22 players, each player decided
about every 2 s (1,274 answers in a match of two 60 s halves); in a short
match against Jev, Jev's players answered in a median 0.33 s and Laya's in
1.0 s.

### Choosing models and checking keys

For now a whole team plays one model, chosen with `--home` and `--away`
(`bot` by default); the managers will choose a model per position. Keys are
read from the environment, or from `.env` in the current folder as Decision
Arena reads them; a variable set in the shell wins. At startup every API
model whose key is set is asked one short question, and one that does not
answer is reported with the key to check and is not offered.

## 5. Managers

**Choice.** A manager interface with two implementations:

- **A built-in manager**, with no model, picks a line-up from the models'
  stated characteristics, and makes substitutions by simple rules. It is the
  keyless default.
- **A language-model manager** does the same through an LLM, with optional
  assistant models feeding it summaries. It receives a continuous text feed
  of the match (score, clock, events and each player's model, decisions and
  latency), and answers with instructions to individual players or
  substitutions, applied within the substitution rules. Instructions reach a
  player as one line in that player's state.

**Why.** The match must run with no keys, and a manager behind an interface
lets an LLM manager and the built-in one be compared under the same rules.
Which LLM providers are supported, and how often a manager is consulted, is
decided in the managers issue; any run that spends beyond the keys already
configured waits for the maintainer's go-ahead with its expected cost.

## 6. Look and feel

**Choice.** A three.js scene of the pitch, stadium and players, built
procedurally in code so it needs no third-party assets: low-poly players in
each team's colour with names and numbers, a broadcast camera that follows
play, and clear moments for goals, fouls and cards. A toggle shows each
player's model, latest decision and latency, and the managers' instructions
and substitutions; hidden, the screen is just the match. Kits, names and
crests are invented; no club, league, player or tournament is used.

The graphic elements are built by a backbone swarm of Codex `gpt-6-astra`
members, against the snapshot format the engine publishes, after its issue is
written. Its output goes through the usual review and merge rules.

## 7. References and licences

Prefer original work. Open-source soccer simulators may be studied for rules
and physics. Every project studied or reused is listed below with its licence
and where it informed or entered this code, and any reused code or assets keep
their notices.

| Project | Licence | Studied or reused | Where |
|---|---|---|---|
| [Decision Arena](https://github.com/eandualem/decision-arena) | MIT | Reused: model adapters and local model launcher (section 3); timing approach (section 4) | `src/decision_pitch/arena/`, copied from commit 770bb4a |
