# Match protocol

The match server streams the match to the page over one WebSocket at `/ws`.
The engine is the source of truth; the page draws what it is sent and
interpolates between snapshots. Every message is one JSON object with a
`type`. This is the renderer protocol; player questions and manager inputs
are described separately in [how decisions work](model-decisions.md).

## Coordinates

Metres. The origin is the centre spot. `x` runs along the pitch's length,
`y` across it and `z` up. In the first half the home team (`team` 0) attacks
towards positive `x`; the teams change ends at half time. Headings are in
radians, anticlockwise from positive `x`. In three.js, match `(x, y, z)` is
drawn at `(x, z, -y)`.

## Server to page

### `hello`

Sent once when the page connects.

```json
{
  "type": "hello",
  "version": 1,
  "pitch": {"length": 105, "width": 68, "goalWidth": 7.32, "goalHeight": 2.44},
  "teams": [
    {
      "name": "Harbour",
      "colours": {"shirt": "#1f5fbf", "shorts": "#ffffff", "keeper": "#f2c230"},
      "manager": "Built-in",
      "assistants": [],
      "players": [
        {"id": 1, "number": 1, "name": "Vale", "position": "GK", "role": "Goalkeeper", "model": "Laya"}
      ]
    }
  ]
}
```

`teams` has the two teams, home (`team` 0) first, each with the eleven who
start in `players` and its substitutes in `bench`, in the same shape. `id` is
unique across both teams; positions are `GK`, `DF`, `MF` or `FW`. `model` is the
player's decision model, or `null` for the built-in bot; a substitute's is
`null` until its manager chooses one. `manager` is the team's manager:
`Built-in`, or the language model's name. `managerEffort` is the actual
configured reasoning effort, or `null` for a built-in manager. `assistants` lists the model of
each assistant helping the team's manager, one entry per assistant (for
example `["gpt-6-astra", "gpt-6-astra"]`); it is empty for the built-in
manager and for a language-model manager with none.

`role` is the readable formation position, such as `Right back` or `Centre back`.
The decisions table shows this role, shirt number and model. Bench players have
a broad role until substituted; each active player's snapshot also includes
`role`, so substitutions and replacement goalkeepers update the display.

### `snapshot`

The state of play, about 30 times a second.

```json
{
  "type": "snapshot",
  "t": 734.2,
  "period": 1,
  "clock": "12:14",
  "phase": "play",
  "score": [1, 0],
  "ball": {"x": 12.4, "y": -3.1, "z": 0.11, "owner": 7,
           "touches": [{"player": 7, "kind": "control", "t": 734.183, "x": 11.8, "y": -3.0, "z": 0.11}]},
  "players": [
    {"id": 7, "role": "Central midfielder", "x": 11.9, "y": -3.0, "heading": 0.3, "speed": 6.2, "action": "move"},
    {"id": 1, "role": "Goalkeeper", "x": -51.2, "y": 1.4, "heading": 1.57, "speed": 4.1, "action": "move", "dive": true}
  ]
}
```

- `t`: match seconds since kick-off; `period`: 1 or 2. `clock`: the match
  clock in minutes and seconds, as `45+01:20` or `90+00:35` in added time.
- `phase`: `kickoff`, `play`, `throw_in`, `goal_kick`, `corner`,
  `free_kick`, `penalty`, `half_time` or `full_time`.
- `ball.owner`: the player in possession, or `null`.
- `ball.held`: while a goalkeeper holds the ball in its hands, the seconds it
  has held it; absent otherwise. At more than eight it concedes a corner.
