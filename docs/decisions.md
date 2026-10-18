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
- **Movement.** A player's facing is separate from the way it goes. A run to
  a point can name a point to keep facing, usually the ball. A player moving
  at up to 4 m/s, or within 60° of it, keeps facing it and side-steps, backs
  off or moves diagonally; the further it faces from the way it goes, the
  slower it can move, down to 4 m/s sideways or backwards. A faster move
  turns the player to run, at its turning rate, and it turns back to the ball
  once it has slowed to 3 m/s. Players keeping
  the team's shape walk or jog by how far their place is: fast enough to get
  there in 2 s, or 1.2 s while the other team has the ball, between 1.5 and
  5 m/s. Chasing the ball, pressing, tackling, running in behind and getting
  back out of place at a restart are run at full speed (7.5 m/s). A
  goalkeeper keeps facing the ball as it moves along its line. Every move off
  the ball used to be a 5 m/s run facing the way the player went, so walks,
  side-steps and backward steps never happened.
- **Dribbling.** A player carrying the ball picks one of five lanes, straight
  on towards their goal or 25° or 50° to either side, by the room that the
  point 6 m along it leaves from the nearest opponent, and keeps its lane
  unless another has clearly more room. It cuts inside or goes wide instead
  of running straight at a defender. The built-in bot dribbles the same way.
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
  jumps of up to 40 m on screen. A goal kick does not wait for every
  opponent to leave the penalty area: it is taken once none is within
  9.15 m of the ball, and one further away that is still leaving may stay,
  as the laws allow an opponent that had no time to leave. Waiting for
  them all kept the goalkeeper on the ball for about 1.9 s after it got
  there; over 32 matches with models answering as Laya does, a goal kick
  now takes 2.9 s from being given to being taken, against 3.8 s (bots
  only: 2.7 s, against 4.1 s). Taking it at once, with an opponent beside
  the ball, would kick it into a player who can still challenge for it.
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
  half the gain. A team takes up these attacking places while it has the
  ball, while it takes a restart, and while the ball is loose after one of
  its players last played it, as during its own pass. Before, every pass
  sent the team back to its defending places until the receiver had the
  ball, and a model answering `hold`, its most common answer, kept its
  defending place even while its team had the ball. Over 32 bot matches,
  goals rose from 0.94 to 1.34 a match and shots from 17.0 to 17.8; over 32
  matches with models answering as Laya does, goals rose from 1.28 to 1.56,
  with shots the same (12.6). Offsides rose from 0.3 to 0.8 and from 0.8 to
  1.8, as forwards stay further up while a pass is on its way. The ball's
  share of play in the middle third (46% with bots, 40% with models) and
  entries into the penalty area (16 and 18 a match) stayed about the same,
  and so did they with each other shape tried, over 24 bot matches: wider
  with the ball and narrower without it (team width 41 m and 34 m, against
  37 m both) cut entries from 16.4 to 13.9 and shots from 17.3 to 12.8;
  forwards waiting on the opponents' offside line, and the bot crossing from
  wide in the final third, moved entries by less than one a match and the
  middle-third share by less than two points. A goalkeeper keeps to its goal
  line, and when a loose ball is heading into its goal it moves across to the ball's line; a model in
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

A model chooses one of seventeen actions, each described to it in a few words,
and is asked only the ones that apply: one set on the ball, one off it, and
one at a restart. Each action that gains something has a downside the engine
plays out, the same for both teams.

| Action | Asked | What the player does until the next answer | Its downside |
|---|---|---|---|
| `dribble` | on the ball | carries the ball at 6 m/s towards their goal, in the lane with the most room (section 2) | slower than a pass |
| `sprint` | on the ball | knocks the ball ahead and runs on to it at full speed, 7.5 m/s, aiming 8 m beyond the rolling ball so it does not brake (in 5 s from a standstill it covers 30 m, a dribble 26 m) | between touches the ball is loose, and a nearby opponent can take it |
| `take_on` | on the ball, an opponent ahead within 10 m | runs at the nearest opponent ahead, then cuts past it diagonally on the side with more room | the defender can take the ball, and running into it is a foul only if it came from behind |
| `shield` | on the ball, an opponent within 5 m | turns its back on the nearest opponent, keeping the ball on the far side, at walking pace, and lays it off to a teammate open within 12 m | slow, and a second opponent can get round |
| `pass` | on the ball, and the taker | passes to the best-placed open teammate, or clears if none is open | |
| `through_ball` | on the ball with a teammate ahead, and the taker | passes into the space ahead of the teammate ahead with the most room, leading its run | it can run too far or be cut out, and the receiver can be offside |
| `cross` | on the ball wide in the final third, and the taker there | lifts the ball into the penalty area, to the teammate there with the most room or the penalty mark | a goalkeeper reaches higher, and there are no headers yet |
| `shoot` | on the ball within 30 m of goal, and the taker of a penalty or a free kick in range | shoots inside the post further from the goalkeeper; from 16 m or more with no opponent within 2.5 m, or from 24 m or more, plays the ball as the built-in bot does (dribbles closer, passes when pressed out of range) | |
| `clear` | on the ball, and the taker | kicks the ball long upfield | |
| `press` | off the ball, unless a teammate has it | runs at the ball at full speed to win it or collect it, coming round a carrier rather than into its back, and goes in with a standing tackle once it is in reach from the front or side (section 8) | a tackle can miss |
| `tackle` | off the ball, while an opponent has it | runs straight at the ball and goes in with a standing tackle as soon as the ball is in reach, from any side (section 8) | a miss leaves it stumbling; from behind, or missing the ball and taking the player, it is a foul, with any card it earns |
| `slide_tackle` | off the ball, an opponent on the ball within 15 m | runs at the ball and slides in from up to 2.5 m away (section 8) | a miss leaves it on the ground for about 1.5 s; from behind it is a foul and a yellow card |
| `jockey` | off the ball, an opponent on the ball within 15 m | backs off facing the carrier, 2.5 m from it between the ball and its own goal, and takes a loose touch it reaches first | it gives ground and does not go in for the ball |
| `hold` | off the ball, and at a restart | keeps its place in the team's shape (a goalkeeper guards its goal) | |
| `support` | off the ball, and at a restart | moves into space ahead to offer a pass | |
| `mark` | off the ball, and at a restart | stays goal-side of the nearest opponent | |
| `run_behind` | off the ball within 20 m of the offside line, and at a restart there | from onside, with a teammate on the ball ready to pass (unpressed and facing upfield), sprints to 6 m beyond the offside line, and goes for the through ball if it reaches it first; beyond the line with no pass played, it checks back; otherwise it keeps its place, no further up than onside | offside, if a teammate kicks the ball while it is beyond the line and it then plays it |

