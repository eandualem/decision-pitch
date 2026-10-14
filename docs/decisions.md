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
  passer. Within 6 m of a moving ball, the chaser aims 3 m beyond its
  meeting spot, so it arrives at full speed; running to the spot itself, it
  slowed to stop there while the ball rolled on, and ran alongside it for
  seconds. Over 32 matches with the live model mix this cut loose spells of
  4 s or more from 11.0 to 7.2 a match and throw-ins from 5.8 to 4.1, and
  raised shots from 12.4 to 12.9 and goals from 1.34 to 1.59. Running beyond
  the spot at any distance made those spells longer (12.2 a match). A player on the ball dribbles until an opponent is within 2.5 m,
  then passes. Measured over 16 bot matches of two 180 s halves, these two
  rules raised shots from 3.1 to 6.5 a match and goals from 0.6 to 2.7, with
  throw-ins unchanged. A check that no opponent could cut a pass out on its
  way was tried and left out: more passes went out of play and fewer attacks
  reached a shot. A pass is aimed where its receiver will be when the ball
  gets there (its velocity times the ball's travel time), not where it stood
  when the ball was kicked: over 64 bot matches, passes reaching a teammate
  rose from 42% to 64%, shots from 4.7 to 13.1 a match and goals from 0.6 to
  1.5, and throw-ins fell from 11.5 to 5.2. A player's place in the team's
  shape moves with the ball by 0.9 of the ball's move along the pitch, and
  an outfield player's place stays at least 8 m from its own goal line. At
  half the ball's move, as first built, the midfielders trailed an attack and
  the forwards stood marked on the opponents' back line, so 64% of passes in
  the final third went backwards. Over 32 matches with models answering as
  Laya does, shots rose from 7.9 to 12.8 a match and corners from 0.25 to
  0.72; over 24 bot matches, possession spells that reached shooting range
  rose from 20% to 32%. Following the ball more only while in possession gave
  half the gain. A goalkeeper keeps to its goal line, and when a loose ball
  is heading into its goal it moves across to the ball's line; a model in
  goal that holds or supports does the same. Over the same 16 matches, this
  cut the share of shots scored from 35% to 16% (goals from 2.8 to 1.1 a
  match), and from 41% to 9% (11 to 3.6 goals) with every outfield player
  answering `shoot`, as Laya mostly does. A keeper in its own area with a
  loose ball heading into its goal (within 0.5 m of a post) dives: it goes
  straight across without turning first, still facing the play, and
  accelerates at 8 m/s² instead of 4. Running and turning, it was beaten by
  a shot from 18 m before it got across: over 32 matches with models
  answering as Laya does, 28% of shots from 16-20 m and 15% from 20-24 m
  scored, now 11% and 3.5% (goals from 3.1 to 1.6 a match). A larger reach
  gave similar numbers but would show the ball stopping short of the keeper;
  12 m/s² saved nearly every shot from outside 12 m. An outfield player on
  the ball shoots within 16 m of goal, about the edge of the penalty area,
  or within 24 m when an opponent is within 2.5 m; with nobody that close it
  dribbles on first. Shooting the moment it came within 24 m, as first
  built, put most shots at 20-24 m, where a diving keeper saves nearly all
  of them. Over 64 matches with models answering as Laya does, shots from
  20-24 m fell from 7.6 to 4.0 a match and those from 12-16 m rose from 1.7
  to 4.7, with shots in all about the same (13.0 and 12.8); corners rose
  from 0.5 to 1.0 and goals only from 1.2 to 1.3. Over 64 bot matches, shots
  from 20-24 m fell from 10.4 to 5.2 and those from 12-16 m rose from 2.9 to
  6.2, with goals unchanged (0.9). Carrying the ball to 18 m moved the long
  shots to 16-20 m instead.
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
| `shoot` | shoots inside the post further from the goalkeeper; from 16 m or more with no opponent within 2.5 m, or from 24 m or more, plays the ball as the built-in bot does (dribbles closer, passes when pressed out of range) |
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
  of standing on it. So does `shoot` out of range, instead of dribbling into
  a tackle, and `shoot` from 16-24 m with no opponent within 2.5 m, which
  carries the ball closer before shooting, as the bot does. Laya answers
  `shoot` almost every time; with every outfielder answering it, the ball
  changed hands by a tackle about 590 times a bot match of two 180 s halves,
  and now about 16 (bots alone: 10), with passes made under pressure again.
- **Off the ball**, `dribble`, `pass`, `shoot` and `clear` play as the
  built-in bot does: the one player who can reach the ball first goes for it
  and the others keep their places, instead of every one of them running at it.
- **A goalkeeper** off the ball whose action is `press` or `mark` plays as the
  bot keeper does: it gets across to a shot, comes for a loose ball in its own
  area when it is the nearest, and otherwise keeps its line. Without this, a
  keeper answering `mark` spent 93% of play more than 20 m off its line.
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
- **Claude as the manager.** `--home-manager anthropic` (or
  `anthropic:MODEL`) asks Claude on Anthropic's Messages API instead, through
  the official `anthropic` Python SDK, with the same briefs, feed and schemas:
  the answer is held to the schema by structured outputs
  (`output_config.format`), at low effort. The model is `claude-haiku-5-5`
  unless another is named, and assistants use `claude-haiku-5-5` too. The key
  is `ANTHROPIC_API_KEY`, from the environment or `.env` only, and is never
  logged or shown; an error is reported by its HTTP status, as for OpenAI.

**Why.** A fixed interval keeps an LLM manager's cost known in advance
(about 25 consultations a team in a match of two three-minute halves) while
it still sees each phase of play. A JSON schema makes every answer parseable
without retries. OpenAI and Anthropic each need only their own request
function behind the same interface. Claude Haiku 5.5 is the default for its
low price ($0.10 and $0.50 per million input and output tokens), so a test
match costs a few cents; a larger model can be named for a real match.

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
stands and floodlights built from shared geometry and materials. Shirt numbers
are drawn into canvas textures using the system font. Keepers use the supplied
keeper colour. Players and managers are human figures made in Blender, with
animation clips, and the ball is drawn at its real size (see "Human figures
made in Blender" below; this replaces the first version's box bodies and
enlarged ball). No external fonts are needed.

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

### Managers on the touchline, smooth motion and contact

**Managers.** Each team's manager stands in a technical area on the touchline
nearest the broadcast camera, beside the halfway line: home to its left, away
to its right, and they stay there after half time. A touchline module builds
each manager as a low-poly figure in a coat of the team's shirt colour with a
name label, walks it along its area to follow the ball and turns it towards
play. It gestures when its team's `manager` message arrives (pointing towards
the player it instructs, or signalling a change when it asks for a
substitution) and when the `substitution` event is made, celebrates its team's
goals and holds its head at the other team's. The `hello` message lists each
team's assistant models; one assistant figure stands behind the manager per
assistant model, and none when there are none. There is no crowd. The wide
shot stays on the match, so the managers are in it when play comes near their
touchline. (It kept its size here; the human figures below changed it.) While the ball is dead the camera cuts
briefly to a manager: after the scorer's close-up, at a card, at a
substitution, at half time and full time, when a manager gives advice
during a stoppage and, at most about once in 25 seconds, at a goal kick,
corner or free kick. The half-time shot lasts the whole break, so the second
half's line-up is placed out of view and the wide shot comes back on it as it
kicks off. Throw-ins are taken too quickly for a cut, in about a
second, so nothing cuts away at one. It never cuts away during open play.

