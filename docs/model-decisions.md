# How decisions work

Decision Pitch separates player choices, team management and football mechanics.
A player model chooses one action at a time. Its manager chooses which models
play and gives tactical guidance. The engine executes the actions and enforces
the match rules. The two teams use the same code and state format.

## One decision, from state to play

1. Build a snapshot of the match from a player's point of view, including the
   action it is already carrying out and the actions currently available.
2. Send that question to the player's selected model. Vision variants also
   receive a newly rendered overhead image.
3. Keep the match running. The previous action continues while the answer is
   pending; its target is recalculated on each physics step.
4. Apply the returned action and record its answer time. Ask the player again
   with the new state. Each player has at most one request in flight.

For example, a midfielder chooses `pass`. The action layer selects an open
teammate, leads the receiver's movement and calculates kick power. Physics
moves the ball; an opponent may intercept it. The model has chosen to pass,
but has not named the recipient, chosen the exact trajectory or guaranteed
completion. A new answer may arrive after possession has changed.

## What a player sees

Every question contains:

- Identity, shirt number, team, score, half, clock and phase of play.
- Its formation role, such as right back or centre forward; its location,
  speed, distance to goal, base position, recovery target and support target.
- The ball's relative position, possession, and whether a loose ball is moving
  or in the air.
- All active teammates and opponents, named and numbered, with relative
  positions. Teammates with room are marked as open.
- The nearest available outfield teammate to the ball and other teammates
  currently pressing or challenging, excluding fallen or animation-locked players.
- The manager's defending approach and latest instruction; a marking assignment
  for an outfielder in man-to-man defending when an opponent can be assigned.
- Its current action and latest answer time, plus a description of each
  action offered in this situation.

Directions are relative to the team's attack: ahead means towards the opposing
goal. The same transformation applies after the teams change ends. Vision
variants get this text plus an overhead image with names, shirt numbers, team
colours, movement arrows and a yellow ring labelled YOU. Their team always
attacks right in that image. They do not see the broadcast camera image.

## What a player chooses

The response is one action name. Availability depends on possession, role,
restart duties and nearby players. Goalkeepers have a smaller action set.

| Situation | Actions | What shared code supplies |
|---|---|---|
| Keep or carry possession | `wait`, `dribble`, `sprint`, `take_on`, `shield` | Stopping, dribble lane, knock-on, nearest defender to beat, shielding direction and nearby layoff |
| Release the ball | `pass`, `through_ball`, `cross`, `shoot`, `clear` | Recipient or target, lead distance, power, loft and execution |
| Defend or collect | `press`, `tackle`, `slide_tackle`, `jockey` | Approach, interception point, tackling movement or distance from the carrier |
| Position without the ball | `hold`, `support`, `mark`, `run_behind` | Recovery/support position, opponent to track or timed run beyond the defence |

`wait` means stop with possession; opponents can still tackle and goalkeeper
handling limits still apply. `hold` means recover the team's shape, which often
requires movement. A goalkeeper holding shape guards the goal. The engine can
also collect a loose ball with the best-placed player while it holds shape.

The action name is an intent with shared execution rules. For instance, `shoot`
may carry the ball closer or pass when out of range; `shield` may lay it off when
a nearby teammate becomes free. At a restart, the engine selects the taker,
keeps others at legal distances and supplies a legal restart behavior if the
retained action cannot take it. Throw-ins include a two-second preparation
pause after collection for readable animation, not because the laws require it.