A goalkeeper is asked a smaller set: `pass`, `through_ball` and `clear` on the
ball, `hold` and `press` off it. "Wide in the final third" is at least 14 m from
the centre line and within 36 m of their goal line. The sets keep a model from
answering an action that cannot apply, such as `shoot` without the ball, which
Laya used to answer nearly every time.

The action is turned into an engine command on every physics step, with the
built-in bot's rules for where "its place" is and whom to pass to, so a player
keeps acting sensibly while its next answer is on the way. Once a pass, through
ball, cross, shot or clearance is made, the player holds its place until the
next answer. A sprint's knock ahead is not spent: the player runs on to the
ball and knocks it again.

Each action is carried out as the moment allows, because a model may give the
same answer for a long time: a slow model's answer is seconds old, and a small
model often repeats the action its state says it is doing (Laya repeated its
previous answer in 98% of a recorded match). So a repeated answer still plays
sensible football, the same rules for both teams:

- **On the ball**, an answer for off the ball (`press`, `tackle`,
  `slide_tackle`, `jockey`, `hold`, `support`, `mark` and `run_behind`) keeps
  playing the ball as the built-in bot does (dribble, pass when pressed, shoot
  in range) until the next answer, instead of standing on it. Such an answer
  is not the model's mistake: the player was off the ball when it was asked
  and came to have it, often through the loose-ball rule below. Carried out
  as given, over 16 headless matches with late answers as Laya gives them,
  the ball changed hands by a tackle 108 times a match instead of 43, shots
  fell from 12.6 to 6.0 and fouls rose from 2.0 to 9.2.
- **On the ball**, `shoot` out of range plays the ball as the built-in bot
  does (dribble, pass when pressed), instead of dribbling into a tackle, and
  `shoot` from 16-24 m with no opponent within 2.5 m carries the ball closer
  before shooting, as the bot does. Laya answers `shoot` almost every time;
  with every outfielder answering it, the ball changed hands by a tackle about
  590 times a bot match of two 180 s halves, and now about 16 (bots alone:
  10), with passes made under pressure again.
- **An action that needs a moment that has passed** falls back to the
  nearest one that applies: `take_on` with no opponent ahead within 10 m
  dribbles; `shield` with no opponent within 5 m plays as the bot does;
  `through_ball` with no teammate ahead passes; `cross` from inside carries
  the ball towards the touchline and their goal line until it is wide.
- **A late answer is carried out as given**, so the screen shows what each
  model decided, mistakes included. A model answers about the moment it was
  asked; by the time the answer arrives the player may have lost the ball,
  or won it:
  - A kick (`pass`, `through_ball`, `cross`, `shoot`, `clear`) while another
    player has the ball is a kick at nothing where the player stands. The
    swing takes 0.6 s, in which it cannot play the ball; then it holds its
    place until its next answer. A player that swings at 6 m/s or more loses
    its footing and goes down for 1.5 s more. With the ball loose, the player
    runs at it to kick it, as a kick command does.
  - `dribble`, `take_on` or `shield` while another player has the ball is a
    run to where it would have dribbled, without the ball; with the ball
    loose, it runs at the ball. `sprint` runs at the ball at full speed, as
    `press` does, so a sprinting dribbler runs on to its own knock, and
    chases the ball if an opponent takes it.
  - An answer to a question asked while the player had the ball, arriving
    after the player has itself passed, shot or cleared it, was overtaken by
    its own kick, not by the match: the player holds its place. Without this,
    nearly every kick would be followed by a kick at nothing, because the next
    question is asked as soon as a kick is decided, before it is made.
  - The `decision` message tells the page when an answer is carried out
    without the ball or was overtaken, and the overlay shows it.
- **Off the ball**, a player keeping its place (`hold`, `support`, `mark` or
  `run_behind`) still goes for a loose ball it can reach first, as a player
  keeping its shape collects a ball
  that comes to it; pressing an opponent on the ball stays a choice. Asked
  from these sets in a keyless match of two 90 s halves, Laya answered `hold`
  64% of 1,848 times, `run_behind` 23% (nearly every time it was offered),
  `mark` 9% and `press` 2%. Holding, its players left loose balls that came
  to them, and the ball was loose 65% of play.
- **A goalkeeper** off the ball whose action is `press` or `mark` plays as the
  bot keeper does: it gets across to a shot, comes for a loose ball in its own
  area when it is the nearest, and otherwise keeps its line. Without this, a
  keeper answering `mark` spent 93% of play more than 20 m off its line.
- **At a restart** only the taker goes to the ball. A taker whose action is a
  pass, through ball, cross, shot or clearance takes the restart that way; any
  other action takes it as its bot would, so a model that never chooses a kick
  cannot stall the match. The others keep their places, `run_behind` no
  further up than onside.