- `ball.touches`: the touches of the ball in the last 0.1 s, oldest first, or
  `[]`. Each touch is repeated in the snapshots of that tenth of a second, so
  none falls between two snapshots. `player` touched it; `t` is the match time
  of the engine step it happened in; `x`, `y` and `z` are where the ball was
  as that step began, before the touch moved it. A player who takes the ball
  and kicks it in the same step makes one touch, the kick. `kind` is one of:
  `kick` (a pass, through ball, cross, shot or clearance, or the kick that
  takes a restart; these are not told apart), `knock` (a sprinting player
  knocks the ball a few metres ahead to run on to it), `throw` (the kick that
  takes a throw-in),
  `control` (a player takes a loose ball, or a teammate's, in play), `tackle`
  (a player takes the ball from an opponent who has it, in play), `poke` (a
  tackle knocks the ball loose from the opponent who has it), `deflect`
  (the ball comes too fast to control and bounces off the player), `save`
  (such a deflection off the goalkeeper defending the goal the ball is at, in
  its penalty area) and `catch` (that goalkeeper takes the ball in its hands
  in its penalty area, in play; a ball a teammate kicked or threw to it it
  takes with its feet, a `control`). There are no headers:
  outfield players play the ball only up to 0.9 m high.
- `heading`: the way the player faces, in radians anticlockwise from +x. It
  can differ from the way it moves: a player keeping its place faces the
  ball while it side-steps, backs off or moves diagonally.
- `action`: the engine command the player is carrying out: `hold`, `move`,
  `kick`, `tackle` (running in to tackle) or `airkick` (a kick with no ball to
  kick). The decision model's own choice is in `decision` messages.
- `move`: on a player, a movement it makes without the ball, while it lasts:
  `air_kick` (a kick that meets nothing), `stumble` (a missed standing
  tackle) or `slide` (a slide tackle, from going in to stopping); absent
  otherwise.
- `down`: on a player, `{"way": "front" | "back" | "side", "until": T}` while
  it is on the ground or getting up, where `T` is the match time it is back
  on its feet and can play again; absent otherwise. A player goes down when
  it is fouled, after a slide tackle, and when it kicks at nothing at speed
  (docs/decisions.md, sections 4 and 8).
- `dive`: on a player, `true` while it is a goalkeeper diving across its goal
  at a ball heading in (docs/decisions.md, section 2); absent otherwise.
- `players`: only players on the pitch; a substituted or sent-off player
  disappears from it, and a substitute appears in it once it comes on.

### `event`

A moment the page shows, sent when it happens.

```json
{"type": "event", "kind": "goal", "t": 734.2, "team": 0, "player": 9}
```

`kind` is one of the following. `team` is the team that scored or takes the
restart, unless the list says otherwise, and is `null` for `half_time` and
`full_time`.

| `kind` | Extra fields |
|---|---|
| `goal` | `player`: the scorer; for now, the scoring team's player nearest the ball |
| `throw_in`, `goal_kick`, `corner` | none |
| `free_kick` | `indirect`: `true` after offside or a second touch, when a goal cannot be scored from it directly |
| `penalty` | `player`: the taker |
| `foul` | `player`: the offender; `fouled`: the player fouled. `team` is the fouled player's team |
| `offside` | `player`: the player caught offside. `team` is the defending team |
| `second_touch` | `player`: the taker of a restart who touched the ball again before anyone else. `team` is the other team |
| `held` | `player`: the goalkeeper that held the ball for more than eight seconds. `team` is the other team |
| `advantage` | `player`: the player fouled. `team` is its team, which plays on |
| `handball` | `player`: the player the ball struck. `team` is the other team |
| `added_time` | `minutes`: the minutes added to the half. `team` is `null` |
| `yellow`, `red` | `player`: the player shown the card. `team` is that player's team |
| `substitution` | `off` and `on`: the players leaving and joining; `model`: the incoming player's model, or `null` |
| `half_time`, `full_time` | `score`: the score at the whistle, home first, as in the snapshot |

A foul is followed by any card it earns, then the `free_kick` or `penalty`; an
offside or a second touch by its `free_kick`, and a goalkeeper holding the ball
too long by its `corner`. A second yellow card sends `yellow` then `red`. A
sent-off player leaves `players`; if it was the goalkeeper, a teammate takes
over in goal without an event.

### `decision`

One per model answer, for the overlay. Players played by the built-in bot
send none.

```json
{"type": "decision", "player": 7, "model": "Laya", "action": "pass", "ms": 182}
```

A failed answer has `"error"` in place of `"action"`. `ms` is the time from
asking to the answer, including any wait for a local model's turn. `action`
is one of `wait` (stop with possession), `dribble`, `sprint`, `take_on`, `shield`, `pass`, `through_ball`,
`cross`, `shoot`, `clear`, `press`, `tackle`, `slide_tackle`, `jockey`,
`hold`, `support`, `mark` and `run_behind` (see `docs/decisions.md`, section
4). `note`, when present, says the answer came too late for the moment it was
asked about: `"no ball"` (an action on the ball, carried out without it) or
`"already played"` (the player passed, shot or cleared the ball itself before
the answer came, so it holds its place).

### `manager`

A manager's instruction or substitution request, for the overlay. `text` is
ready to show.

```json
{"type": "manager", "team": 0, "kind": "instruction", "player": 7, "text": "Stay wide and wait for the switch."}
{"type": "manager", "team": 0, "kind": "substitution", "off": 8, "on": 26, "model": "laya", "text": "Heath (Laya) to come on for Brook: Faster midfield decisions."}
```

A defending-style change is a team message:

```json
{"type": "manager", "team": 0, "kind": "tactics", "text": "Defending: man-to-man"}
```

Initial instructions and tactics use the same message kinds as later updates.
There is no separate defending field in `hello` or `snapshot`.

An `instruction` is for `player`, on the manager's team and on the pitch. A
`substitution` is asked for here and made at the next stoppage, when its
`substitution` event follows; `model` is the name the model is chosen with
(see the README).

## Page to server

Send `{"type":"pause","paused":true}` to pause this match, or the same
message with `false` to resume. The server acknowledges with the same shape.
While paused, simulation and new model requests stop. Pending answers wait
before application; resuming excludes the paused wall time. Other browser
connections have independent matches.

Manager messages of kind `status` report lineup fallbacks and failed consultations;
their `text` is safe to display like other manager messages.
