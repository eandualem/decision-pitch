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
- **Restarts.** Only the restarting team can play the ball, and opponents
  keep the required distance from it until it is played. A player out of
  place (inside that distance, at a kick-off in the wrong half, or at a
  penalty inside the area or ahead of the mark) runs back
  at full speed whatever its command, as the laws ask, and the restart waits
  for it; one only a few centimetres out, as when it walks up to the line,
  is put right at once. Anyone still out of place after 10 s at a kick-off,
  or 5 s at another restart, is moved there, so nothing can stall the match.
  Moving players straight to their place, as the engine first did, showed as
  jumps of up to 40 m on screen.
- **Built-in bot.** Simple rules (keep shape, chase the ball, dribble, pass
  to an open teammate, shoot in range) that play any position, so a full
  match runs with no model at all. A loose ball is chased by the one player
  of each team who can reach its path first, judged along the next 3 s of the
  ball's flight, so a pass is met by its receiver rather than chased by its
  passer. A player on the ball dribbles until an opponent is within 2.5 m,
  then passes. Measured over 16 bot matches of two 180 s halves, these two
  rules raised shots from 3.1 to 6.5 a match and goals from 0.6 to 2.7, with
  throw-ins unchanged. A check that no opponent could cut a pass out on its
  way was tried and left out: more passes went out of play and fewer attacks
  reached a shot. A goalkeeper keeps to its goal line, and when a loose ball
  is heading into its goal it moves across to the ball's line; a model in
  goal that holds or supports does the same. Over the same 16 matches, this
  cut the share of shots scored from 35% to 16% (goals from 2.8 to 1.1 a
  match), and from 41% to 9% (11 to 3.6 goals) with every outfield player
  answering `shoot`, as Laya mostly does.
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
| `press` | runs at the ball to win it or collect it; supports a teammate who has it |
| `hold` | keeps its place in the team's shape (a goalkeeper guards its goal) |
| `support` | moves into space ahead to offer a pass |
| `mark` | stays goal-side of the nearest opponent |
| `dribble` | runs with the ball towards the opponents' goal |
| `pass` | passes to the best-placed open teammate, or clears if none is open |
| `shoot` | shoots inside the post further from the goalkeeper; from 24 m or more, dribbles into range first |
| `clear` | kicks the ball long upfield |

The action is turned into an engine command on every physics step, with the
built-in bot's rules for where "its place" is and whom to pass to, so a player
keeps acting sensibly while its next answer is on the way. Once a pass, shot or
clearance is made, the player holds its place until the next answer.

Each action is carried out as the moment allows, because a model may give the
same answer for a long time: a slow model's answer is seconds old, and a small
model often repeats the action its state says it is doing (Laya repeated its
previous answer in 98% of a recorded match). So a repeated answer still plays
sensible football, the same rules for both teams:

- **On the ball**, `press`, `hold`, `support` and `mark` keep playing it as
  the built-in bot does (dribble, pass when pressed, shoot in range), instead
  of standing on it.
- **Off the ball**, `dribble`, `pass`, `shoot` and `clear` play as the
  built-in bot does: the one player who can reach the ball first goes for it
  and the others keep their places, instead of every one of them running at it.
- **At a restart** only the taker goes to the ball. A taker whose action is a
  pass, shot or clearance takes the restart that way; any other action takes
  it as its bot would, so a model that never chooses a kick cannot stall the
  match.

Measured on a Laya against Laya match of two 60 s halves, before and after
these rules: three or more teammates within 6 m of the ball fell from 14% of
play to 0.3%, a carrier standing still on the ball from 15% to 1%, and the
free-kick phase from 10% of the match to 2%.

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

### How a manager works

- **The choice of models.** `--home` and `--away` now name the models each
  team's manager may choose from, separated by commas (`bot` by default).
  One name still means the whole team plays that model. Each model is
  described to the manager by its stated characteristics: where it runs,
  whether it answers one question at a time for the whole team, and its
  typical answer time, measured in this project
  (warm, one question at a time: Laya 0.2 s, Jev 0.3 s, Aplomb 0.3 s, GPT-6
  Luna Decisions 0.33 s, Clef 0.4 s, Perplexity Decider 0.42 s; d1-3B and
  the AI Gateway models are not measured yet).
- **Line-up.** Before kick-off the manager is told its players and the
  models, and names a model for each of its eleven. The match waits for it,
  so the page's first frame already shows every player's model.