Measured on a Laya against Laya match of two 60 s halves, before and after
these rules: three or more teammates within 6 m of the ball fell from 14% of
play to 0.3%, a carrier standing still on the ball from 15% to 1%, and the
free-kick phase from 10% of the match to 2%.

With the fifteen actions, over 32 headless matches of two 180 s halves with
models on the live server's positions answering as Laya does (in range on
the ball mostly `shoot`, otherwise mostly `take_on`), against develop's eight
actions answered as Laya did there: shots 14.2 a match (develop 12.0), goals
1.00 (1.28), the ball loose 52% of play (66%), fouls 2.8 (0.5), offsides 1.4
(0.4), throw-ins 2.7 (4.0), corners 1.4 (1.0). Without the loose-ball rule
above, shots fell to 8.5 and the ball was loose 65% of play. Fouls rise
because `take_on` runs at a defender, which fouls when it cannot reach the
ball; offsides because `run_behind` goes beyond the line before the pass.
With bots only, the movement of section 2 raised shots from 16.3 to 18.9 a
match and goals from 0.69 to 1.00, and cut the ball's loose share from 60% to
53%, fouls from 0.75 to 0.19 and throw-ins from 3.3 to 2.0.

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
> 11 m behind 1 m right. Their last defender 30 m ahead. Manager: Stay wide.
> Your answers take 2.0 s.

The manager line appears once managers can give instructions; the answer time
appears after the player's first answer. The last defender is the opponents'
second-last player, the one that sets the offside line, told to every outfield
player in play so it can judge a run in behind.

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

The stadium uses grass with mowing stripes, regulation pitch markings, netted
goals, stands on all four sides and floodlights built from shared geometry and
materials (see "Real grass and the stands behind the goals" below). Shirt numbers
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

### Full-time result and another match

At full time, the existing lower-third banner stays visible with “Full-time”,
the team names and final score, and one “Play again” button. It uses the same
dark panel, lime accent and typography as the scorebar and decision toggle.
The final snapshot also shows it, so a delayed full-time event cannot leave
an apparently frozen match without its result. Old event banners cannot
replace it. “Play again” reloads the page, which closes the old connection
and starts a fresh match with the server's same models and settings.

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

