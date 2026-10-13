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
      "players": [
        {"id": 1, "number": 1, "name": "Vale", "position": "GK", "model": "Laya"}
      ]
    }
  ]
}
```

`teams` has the two teams, home (`team` 0) first. `id` is unique across both
teams; positions are `GK`, `DF`, `MF` or `FW`. `model` is the player's decision
model, or `null` for the built-in bot.

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
  `half_time` or `full_time`; `free_kick` and `penalty` are planned.
- `ball.owner`: the player in possession, or `null`.
- `action`: the engine command the player is carrying out: `hold`, `move` or
  `kick`. The decision model's own choice is in `decision` messages.
- `players`: only players on the pitch; a substituted or sent-off player
  disappears from it.

### `event`

A moment the page shows, sent when it happens.

```json
{"type": "event", "kind": "goal", "t": 734.2, "team": 0, "player": 9}
```

`kind` is one of `goal`, `throw_in`, `goal_kick`, `corner`, `half_time` or
`full_time`; `foul`, `free_kick`, `penalty`, `offside`, `yellow`, `red` and
`substitution` are planned. `team` is the team that scored or takes the
restart (`null` for `half_time` and `full_time`). A `goal` adds the scorer as
`player`: for now, the scoring team's player nearest the ball. A
`substitution` will add `"off"` and `"on"` player ids and the incoming
player's `"model"`.

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

### `manager` (planned)

A manager's instruction or substitution request, for the overlay.

```json
{"type": "manager", "team": 0, "kind": "instruction", "player": 7, "text": "Stay wide and wait for the switch."}
```

## Page to server

Nothing yet. The page only listens.