**Buffered interpolation.** The page renders a fixed delay, about 100 ms,
behind the newest snapshot instead of chasing the last two. A timeline module
maps the server's `t` to the page's clock with an offset that absorbs uneven
arrival, keeps a short buffer of snapshots and samples the pair that brackets
the render time. The offset follows the least-delayed arrivals of the last
half second and the server's measured drift, so a server running slower than
real time, as a loaded laptop with a local model may, is followed without
held frames. It never interpolates across a change of period or a clock that
goes back. It does blend play into a restart and a restart into play, so play
does not hitch as it stops: a restart puts players right by at most 0.2 m, and
a player who jumps more than 8 m, or a ball placed more than 10 m away, stays
put until the drawn match reaches the snapshot that places it and is then drawn
there at once, never swept across the pitch; the score bar likewise shows the
snapshot the drawn match has reached, so a goal's ball leaves the goalmouth and
its score changes at the goal's moment. It holds the last state when the
buffer runs dry and drops the backlog after a stall; an event left behind by a
stall only updates the records, the overlay and which team takes the next
throw-in. Events carry `t` and are released on the same
timeline, so a goal banner, a celebration or a contact pose appears when the
drawn ball gets there. `decision` and `manager` messages stay immediate.
Animation runs on the browser's frame timestamp, and the draw loop allocates
nothing per frame.