**Clips.** All 76 clips play on that skeleton, keyed 60 times a second (at 30, a
fast loop had one key between a touch and the landing, and the page's linear
interpolation cut the foot's arc into the grass by up to 13 mm), with the
`root` bone fixed: the engine moves the player, the clip only moves the body
around it. `figure.json` describes each clip: its duration and, for a loop,
the speed and direction of travel it was made for (one of eight: `forward`,
`forward_left`, `left`, `back_left`, `back`, `back_right`, `right`,
`forward_right`) and `duty`, the share of the cycle each foot is on the grass;
a loop's `set` and a dribble loop's `touch`; for a one-shot, the moment of
`contact`; for a turn or a cut, the degrees it turns (`turn`) and the
`turning` window over which the root's facing turns at an even rate; for the
cuts and the brake, `speeds`, the root's speed over clip time that their
planted feet are made for.

- Locomotion loops are one full cycle that starts as the left foot plants and
  plants the right foot halfway, each foot on the grass for `duty` of it; the
  planted foot moves opposite to the clip's direction of travel at exactly the
  clip's speed, so a clip played at the ground speed over its speed (and the
  figure's scale) keeps its feet planted. The run has a walk at 1.4 m/s and a
  jog at 4 m/s (3.6 straight back) in every direction, with `walk`, `jog` and
  `sprint` forwards and `backpedal`. To the side and back on a diagonal the
  pelvis opens towards the travel (about 22, 55 and 80 degrees) and the feet
  step across, the chest half turned and the head on the play, as a player
  keeping its shape while watching the ball does; straight back is a backward
  walk or a backpedal.
- Sets the page plays instead of the run by what a player is doing: the
  dribble, from close control at 2 m/s to the knock-on at 7.5, with shorter,
  quicker strides and the body over the ball, the right toe reaching furthest
  ahead, 0.48 m from the root and 7 cm off the grass, exactly at the loop's
  `touch`, where the page meets the carried ball; jockeying, side-on and low,
  standing or shuffling back and across at 1.2, 2.5 and 2.6 m/s without the
  feet ever passing (the old side shuffles `strafe_L` and `strafe_R` keep
  their names here); shielding, square and wide with the back to the opponent
  and the arms out behind, standing or shuffling at 1 m/s. Each set has a
  standing loop with no speed.
- Idles: `idle`, `idle_shift` (the weight from leg to leg), `idle_hips`
  (hands on the hips) and `idle_look` (a glance over each shoulder).
- Play: `pass`, `pass_lofted`, `shot`, `cross`, `control`, `tackle` (the
  slide), `tackle_standing`, `header`, `throw_in` and `celebrate`, kicked with
  the right foot and meeting the ball where the engine carries it at their
  `contact`. Each is made so that its upper body and kicking leg also work
  alone over a running stride: the support leg carries no part of the action.
- Transitions follow the engine's own movement: they are built from plants on
  the grass and steps between them while the root moves exactly as the
  engine moves a player, so a planted foot stays still for that motion.
  `turn_L` and `turn_R` turn 90 degrees on the spot: both feet pivot on their
  balls while the root turns over the `turning` window, then step round into
  the stance. `cut_L` and `cut_R` are a runner at 4 m/s, the speed most cuts
  are made at in play, turning 60 degrees: the facing turns at the engine's
  rate (9 / (1 + v / 3) rad/s, 0.26 s here) while the travel follows only as
  fast as the runner may accelerate, still 12 degrees off the old line when
  the facing is done; the outside foot plants as the facing starts to turn.
  `brake` is a stop at the engine's 4 m/s² from 7.5 m/s, braking steps
  shortening as it slows, then settling into the stance, so the page joins
  it at the clip time whose speed is the player's.
- Goalkeeper: `keeper_dive_L`, `keeper_dive_R`, `keeper_catch` and
  `keeper_catch_high`.
- Touchline: `instruct`, `change`, `clap`, `protest`, `cheer` and `despair`,
  the gestures the managers already make.

The exported file is made smaller by `assets/figure/compact.py`, which drops
the tracks that hold a bone at rest and the keys interpolating their
neighbours reproduces (within 0.05 degrees or 0.3 mm), and stores rotations as
normalised 16-bit integers, which glTF allows for animation and three.js
reads; no bone moves more than 1.2 mm for it. With every clip above,
`figure.glb` is 1.82 MB (it was 1.6 MB with the first 24 clips and 1.66 MB with
66, and would be over 2 MB without the compaction).

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
instead of sliding; a carried ball keeps time with that phase ("Natural,
individual movement" below says how the page chooses among the loops, sets
and moves). The touches from the contact moments above play their clip so
that its moment of contact lands on the touch: a `kick` plays the shot, pass,
lofted pass or cross by the ball's flight, `control` and `throw` play theirs,
`tackle` and `poke` the standing block, `deflect` plays `control`, and a
`knock` plays no clip. The engine keeps a player moving while it plays the ball, so a
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
and the moment banner sits in the lower left, clear of the scorer. The
managers' name labels are the other way round: they show in the managers'
shots only, sized for those shots at about a quarter of a manager's height.
Sized for the wide shot, they hung at its lower edge over managers still out
of view and stood taller than a manager's head and shoulders in a cutaway.

**Why.** A modelled and animated human reads as a person on a broadcast
camera and in a close-up in a way that articulated boxes cannot, and stride
matched to speed is what removes the hovering. Building the figure from
scripts keeps it original, reviewable and reproducible with one command, while
the saved `.blend` keeps it editable by hand. Recolouring material regions
rather than baking textures keeps kits a run-time choice and the download small.

**Rejected.** A third-party character or motion-capture pack: not original,
and its licence and style would not be ours. Procedural limbs with better
curves: they still slide without clips made for a stride.

### Natural, individual movement

**Choice.** Players move in more ways than one stride, and each in a way of
their own. The engine sends a player's facing separately from where it goes,
so a player keeping its shape walks or jogs while it faces the ball and moves
sideways, backwards or diagonally against that facing, and players turn, cut,
slow down and speed up. The figure has the clips to show it (see "Clips"
above), made with the same rig and build scripts, and the page chooses and
blends them from what each player is doing, read from the snapshot alone: its
speed and acceleration, how fast it turns, the way it travels against the way
it faces, whether it has the ball, the nearest opponent and the touches of the
ball, plus, for a model player, its latest decision. Bots send no decisions,
so nothing depends on them. All of it is presentation: the page never changes
match state, and the draw loop still allocates nothing per frame.

**Direction and speed.** Loops may travel in eight named directions or at any
`angle`. For a travel at any angle the page takes the two loop directions
either side of it and shares them out so that the blended stride points along
the travel; in each direction it blends the two loops either side of the
speed, and it plays the shared phase at the rate that makes that stride cover
the ground at the figure's speed, so the planted foot stays put. Below a
shuffle (0.15 to 0.35 m/s) it steps forwards; slower than its slowest loop it
gives that loop at least a third of the blend, so a slow drift takes fewer,
lifted steps rather than skimming the grass at a walk's cadence. The direction
of travel settles over 4 cm of travel, so a player turning back on itself
steps the new way at once.

**Footwork.** Blending loops whose feet step differently slides: a walk
blended half and half with a side shuffle, which the first version showed at
45 degrees off facing, slid its planted feet 37 to 48 cm a stance. So the
run's side and back-diagonal loops step across with the hips turned, sharing
the forward loops' footwork and timing, and neighbouring directions blend with
6 to 8 cm of slide before the foot lock. Straight back steps backwards, and the
jockey shuffle steps without crossing. Loops whose footwork differs are never
blended part way: blended half and half, walking back and stepping back to the
side slid 66 to 84 cm per stance and the feet collided. Each footwork blends
only its own directions; a figure changes from one to another over 0.15 s once
a direction of the other is nearer its travel by 4 degrees, and the angle the
chosen loop misses the travel by turns the skeleton's hips, the chest and neck
turning back against it, so the stride still runs along the travel. That turn
eases to its target over 0.2 s and stops at 40 degrees, the foot lock taking
up the rest: set at once, it twisted the hips and chest in a single frame
whenever the footwork changed, about twice a second across a live match. Moving
slowly to the side or back (past 70 degrees off its facing, between 0.25 and
1.7 m/s), a figure side-steps in the jockey shuffle instead of a part-blended
crossover walk, which slid 11 to 29 cm per stance; this is what goalkeepers
shuffling along their line do.

**Loop sets.** The dribble plays for the player with the ball. Slow, with an
opponent close behind it (or when a model decided to shield), that player
shields. An opponent of the player on the ball, close (3 to 6 m), facing it
and not closing in, jockeys. Each set cross-fades in over 0.18 s on the shared
phase, its stance standing in for idle, and fills the directions and speeds it
lacks from the run. The carried ball meets the boot at the dribble loops'
touch phase.

**The foot lock.** Blends of loops whose feet move differently still leave a
little slide, and the page's own turns and leans add to it. While a foot is
planted, by the shared phase and each loop's `duty`, the end of its sole that
bears the weight (the heel as it lands, the ball of the foot as it rolls over)
is held where it touched down, and a two-bone IK on the thigh and shin puts the
ankle there, the knee bending its own way and the foot keeping its
orientation. It holds from landing, lets go only once the sole lifts, and gives
way beyond 35 cm and to clips that swing the legs. Under the figure's own moves
(turn, cut, brake) it finds planted feet by the height of the sole instead,
since those clips plant at their own times. A foot in the air keeps its sole at
least 3 cm off the grass at mid-swing. The page's turns of the bones start each
frame from what the clips last gave them, not from the rest pose: three.js's
mixer writes a bone only when its blended value changes, so a reset to rest
outlived a blend that had settled.

**Leaning and moves.** The body leans from the feet towards its smoothed
horizontal acceleration: into a curve, forwards speeding up, back braking
(0.45 of the angle that would balance it, at most 0.2 rad). The figure makes
moves of itself, when `figure.json` has the clips: a turn on the spot when it
turns faster than 2.5 rad/s below 1 m/s, its clip time following the turn
through the clip's `turning` window and beginning again for a longer turn; a
cut when, from 2.5 m/s, its body turns faster than 2.5 rad/s and its run
follows (a body turning to face the ball over a run that keeps its way is no
cut), the clip picked up where the body has got to in its turn and following
it through its window; and a braking step when it slows harder than 2.5 m/s²
travelling the way it faces, its clip time where the clip's `speeds` match the
figure's speed. A brake ends as soon as the figure stops slowing and gives way
to a cut; a turn fades out as the figure sets off. A cut and a brake first made
for a different motion from the engine's slid in most of their stances in a
live match (a cut turning about 6.5 rad/s through its plant, a brake stopping
at about 7 m/s²), which is why both are now made from the engine's own turning
and braking and are timed by what the figure does.

**Plays.** A kick plays the cross, the lofted pass, the shot or the pass from
the ball's flight after the touch: lifted (0.3 rad or more, from how high the
ball has risen against gravity) from a wide attacking place in towards the
middle, the cross; lifted elsewhere, the lofted pass; along the ground, the
shot when it leaves faster than 18 m/s. A model's decision of the last two
seconds says instead (shoot, cross, through ball, clear). A tackle is the
standing block; a slide comes with the player's `move` ("Mishaps" below). Over a run, a kick's kicking
leg follows the clip only from 0.3 s before contact to 0.35 s after, so its
grounded wind-up and landing do not skate. A sprinter's knock plays no clip:
its stride is timed (within -25% to +30% of its pace) so the boot's touch
lands on the knock and on catching the ball up again, a moment the page
predicts from the gap and the closing speed, since the buffer gives only
0.1 s of warning.

