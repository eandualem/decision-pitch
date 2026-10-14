# Match protocol

The match server streams the match to the page over one WebSocket at `/ws`.
The engine is the source of truth; the page draws what it is sent and
interpolates between snapshots. Every message is one JSON object with a
`type`. Messages marked *planned* are defined here so the engine, the
decision layer and the graphics can be built against them; the server sends
them once the work that produces them lands.

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
        {"id": 1, "number": 1, "name": "Vale", "position": "GK", "model": "Laya"}
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
`Built-in`, or the language model's name. `assistants` lists the model of
each assistant helping the team's manager, one entry per assistant (for
example `["gpt-5.4-nano", "gpt-5.4-nano"]`); it is empty for the built-in
manager and for a language-model manager with none.

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
  "ball": {"x": 12.4, "y": -3.1, "z": 0.11, "owner": 7},
  "players": [
    {"id": 7, "x": 11.9, "y": -3.0, "heading": 0.3, "speed": 6.2, "action": "move"}
  ]
}
```

- `t`: match seconds since kick-off; `period`: 1 or 2.
- `phase`: `kickoff`, `play`, `throw_in`, `goal_kick`, `corner`,
  `free_kick`, `penalty`, `half_time` or `full_time`.
- `ball.owner`: the player in possession, or `null`.
- `action`: the engine command the player is carrying out: `hold`, `move` or
  `kick`. The decision model's own choice is in `decision` messages.
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
| `free_kick` | `indirect`: `true` after offside, when a goal cannot be scored from it directly |
| `penalty` | `player`: the taker |
| `foul` | `player`: the offender; `fouled`: the player fouled. `team` is the fouled player's team |
| `offside` | `player`: the player caught offside. `team` is the defending team |
| `yellow`, `red` | `player`: the player shown the card. `team` is that player's team |
| `substitution` | `off` and `on`: the players leaving and joining; `model`: the incoming player's model, or `null` |
| `half_time`, `full_time` | none |

A foul is followed by any card it earns, then the `free_kick` or `penalty`; an
offside by its `free_kick`. A second yellow card sends `yellow` then `red`. A
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
is one of `press`, `hold`, `support`, `mark`, `dribble`, `pass`, `shoot` and
`clear` (see `docs/decisions.md`, section 4).

### `manager`

A manager's instruction or substitution request, for the overlay. `text` is
ready to show.

```json
{"type": "manager", "team": 0, "kind": "instruction", "player": 7, "text": "Stay wide and wait for the switch."}
{"type": "manager", "team": 0, "kind": "substitution", "off": 8, "on": 26, "model": "laya", "text": "Heath (Laya) to come on for Brook: Faster midfield decisions."}
```

An `instruction` is for `player`, on the manager's team and on the pitch. A
`substitution` is asked for here and made at the next stoppage, when its
`substitution` event follows; `model` is the name the model is chosen with
(see the README), or `bot`.

## Page to server

Nothing yet. The page only listens.