**The ball and contact.** While a player has the ball, the page draws it at
that player's drawn feet, where the engine carries it, so it cannot slide or
jump against them. The ball spins with the distance it travels and keeps its
height from the engine, so it sits on the grass and arcs as sent. The snapshot
carries the touches of the ball in the last moment, with who made each, what
kind it was and when, read from state the engine records where the touch
happens; it changes no rule or physics. A list rather than only the latest
touch keeps a kick that is blocked within the same snapshot interval from
losing its swing. The page plays the matching pose at that moment: a leg swing
for a kick, first touch or tackle, a throw, and a dive or reach for a
goalkeeper's save or catch, without restarting a pose when two close players
trade the ball. Seeing a touch in the buffer before it is drawn gives each
pose a short wind-up. Only kinds the engine can tell apart are sent: a pass
and a shot are both a kick, and a goalkeeper taking a teammate's slow ball in
its area is a catch. Headers are not implemented: the engine lets outfield
players play the ball only up to 0.9 m, so there is no header to show yet.

Two engine properties are handled in the drawing only. A kick leaves in any
direction relative to the kicker's heading (a median 84 degrees off it in bot
matches, and backwards almost half the time), so the kicker turns into the
kick during the wind-up and a carried ball turns with it. A goalkeeper diving
or saving often faces away from the ball, so it turns to face the ball and
leans and reaches across that facing.

The delay costs a tenth of a second of latency, which nobody watching can see,
and buys motion that stays even when the connection does not. Drawing from the
engine's touches rather than guessing from the ball's path keeps the page a
renderer of the match, not a second engine.

### Human figures made in Blender

**Choice.** Players, goalkeepers, managers and assistants are one original
human figure, modelled, rigged and animated by Python scripts run in Blender
5.2 headless, exported as glTF binary and drawn with three.js's `GLTFLoader`.
Every person on screen is a clone of the same skinned mesh on the same
skeleton, playing the same clips; kits, skin, hair and build are set per
figure at run time. The ball is drawn at the engine's 0.11 m radius.

**Source and build.** The scripts and the saved `.blend` live in
`assets/figure/`: `rig.py` (the skeleton), `body.py` (the body, clothing
regions, coat and variations, modelled as smooth signed-distance shapes in
`shapes.py` and meshed with the helpers in `meshes.py`), `hair.py` (hair styles
and brows), `clips.py` (the animation), `render.py` (stills for checking the
figure) and `build.py`, which runs them in order and exports. Its README says
how to restyle the figure. One command rebuilds everything:

```sh
/Applications/Blender.app/Contents/MacOS/Blender --background --factory-startup --python assets/figure/build.py
```

It writes `assets/figure/figure.blend` and `src/decision_pitch/web/figures/figure.glb`
with `figure.json` beside it, which describes the clips for the page. The
scripts are the source of truth: a full rebuild regenerates the `.blend`. A
person who restyles the figure by hand in the `.blend` exports it with the same
script's export-only mode, which leaves the `.blend` as it is, and carries the
change into the scripts if it should survive the next rebuild. A rebuild
gives the same `.glb` and `figure.json` byte for byte, and the `.blend` the same
content (Blender gives some internal ids random values). No
third-party model, motion capture, texture or asset pack is used; colours are
plain materials, so the `.glb` stays small.

**The figure.** Metres, natural adult proportions, 1.80 m tall at scale 1 with
the soles at the origin, facing Blender's −Y, so it faces +z in the page like
the bodies before it. About 10,000 triangles with hair. The page scales a
figure uniformly between 1.70 and 1.95 m. A simple modelled face (brow, nose,
ears, eyes and mouth) holds up in the close-up after a goal; the body is
modelled and reduced on one side and mirrored, so it is symmetric. Shape keys,
exported as morph targets, vary build and face; six hair meshes (shaved,
buzz, short, curly, swept and tied back), one shown per figure, vary the hair,
and each carries the brows; the page picks skin tone, hair colour, hair style,
build and height from each player's id, so a player looks the same in every
browser and the 22 do not look repeated.