The [action reference](decisions.md#the-action-set-and-the-state-text) describes
each option, its availability, execution and downside.

## What a manager decides

Each team has its own allowed model pool, set with `--home` or `--away`.
Managers can only select from that pool. Both start with the same fixed 4-4-2
slots and substitution rules. A manager cannot add actions, alter physics,
redesign the formation or directly issue movement commands.

Before kick-off, an LLM manager returns:

- One model assignment for each of its eleven starting players.
- `zonal` or `man_to_man` defending.
- Short starting instructions for individual players.

The lineup prompt asks for deliberate positional choices and a mix of available
model families, including a valid image variant when available. This is guidance
to the manager, not a guarantee that every lineup contains every model.

During play, it can return:

- A new instruction for any of its active players. Each is reduced to one line
  of about 80 characters and replaces the previous instruction.
- A defending-style change.
- Substitution requests naming the outgoing player, an available bench player,
  the incoming player's model and a short reason. Empty request lists are valid.

The engine checks substitutions when requested and performs accepted ones at
the next stoppage: at most five players in three stoppages, with half time not
counting as a stoppage window. The replacement inherits the formation slot and
the outgoing player's instruction when it enters. Its model only begins asking
for actions once it is on the pitch. This is a football substitution, not an
unlimited way to swap a running player's model.

In zonal defending, prompts ask players to protect their formation area and
cover a teammate pressing. In man-to-man defending, shared code assigns distinct
opponents to outfield players using proximity to formation areas; `mark` tracks
the assigned opponent goal-side. Assignments are recalculated as players move
or leave. The player still chooses whether to mark, press, hold or do something
else from its available actions. Instructions influence its next question;
they do not force the model to obey.

## What managers and assistants see

Before lineup selection, the manager receives its players' roles and positional
context, the allowed catalog, and fresh off-pitch model samples. During play,
its feed includes:

- Clock, score, phase, possession and significant events since the previous
  consultation, including refused advice. Routine throw-ins, goal kicks and
  free kicks are omitted from the event summary.
- Its own players' assignments, actions, instructions, cards, answer counts,
  recent median latency, failures and individual football performance.
- Team and player possession, territory, ball contacts and other observed
  contributions, plus model-level summaries of players it has fielded.
- Aggregate opponent performance; opponent model assignments, instructions
  and individual statistics are hidden.
- Bench availability, substitutions used, stoppage windows and pending requests.
- The full allowed text/image catalog with current probe validity, latency,
  sample count and sample age.

One candidate sample is one off-pitch decision question per model, per team,
before lineup and each LLM consultation. Candidates for that team answer the
same player-state question; image variants also receive its overhead image.
These answers do not control the match. A probe has a six-second deadline after
dispatch; local queueing and pause are outside that deadline. Probes measure
availability and response speed, not football ability.

With `--assistants 1`, an assistant comments on model speed and failures. With
`--assistants 2`, a second comments on the run of play. They receive the manager's
feed, run concurrently before an in-match manager request and contribute short
notes. They do not choose the lineup, issue instructions or make substitutions
on their own. Failed assistant requests are omitted; the manager still decides.

The built-in manager is the default and uses no LLM. It selects models from
historical latency estimates, allowing for shared local queues; substitutes
for repeated failures, bookings or slow answers on its schedule; and gives
simple late-game instructions. It defaults to zonal defending. Built-in player
bots remain internal test fixtures and are not CLI player options.

## Timing, failures and fair comparisons

The authoritative server advances physics at 60 steps per second and sends
about 30 snapshots per second. Player requests run independently of those
steps. Each manager is first due at 30 match-seconds, then 30 match-seconds
after its previous consultation completes. Match statistics accumulate
continuously, but the manager receives snapshots at consultations, not a live
stream into an ongoing LLM request. Lineup selection finishes before kickoff;
in-match consultations do not stop play.

A local model handles one queued request at a time for its team. Each team has
its own local process, so the other team does not take its queue slots. API
models can serve concurrent player requests, subject to provider limits.
Player latency includes local queue wait; candidate-probe latency measures the
dispatched call. These are different measurements.

An unsuccessful player request leaves the existing action in place, reports an
error and waits half a second before asking again. Late answers are visible:
an action for possession may arrive after the ball is lost; a completed kick
is not repeated just because its delayed answer arrives. Shared rules handle
these cases, including recovery or a kick at nothing for some stale actions.

A failed or incomplete manager lineup is filled using the built-in manager's
selection from the same allowed pool. A failed consultation changes nothing.
Invalid instructions and illegal substitutions are refused or ignored. The
inspection panel reports fallbacks and failed consultations. OpenAI managers
use the Codex CLI's ChatGPT login and never switch to API billing on failure.

For a comparison, give both teams the same pool and manager settings, inspect
errors and rate limits, and repeat matches. Faster answers mean more chances
to reconsider, not automatically better football. Shared heuristics, model
choices, hardware, queueing, provider load and stochastic replies all contribute
to the result. A fixed engine seed alone does not reproduce a live-model match.
Kicks include passes, shots and clearances; they are not completed-pass counts.
Individual goals are omitted from manager statistics because scorer attribution
is approximate. The [README](../README.md#current-limits) lists current gameplay
limits and the implementation status of each law.

## Follow it in the code

| File | Responsibility |
|---|---|
| [`actions.py`](../src/decision_pitch/actions.py) | Player state, action choices, targeting and tactical context |
| [`players.py`](../src/decision_pitch/players.py) | Model catalog, per-player request loops, queueing and latency |
| [`managers.py`](../src/decision_pitch/managers.py) | Prompts, schemas, manager feed, instructions and substitutions |
| [`telemetry.py`](../src/decision_pitch/telemetry.py), [`performance.py`](../src/decision_pitch/performance.py) | Candidate probes and observed football statistics |
| [`subscription.py`](../src/decision_pitch/subscription.py) | Subscription transport for OpenAI managers |
| [`match.py`](../src/decision_pitch/match.py), [`physics.py`](../src/decision_pitch/physics.py) | Laws, clock, ball and player simulation |
| [`server.py`](../src/decision_pitch/server.py), [`web/src/`](../src/decision_pitch/web/src/) | Local server, match stream and 3D presentation |

The [wire protocol](protocol.md) describes renderer messages. The
[design record](decisions.md) explains the implementation choices and alternatives.