**Style.** Each person has its own stride, arm carriage and posture, picked
from its id by integer hashing, so it is the same in every browser and does
not follow its looks: a stride factor between 0.9 and 1.1 shifts where along
the speeds the loops blend (shorter, quicker steps or longer, slower ones; the
rate still comes from the stride, so the feet plant), the arms are held 0.03
to 0.12 rad out and bent up to 0.3 rad more, and the back leans forwards by
-0.02 to 0.08 rad. Each also stands in its own idle variant and changes it
every 6 to 14 s with a cross-fade. Two neighbours running alike within a
twentieth of a stride of each other fall out of step: the later quickens its
stride by 8% for a moment.

**Checking.** Every clip was checked through three.js as the page plays it,
for joins where a loop repeats, knees and elbows bending the wrong way, hands
inside the body, boots below the grass and legs through each other, and in
close-up on the page. That found a toe that snapped 8 degrees at every heel
strike, shins of the back diagonal jogs passing 7 cm apart and the shot's
right hand through its thigh, all fixed. Movement is measured as well as
watched: `tests/web/motion_replay.py` serves the page with a scripted,
protocol-correct feed of every kind of movement, or with `--live` a real
keyless match; `tests/web/motion-probe.mjs` measures in the page how fast each
planted foot slips in each stance, which neighbours step in time, and each
player's cadence, stride, lean and arm swing; and `tests/web/motion-record.mjs`
films the evidence in `docs/media/motion/`, whose README gives the numbers.

**Known limits.** The standing foot under a kick still slips in a share of
its stances; "Mishaps" below gives the numbers after the dive and the lofted
pass were improved.

**Why.** Players read as people when they move as people do: facing the play
while moving across it, changing pace and direction with a plant and a push,
and each with a gait of its own. Making the transitions from the engine's own
movement and holding planted feet with a lock, rather than trusting a blend,
keeps the feet on the grass where the clips and the engine disagree.

**Rejected.** A side shuffle in the run: it cannot blend with a walking step,
and at a jog reads as a drill; it is jockeying footwork, so it went to that
set. Dribbling diagonals: with the ball on the line the player faces, the
touching foot swept 0.3 m sideways in 40 ms to plant; the run's diagonals
stand in. Blending the back and back-diagonal loops in proportion to the angle
(66 to 84 cm of slide per stance), and idle into the hips-turned walk below
walking pace (11 to 29 cm). Locking the ankle rather than the end of the sole
that bears the weight: the heel slides as the foot rolls, worse than no lock
at a walk. Cuts and a brake made at one speed and played faster or slower to
fit: a 6 m/s cut slowed to the 2.5 to 4 m/s most cuts start at plays in slow
motion and its turn cannot match the engine's, and no fixed playback matches
a stop at a different deceleration. A cut on any fast turn of the body at a
run: cuts took 13% of all stances live, half of them sliding.

### Mishaps: kicks at nothing, stumbles, falls and slides