- **Consultations.** During the match the manager is consulted every 15 s of
  play (real time in a live match), one consultation at a time: the next one
  starts 15 s after the previous answer was applied, so a slow manager is
  consulted less often, as a slow player is. It is not consulted at half
  time or after full time. A headless match with only bots and built-in
  managers runs as fast as it can, consulting on the same match clock.
- **The feed.** Each consultation gets the match from the team's own side, in
  plain text: clock, half, score and phase; possession so far; the events
  since its last consultation (goals, fouls, cards, offsides, corners,
  penalties, substitutions and half time; throw-ins, goal kicks and free
  kicks are left out, as too many to read) and any advice that was refused,
  with why; each player on the pitch, named by its id, with its position,
  model, answers and median answer time over its last ten answers, failed
  answers, current action and instruction; the bench; substitutions and
  stoppages used and any substitution waiting for a stoppage; and the models
  it may choose from.
- **Advice.** A manager answers with instructions and substitution requests.
  An instruction is one line of up to 80 characters for one of its players
  on the pitch; it replaces that player's previous instruction and appears
  in the player's state as "Manager: ...". A substitution names the player
  leaving, the substitute and the substitute's model. It is checked against
  the substitution rules (section 8) when it is asked for and made at the
  next stoppage; the substitute's model starts asking once it is on. Advice
  that breaks a rule, or names a player or model the manager does not have,
  is dropped and does not stop the rest. Both are shown in the overlay as
  `manager` messages.
- **Built-in manager.** Line-up: forwards first, then midfielders,
  defenders and the goalkeeper, each player gets the model with the shortest
  expected answer time, where a model that answers one question at a time is
  expected to take its typical time once for every teammate already on it.
  Substitutions, like for like at the same position: a player whose model
  failed three of its last five answers is replaced at once; from the 60th
  minute, a player on a yellow card is replaced; and at its first
  consultation after each of the 55th, 65th and 75th minutes, the starting
  outfield player with the slowest answers (the forwards first when all
  answer equally) is replaced, early enough that a stoppage usually follows to
  make it in. The bot is chosen only when no model is
  offered, or every model is expected to take longer than 1.5 s. Instructions: from the 70th
  minute, a losing team's forwards are told to shoot when they can and a
  winning team's defenders to hold their shape and clear danger.
- **Language-model manager.** OpenAI's Chat Completions API, with the
  answer constrained to a JSON schema, model `gpt-5.4-mini` unless another
  is named (`--home-manager openai:MODEL`). The key is `OPENAI_API_KEY`, from
  the environment or `.env` only, and is never logged or shown; an error is
  reported by its HTTP status. Each assistant model (`--assistants N`, by
  default none, model `gpt-5.4-nano`) gets the same feed with its own brief
  (one watches the decision models' answers and failures, the next the run
  of play) and returns a short note; the notes reach the manager in the same
  consultation. The schema lists the manager's own player ids and models, so
  an answer cannot name anyone else's. A failed line-up falls back to the
  built-in manager's, and a failed consultation changes nothing. Recorded on
  14 October 2026: a consultation took 2 to 5 s and 800 to 1,400 tokens.

**Why.** A fixed interval keeps an LLM manager's cost known in advance
(about 25 consultations a team in a match of two three-minute halves) while
it still sees each phase of play. A JSON schema makes every answer parseable
without retries. OpenAI is the one language-model provider whose key is
configured here; another provider is one more request function behind the
same interface.

**Rejected.** Consulting the manager at every event: goals and cards come in
bursts, and a manager that lags behind them would be asked again before it
answered. Replacing a player's model without a substitution: the brief puts
model changes within the substitution rules.

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

### Procedural broadcast presentation

The page is split into stadium, players (including the ball), camera, moments
and overlay ES modules, with one entry point owning the WebSocket and render
loop. Each module disposes its scene objects, textures and listeners when a new
hello resets the match. Match coordinates map to `(x, z, -y)` in the scene.

The stadium uses striped grass, regulation pitch markings, netted goals,
stands and floodlights built from shared geometry and materials. Player bodies
are articulated low-poly meshes; shirt numbers are drawn into canvas textures
using the system font. Keepers use the supplied keeper colour. Running and
kicking poses follow snapshot speed and action; celebrations follow goal events.
The ball is slightly enlarged for broadcast readability, with a ground shadow.
No additional external assets, fonts or three.js addons are needed.