**Clothing as material regions.** The body's surface is split into named
material slots that the page recolours per team and per figure: `skin` (head
and neck), `shirt` (torso and upper arms), `sleeve` (forearms), `hands`,
`shorts`, `legs` (between shorts and socks), `socks` and `boots`, plus `hair`
and one fixed `eyes` material, on its own small mesh, which also draws the
mouth's line. A short-sleeved outfield kit paints `sleeve` and
`legs` with the skin tone; a goalkeeper's long sleeves and gloves paint
`sleeve` with the keeper colour and `hands` with a glove colour. A manager wears
a separate mesh over the same body, a hip-length zip-up track jacket with a
stand collar over straight track trousers, whose `coat`, `trousers` and `trim`
(collar and zip) materials the page paints in the team's colour, a dark neutral
and a light contrast; an assistant wears a tracksuit painted on the body's
regions. Socks take the shirt colour, since the snapshot sends
shirt, shorts and keeper colours. The shirt number is a small skinned panel on
the back, with its own material, that the page maps with the number's canvas
texture. In Blender each region is an ordinary material, so restyling a kit or
an outfit is editing a material or a mesh.

**The skeleton.** One armature whose bone names have no dots, since three.js
drops dots from animation track names: `root`, `hips`, `spine`, `chest`,
`neck`, `head`, and `shoulder`, `upper_arm`, `forearm`, `hand`, `thigh`,
`shin`, `foot` and `toe`, each with `_L` and `_R`. `_L` is always the figure's
own left: Blender's +X, and the page's local +x before the figure turns. The
same holds for clip names: `strafe_L` steps and `keeper_dive_L` dives to the
figure's left.

**Clips.** All clips play on that skeleton, keyed at 30 frames per second,
with the `root` bone fixed: the engine moves the player, the clip only moves
the body around it. `figure.json` lists each clip's duration and, for a loop,
the speed and direction of travel (forward, back, left or right) it was made
for, `idle` having none, or, for a one-shot, the moment of contact.

