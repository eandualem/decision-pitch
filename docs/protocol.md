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

`teams` has two entries once a match is set up (empty before). `id` is unique
across both teams; positions are `GK`, `DF`, `MF` or `FW`.

### `snapshot` (planned)

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
    {"id": 7, "x": 11.9, "y": -3.0, "heading": 0.3, "speed": 6.2, "action": "dribble"}
  ]
}
```

- `t`: match seconds since kick-off; `period`: 1 or 2.
- `phase`: `kickoff`, `play`, `throw_in`, `goal_kick`, `corner`,
  `free_kick`, `penalty`, `half_time` or `full_time`.
- `ball.owner`: the player in possession, or `null`.
- `players`: only players on the pitch; a substituted or sent-off player
  disappears from it.

### `event` (planned)

A moment the page shows, sent when it happens.

```json
{"type": "event", "kind": "goal", "t": 734.2, "team": 0, "player": 9}
```

`kind` is one of `goal`, `foul`, `free_kick`, `penalty`, `offside`,
`throw_in`, `goal_kick`, `corner`, `yellow`, `red`, `substitution`,
`half_time` or `full_time`. A `substitution` adds `"off"` and `"on"` player
ids and the incoming player's `"model"`.

### `decision` (planned)

One per model answer, for the overlay.

```json
{"type": "decision", "player": 7, "model": "Laya", "action": "pass", "ms": 182}
```

A failed answer has `"error"` in place of `"action"`.

### `manager` (planned)

A manager's instruction or substitution request, for the overlay.

```json
{"type": "manager", "team": 0, "kind": "instruction", "player": 7, "text": "Stay wide and wait for the switch."}
```

## Page to server

Nothing yet. The page only listens.