**Choice.** What a player does without the ball when a decision has gone
wrong is shown as the engine carries it out: a kick at nothing, a stumble
after a missed tackle, a slide, and going down and getting up again. The
snapshot says which (a player's `move` and `down`, docs/protocol.md); the
figure has clips made for each with the same rig and scripts as the others,
and the page plays them from those fields alone.

**Clips.** Ten more, 76 in all:

- `air_kick`: a full swing through where the ball should be (`contact`),
  much higher than a shot's, the body leaning back, a hop on the standing
  foot and the arms out before it steadies.
- `stumble`: a toe caught at a run, the body pitching over a short step with
  the arms thrown out, two quick steps and on. Its feet are planted for a
  root running at 5 m/s (`speeds`), so the page plays it at the player's pace.
  `tackle_missed`: a standing lunge that finds nothing, the left foot hopping
  through to catch the weight, then back over its feet.
- `fall_front` (tripped: knees and hands, then the chest, the shins swinging
  up and down), `fall_back` (the feet going from under it, onto its backside
  and back) and `fall_side_L`, `fall_side_R` (shouldered off: a step across,
  down on the hip and shoulder, rolling onto the back). The first ends lying
  face down, the others on the back; a side fall lies across the way the
  player ran, a quarter turn (`turn`) from `fall_back`'s end.
- `get_up_front` (pushing up, onto hands and knees, a foot through and up)
  and `get_up_back` (sitting up, feet in, onto them and up), from those lying
  poses to standing over the root.
- `tackle_L`: the slide on the left boot, `tackle` mirrored. Both slides say
  (`down`) from when the slider is on the grass to when it begins to get up.

Lying, the legs lie straight and the body twists about its own length to
roll over, so the scripts gained two pose channels: an ankle placed at a
point (`f*ax`, `f*ay`, `f*az`, by weight `f*at`) and a twist of the hips
(`htwist`). Both are zero in every earlier clip, which rebuild byte for byte.
Each new clip was checked in Blender for parts below the grass: lying, none;
a knee or a hand dips up to 7 cm into the grass for a frame or two as it lands
(11 cm for the arm a side fall lands on).

**On the page.**

- `move: "air_kick"` plays `air_kick` from the first snapshot that shows it,
  0.15 s into the clip, so the swing goes through about 0.3 s later, within
  the 0.6 s the engine gives it. Over a run only its upper body and kicking
  leg play, as for a kick; slowing, all of it.
- `move: "stumble"` is the miss of a standing tackle: at 2.5 m/s or more the
  `stumble`, its feet held on the grass, more slowly `tackle_missed`.
- `move: "slide"` plays the slide on the boot nearer the ball from going in.
  The engine judges a slide as it goes in, so its `tackle` or `poke` touch
  plays no clip of its own. A `tackle` or `poke` touch without a slide is the
  standing block.
- `down` plays the fall for its `way`, a side fall away from the nearest
  opponent, holds the lying pose and plays the get-up so that the figure is
  on its feet at `until`. With less time than the fall and the get-up take
  (a fouled player is down 1.2 s, against 2 s for the clips) both play
  faster, up to twice. A slide that ends down holds its own lying pose and
  gets up from it: in the engine's 1.5 s from going in, at its own pace.
  After a side fall the figure turns a quarter to get up from its back, which
  matches the side fall's end exactly, and turns back to its heading on its
  feet, at 3 rad/s, which the turn on the spot shows.
- Down or sliding, a figure keeps the facing it went down with, and the
  page's lean, hip turn and carriage give way to a clip that takes the whole
  body, so a body lying on the grass lies as it was made.
- A scripted scene shows each of these as the engine sends it, before or
  without a match: `tests/web/motion_replay.py --mishaps`.

**Planted feet: the dive and the kicks.** Measured with the motion probe on
scripted scenes that repeat the moment (`--mishaps` for a goalkeeper diving
to each side, `--kicks` for one player passing at 0 to 6 m/s along the ground
and lofted, ahead, to the side and behind it), the page as on develop against
this one, 150 s each:

- A dive seen begun, the keeper already moving across, now starts at its
  push-off (0.2 s into the clip), and the foot lock holds whichever sole is on
  the grass until it leaves it (0.36 s) and again as it gets up (from 1.4 s).
  Stances sliding: dive to the left 92.7% to 20%, to the right 98.1% to
  18.2%; median slip 31 to 0.6 cm/s.
- Turning into a lofted pass or a cross, the body pivots on its standing foot
  while that is on the grass, instead of about the engine's position, which
  dragged the planted foot round turns of up to 180 degrees, and comes back
  over the engine's position over 0.3 s, the foot lock holding the feet.
  Stances sliding: lofted pass 48.3% to 39.3%, cross 30.8% to 17.6%.
- A plain pass is drawn as before: pivoting measured no better for it
  (38.9% on develop, 40.6% pivoting), so it is left as it was.

The page ran at 40 to 53 fps through these runs, with other work on the
machine, so the counts are of 11 to 55 stances each.

**Known limits.** Under a plain pass at a run the standing foot still slides
in about 40% of its stances: the stride's standing foot is often in the air
as the body turns into the kick, and the page learns where the ball goes only
about 0.1 s ahead, too late to time the stride. First touches (`control`) slide
in about half of theirs. A side fall's get-up plays across the player's
heading and turns back afterwards. The slide is shown from the moment the
engine judges it, so the ball can leave the carrier's feet before the
slider's boot gets there.

**Why.** A decision that has gone wrong should look like one: a swing at
nothing, a stumble, a player on the grass. Lying and getting up poses shared
between clips let the page hold a player down for as long as the engine
keeps it there, and speeding the clips up rather than cutting them keeps a
short fall a whole fall.

**Rejected.** Get-ups for each side: the side falls roll onto the back, and
turning the figure a quarter lets one get-up serve. Showing a slide's tackle
at its touch: the touch comes as the slide goes in, so the slide would be
rushed through in a tenth of a second. Holding the standing foot for every
kick with the foot lock alone: a turn of 90 degrees carries a foot 0.27 m
from the root nearly 0.4 m, past the lock's reach.

### Real grass and the stands behind the goals

**Choice.** The pitch and its surround are one grass surface drawn by a single
material, built in the page from generated textures, with no photograph or
third-party texture:

- **Turf.** A tileable square metre of turf is generated once: tens of
  thousands of short blades seen from above, each its own shade of green,
  over darker thatch, in clumps of slightly different colour and height. Its
  colour, the height of each blade and a normal map made from those heights
  are sampled at two scales, with a low-frequency variation over tens of
  metres, so no repeat shows from the broadcast camera.
- **Mowing stripes.** Twenty bands across the pitch, as a mower cutting from
  touchline to touchline leaves them: the blades in alternate bands lean
  towards one touchline or the other. A band is lighter where the viewer
  looks the way its blades lean and darker where it looks into them, so the
  stripes are strongest from the main camera, fade as the camera looks along
  them, and swap shade from the opposite side, as on a real pitch. The lean
  also tilts the normal slightly, so the sun picks the bands out too.
- **Light.** The grass is lit with a physically based material, rough and
  non-metallic, so it takes a soft sheen at a grazing angle under the
  floodlights without a plastic shine.
- **Depth near the camera.** Within 10 m of the camera (the close-ups,
  cutaways and managers' shots), the material traces each pixel's view ray
  down through the blades' heights, in eight steps over a turf 3 cm deep, and
  shades the first blade it meets (parallax occlusion). Blades in front hide
  those behind, the tips lean with their band, and deeper in the turf is in
  shade. The depth fades out from 4 m to 10 m, so the wide shot never pays
  for it.
- **Wear.** Goalmouths, penalty spots and the centre spot are lightly worn:
  a patchy, drier and shorter turf.
- **Painted lines.** The markings, including the technical areas, are kept
  as one distance field: each texel holds its distance from the nearest
  painted edge. The grass material paints them into the turf, slightly
  mottled by the blades under the paint, so they read as paint on grass
  rather than strips over it. Each pixel is painted by the share of its
  footprint across the line that the line covers, so a distant line thins
  and fades rather than breaking up. The distance field keeps the edges sharp
  in a close-up at a fraction of the memory a painted texture would need.
- **Stands.** The ends behind the goals have stands like the side stands,
  with the same tiers and seats in the same instanced meshes, so they add no
  draw call. The low wall in front of each stand stays.

The textures are generated in the page as the first match is built and kept
for the next one. The grass is one mesh, in place of the striped turf, the
surround and the painted ribbons, so it saves two draw calls. Measured on an
Apple M5 at 1600 by 900, it adds about 1 ms of GPU time per frame to the wide
shot and 1.5 ms to a close-up at a pixel ratio of 1, and 3 ms to a close-up
at the page's highest pixel ratio of 1.5, where the whole frame takes about
6 ms.

**Why.** Everything else on screen now looks real, so a flat, evenly coloured
pitch was what gave the scene away. Real stripes come from the light caught by
leaning blades, not from paint, so they must change with the angle they are
seen from. A procedural turf keeps the project free of third-party assets.

**Rejected.** Instanced blades: they would need tens of thousands of blades per
square metre to match real turf, and fewer read as sparse. Stacked shells of
turf near the camera: they look much the same, but each pixel is shaded once
per shell, which added 2.4 to 5.7 ms of GPU time to a close-up at a pixel
ratio of 1. A painted line texture over the whole pitch: it would need about
32 million texels for sharp edges close up. Mipmaps of the distance field and
its own screen derivatives for anti-aliasing: averaged distances, and pixels
straddling a line's centre, broke distant lines into dashes.

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
set up in a test and checked.

- **Fouls.** Only a challenge on the player with the ball is judged: a
  tackle, as below, or running into the carrier. An opponent who runs into
  the ball carrier (their discs touch while it runs towards the carrier, and
  the two close on each other, faster than 2 m/s) commits a foul if it came
  from behind the carrier, or if it could not reach the ball. An opponent who
  reaches the ball from the front or side wins it fairly. Both speeds count:
  the closing speed, the opponent's speed towards the carrier less the
  carrier's own speed the same way, as for a tackle, so a defender running
  beside a player at its pace does not run into it by touching it; and the
  opponent's own speed, so a carrier backing into an opponent standing still
  is not fouled by it.
- **Tackles.** A player can go in for the ball an opponent has with a
  standing tackle or a slide, when it can play the ball (not still recovering
  from a kick, a miss or a fall). How each ends follows from where the
  players are and how they move, so a test can set up each outcome:
  - A **standing tackle** goes in once the ball is within 1.2 m of the
    tackler. `tackle` goes in from any side; `press`, and the built-in bot
    pressing, only from the front or side. From behind (more than 120° from
    where the carrier faces) it is a foul. Otherwise it wins the ball if the
    ball will still be within reach 0.25 s later, with both players moving
    as they are: the tackler takes it if it closes on the carrier at 3 m/s
    or less, and pokes it 4 m/s away from the carrier if faster. If the ball
    will be out of reach but the two players would then touch, it took the
    player and not the ball: a foul. Otherwise it misses: the tackler
    stumbles, and cannot play the ball for 0.5 s while the carrier goes on.
  - A **slide tackle** goes in from up to 2.5 m; the built-in bot slides in,
    from the front or side, at a carrier within 25 m of its goal. The tackler slides 0.5 s
    along the grass at where the ball will be, then is on the ground until
    1.5 s after it went in. From behind it is a foul and a yellow card for a
    reckless challenge. Otherwise it wins the ball if the ball will be
    within 2.5 m of the tackler 0.5 s later, poking it 5 m/s on along the
    slide; if the ball will be out of reach but the carrier will not, it
    took the player: a foul. Otherwise it misses.
  - A carrier who loses the ball cannot play it for 0.4 s, so the ball does
    not change hands straight back. A fouled player goes down for 1.2 s:
    forwards if it was fouled from behind, sideways otherwise.
- **Fouls off the ball.** A player that runs into an opponent without the
  ball within 5 m of the ball, from behind it (more than 120° from where it
  faces), running at it and closing on it faster than 4 m/s, fouls it: a direct free kick, or a penalty in the offender's own
  area, with the same cards as a foul on the ball. The fouled player goes
  down. Running into an opponent from the front or side off the ball is
  jostling for position and is not judged. Judged anywhere on the pitch at
  2 m/s, as a foul on the carrier is, players keeping their shape ran into
  each other's backs so often that there were about 27 fouls in a bot match
  of two 180 s halves, against about 1; judged only where the ball is
  contested, there are about 4.
  Judged by the offender's own speed rather than the closing speed, a
  defender tracking a forward's run in behind, both at about 7 m/s, fouled
  it whenever their discs touched: of 16 fouls off the ball in the area over
  48 matches with players answering as Laya does, 11 closed at under 4 m/s,
  most at under 1 m/s, and those matches had 0.58 penalties and 0.29 red
  cards each, about twice what a top-flight match has: 0.23 penalties a game
  in the first half of the 2024-25 Premier League season
  ([Opta Analyst, 7 January 2025](https://theanalyst.com/articles/football-newsletter-penalties-bruno-fernandes))
  and 52 red cards in its 380 matches, 0.14 a game
  ([season statistics](https://extratime.com/stats/2129/2287/premier-league/)).
  With the closing speed and the card rules below, the same matches have
  0.29 penalties and 0.10 red cards. Fouls fall from 7.4 to 2.3 a match and
  stoppages from 20 to 17, so there are fewer penalties and free kicks to
  score from: goals fall from 1.15 to 0.96 a match, while goals from
  penalties fall from 0.50 to 0.21.
- **Handball.** Players are discs with no arms, so handball is judged from
  where the ball meets a player. A loose ball between 0.9 m and 1.7 m off the
  ground that passes within 0.6 m of an outfield player's centre (or a
  goalkeeper's outside its own area) touches its upper body. More than
  0.45 m to the side of the way the player faces, it touches an arm held
  away from the body: handball, a direct free kick or a penalty, unless the
  ball came from within 2 m, too close to react, or from the player's own
  touch. Otherwise it bounces off the body as any deflection does. The
  nearest such player meets the ball, whichever team it is on. Handball
  that stops a ball heading into the goal (between the posts and under the
  bar, as it flies) is a red card; within 27 m of the
  player's own goal it is a yellow card.
- **Advantage.** After a foul outside the offender's penalty area that is
  not a red-card offence, when the ball is in the fouled team's attacking
  half and the nearest player able to play it is on the fouled team, play
  goes on: the referee signals advantage. A teammate in an offside position
  does not count as able to play it. If the opponents win the ball
  within 3 s, play comes back for the free kick, with the card the foul
  earned. Otherwise play goes on, and only a card for a reckless challenge
  is still given, at the next stoppage. While an advantage is played, the
  offender's continued contact with the player it fouled is not judged again,
  and any other foul stops play.
- **Added time.** Each half has time added for time lost: a minute for each
  goal and penalty, and half a minute for each substitution and card, in
  match minutes, rounded up to a whole minute; no time is lost, none is
  added. A match minute is a forty-fifth of the half's length. When the half
  reaches its length the referee shows the added minutes, and the clock runs
  on as 45+ or 90+. Time lost during added time is added on as well, but not
  time lost once the half's time is up, such as a penalty the half waits for. No
  player is injured or wastes time on purpose in the
  engine, so neither adds time.
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
  goal-scoring opportunity is a red card: the fouled player is within 25 m of
  goal, no outfield defender other than the offender is nearer the goal line,
  and it was likely to keep or gain control of the ball, because it had the
  ball or, with the ball loose, no one but the offender was nearer it. A
  player fouled off the ball while a teammate or an opponent has the ball
  was not denied a goal chance. In the offender's own penalty area, a tackle
  (standing or slide) is an attempt to play the ball, and the penalty gives
  back the chance it took, so the card is one lower, as in Law 12 of the
  Laws of the Game: a yellow card for denying an obvious goal-scoring
  opportunity, and no card for stopping a promising attack. Running into a
  player, on or off the ball, is not an attempt to play the ball and keeps
  its card. A slide tackle from behind is a yellow card wherever it is. A
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
- **Restarts.** The player who takes a kick-off, throw-in, goal kick, corner,
  free kick or penalty may not touch the ball again until another player has:
  if it does, the opponents take an indirect free kick there. A goal goes in
  "straight from" a restart when no one has touched the ball since the
  restart was taken. Straight from a throw-in no goal counts: into the
  opponents' goal it is a goal kick, into the thrower's own goal a corner.
  Straight from a kick-off, goal kick, corner or free kick a goal counts only
  against the opponents; into the kicking team's own goal it is a corner. An
  indirect free kick counts against neither goal, as before. A foul throw
  cannot happen in the engine: the ball is placed where it went out and the
  thrower throws it from there, with both hands from behind its head.
- **Goalkeepers' handling.** A goalkeeper handles the ball in its own
  penalty area: it reaches 1.3 m and up to 2.6 m high there, against an
  outfield player's 0.75 m and 0.9 m, and its taking the ball is a catch. A
  ball a teammate deliberately kicked to it (a pass, clearance or kick from a
  restart, not a deflection), or threw to it from a throw-in, it may not
  handle: it plays it with its feet, at an outfield player's reach, as
  if outside its area. The laws give an indirect free kick if it handles
  such a ball; the engine's goalkeeper never does. A goalkeeper holding the
  ball, a catch it has not yet released, for more than eight seconds
  concedes a corner to the opponents, on the side of the pitch it is on.
  Each snapshot tells the page how long it has held it, and the page shows
  the referee's count for the last five seconds.
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