- Locomotion loops: `idle`, `walk`, `jog`, `sprint`, `backpedal`,
  `strafe_L` and `strafe_R`. Each is one full cycle that starts as the left
  foot plants and plants the right foot halfway, and the planted foot moves
  opposite to the clip's direction of travel at exactly the clip's speed, so a
  clip played at the ground speed over its speed (and the figure's scale)
  keeps its feet planted.
- Play: `pass`, `shot`, `control`, `tackle`, `header`, `throw_in` and
  `celebrate`, kicked with the right foot. Each is made so that its upper
  body and kicking leg also work alone over a running stride: the support leg
  carries no part of the action.
- Goalkeeper: `keeper_dive_L`, `keeper_dive_R`, `keeper_catch` and
  `keeper_catch_high`.
- Touchline: `instruct`, `change`, `clap`, `protest`, `cheer` and `despair`,
  the gestures the managers already make.

**On the page.** `GLTFLoader`, with `SkeletonUtils` for cloning skinned meshes
and the `BufferGeometryUtils` it imports, is vendored from three.js 0.186.0
under `vendor/three/addons/` with its notice. The page loads the figure once,
before the first match is built, and clones it per player and per touchline
figure; geometry and clips are shared, and materials are shared per team and
per skin or hair tone. Each figure has an animation mixer. The snapshot sends a
player's heading and speed but not the direction it travels, so the page takes
travel from the drawn positions, smoothed, and ignores it only below about
0.3 m/s: a player slowing to turn often moves well off its heading at a walk.
Locomotion blends the loops by ground speed and by the direction of travel
against the way the figure faces, with all loops on one shared phase, and
plays them at the rate that matches the stride to the speed, so feet plant
instead of sliding; a carried ball keeps time with that phase. The touches
from the contact moments above play their clip so that its moment of contact
lands on the touch: `kick` plays `shot` when the ball leaves fast and `pass`
otherwise, `control`, `tackle` and `throw` play theirs, and `deflect` plays
`control`. The engine keeps a player moving while it plays the ball, so a
player above a walking pace plays only the clip's upper body and kicking leg
over its running stride; the whole clip plays only near standstill, except
the tackle, a slide that the engine carries along the grass. A carried ball is
met by the boot at its back, not its centre, and during a throw-in the taker
holds the ball in its hands until the clip releases it, where the engine has it
at its feet: presentation only, like the carried ball. A
goalkeeper starts its dive, to its left or right by its travel against its
facing, when the snapshot first marks it diving, whether or not it reaches the
ball; a `save` or `catch` then times the dive's full stretch to the touch, and
a catch with no dive plays `keeper_catch` or `keeper_catch_high` by the ball's
height. Goals play `celebrate`; managers play their gesture clips on the upper
body over their walk. The ball keeps its contrast and its shadow to stay
readable on the broadcast camera at its real size. The engine is unchanged:
headers stay unplayed until the engine has them, and the `header` clip is ready
for that.

**A broadcast wide shot.** The wide shot now frames play like a broadcast main
camera: it looks 22 degrees down from about 72 m through a 22 degree vertical
lens, showing about 50 m of pitch across, instead of looking 40 degrees down
from about 83 m through 40 degrees, which showed most of the pitch. From the
old shot a 1280×720 recording drew a player about 17 pixels tall, seen mostly
from above, and the real-size ball as a dot of two or three pixels, so the
figures and the ball this section adds could not be read; now a player near
the frame's centre is about 43 pixels tall, seen more from the side, and the
ball about 6. The frame follows the ball and leads it by a fraction of a
second of its velocity, so a long pass's receiver comes into view early, and
it keeps the ball, and at a restart the taker, inside the frame. Replaying
three recorded bot matches through the old and new camera, the ball stayed
in frame in every frame of open play and every restart, and every receiver
of a pass longer than 25 m was in view at least half a second before the ball
arrived. Measured against the narrower frame, pans are faster than before
(95th percentile 0.20 against 0.075 frame widths a second), while over the
ground the frame moves as fast as it did; they ease in and out. The managers'
cutaways keep their 40 degree lens.

**The scorer's close-up.** After a goal the camera cuts in to the scorer, 7 m
away and a little below eye height through a 30 degree lens, so the scorer
fills about half the frame's height and the face can be seen; it eases in,
follows the scorer for the close-up's 3.8 s and cuts away as before. It picks a
side in front of the scorer where possible, swinging round, or cutting to the
reverse angle, when the scorer turns, and only from places that stay on the
pitch, outside the goals and nets and clear of every other player and of the
line of sight. Across twelve goals in recorded bot matches the scorer stayed
in frame throughout, the camera never entered a player, a goal or the stands,
and it filmed the scorer's front most of the time. The numbers above the
players show on the wide shot only, never in the close-up or a manager shot,
and the moment banner sits in the lower left, clear of the scorer.

**Why.** A modelled and animated human reads as a person on a broadcast
camera and in a close-up in a way that articulated boxes cannot, and stride
matched to speed is what removes the hovering. Building the figure from
scripts keeps it original, reviewable and reproducible with one command, while
the saved `.blend` keeps it editable by hand. Recolouring material regions
rather than baking textures keeps kits a run-time choice and the download small.

**Rejected.** A third-party character or motion-capture pack: not original,
and its licence and style would not be ours. Procedural limbs with better
curves: they still slide without clips made for a stride.

## 7. References and licences

Prefer original work. Open-source soccer simulators may be studied for rules
and physics. Every project studied or reused is listed below with its licence
and where it informed or entered this code, and any reused code or assets keep
their notices.

| Project | Licence | Studied or reused | Where |
|---|---|---|---|
| [Decision Arena](https://github.com/eandualem/decision-arena) | MIT | Reused: model adapters and local model launcher (section 3); timing approach (section 4) | `src/decision_pitch/arena/`, copied from commit 770bb4a |
| [three.js](https://threejs.org/) 0.186.0 addons: `GLTFLoader`, `SkeletonUtils`, `BufferGeometryUtils` | MIT | Reused unchanged, with notice | `src/decision_pitch/web/vendor/three/addons/` |

The human figure, its skeleton, clothing and animation are original work,
made for this project by the scripts in `assets/figure/` in Blender 5.2. No
third-party model, motion capture, texture or asset pack is used.

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