Rendering interpolates the last two snapshots one snapshot behind the server,
with reusable lookup data rather than allocating maps during every frame.
Players absent from the current snapshot are hidden. A damped broadcast camera
tracks play and briefly frames the scorer after a goal. Score, clock and event
moments remain visible; the optional decision panel shows model answers and
latencies, manager instructions and substitutions. It opens with O or a button.
The page accepts the protocol's planned events without inventing match state.

This keeps the engine authoritative and the page usable offline, while shared
geometry, capped pixel density and one shadow-casting light limit GPU work for
smooth laptop recording. It replaces the scaffold's cylinders and fixed camera.

## 7. References and licences

Prefer original work. Open-source soccer simulators may be studied for rules
and physics. Every project studied or reused is listed below with its licence
and where it informed or entered this code, and any reused code or assets keep
their notices.

| Project | Licence | Studied or reused | Where |
|---|---|---|---|
| [Decision Arena](https://github.com/eandualem/decision-arena) | MIT | Reused: model adapters and local model launcher (section 3); timing approach (section 4) | `src/decision_pitch/arena/`, copied from commit 770bb4a |

## 8. The laws: fouls, offside, cards and substitutions

**Choice.** The remaining laws are judged by the engine from what it already
simulates, by fixed rules that are the same for both teams, so each call can be
set up in a test and checked. Every foul stops play: there is no advantage.

- **Fouls.** Only a challenge on the player with the ball is judged. An
  opponent who runs into the ball carrier (their discs touch while it moves
  towards the carrier faster than 2 m/s) commits a foul if it came from behind
  the carrier, or if it could not reach the ball. An opponent who reaches the
  ball from the front or side wins it fairly.
- **Free kicks and penalties.** The fouled team takes a free kick where the
  foul happened, after a pause of 1.5 s, with opponents held 9.15 m from the
  ball; within 32 m of its goal, the defending team's three nearest outfield
  players line up as a wall 9.15 m away. A foul in the offender's own penalty
  area is a penalty: the fouled player takes it from the penalty mark, the
  defending goalkeeper stays on its goal line and everyone else waits outside
  the penalty area and arc, behind the mark, until the kick. A half does not
  end until a penalty awarded in it has been taken and its ball has been
  played, gone out or come to rest.
- **Offside.** When a player kicks the ball, every teammate in the opponents'
  half that is nearer their goal line than both the ball and the second-last
  opponent is in an offside position. If one of them is the next player to
  reach the ball, it is offside: the opponents take an indirect free kick
  there, from which a goal cannot be scored directly. Anyone else reaching the
  ball first ends it. No offside is judged from a throw-in, goal kick or
  corner. Interfering with an opponent without playing the ball is not judged.
- **Cards.** A foul that stops a promising attack (the carrier within 27 m of
  the goal it attacks) is a yellow card. A foul that denies an obvious
  goal-scoring opportunity (the carrier within 25 m of goal with no outfield
  defender other than the offender nearer the goal line) is a red card. A
  second yellow is a red. A sent-off player leaves the pitch; if it was the
  goalkeeper, the teammate nearest its own goal goes in goal. A team reduced
  below seven players ends the match.
- **Substitutions.** Each team has seven substitutes on the bench and may make
  up to five substitutions in at most three stoppages, with half time not
  counted. A substitution is requested at any time and made at the next
  stoppage (any restart or half time): the incoming player takes the outgoing
  player's place and position, and is played by the built-in bot until a
  manager chooses its model. A substituted or sent-off player cannot return,
  and a sent-off player cannot be replaced.
- **Saves and deflections.** A loose ball that comes at a player faster than
  18 m/s, relative to the player, bounces off it instead of being taken. A
  goalkeeper that reaches a ball faster than 10 m/s only at full stretch (the
  ball's path passes more than an outfield player's 0.75 m reach from its
  centre) parries it instead of catching it. The ball leaves outwards from
  where it touched the player, at 40% of its speed, keeping 30% of its speed
  along the body. The player cannot play it again for 0.25 s and is the last to
  have touched it, so a parry or block over its own goal line is a corner. For
  offside, a deflection counts as the deflecting player playing the ball for
  its teammates, and leaves the opponents' offside positions as they were,
  since a deflection or save is not deliberate play.

**Why.** Geometry the engine already has (positions, headings, speeds and who
has the ball) is enough for calls that look right on screen and that a test can
reproduce exactly. A random foul chance would make each call harder to test
and to explain.

**Rejected.** A referee model that judges fouls from the snapshot stream: it
would add a model call to every challenge and make the laws depend on a
model's latency, which is the variable the game is about.
