# Decision Pitch

Fast decision models play a real-time soccer match in 3D. Every player is
driven by a decision model and each team is managed by a language model that
picks the line-up, guides players and makes substitutions. There are no
turns: each model is asked again as soon as its answer is applied, so a
faster model acts more often while the match keeps running.

It is a sibling of [Decision Arena](https://github.com/eandualem/decision-arena),
where the same models race in a runner game.

![A match in play: Harbour in blue against Ridge in orange, seen from the main stand](docs/media/grass/wide.jpg)

**Status: early experiment.** Two teams of eleven play complete matches, with
model decisions, manager instructions, substitutions and answer times visible.
The football is still developing: players can bunch up, attacks can stall, and
some laws are simplified. This is a way to explore decisions under time pressure,
not a validated model leaderboard.

## Who decides what?

| Part | What it sees | What it decides |
|---|---|---|
| Each of the 22 player models | Ball, every player, its role and location, recovery/support targets, current action, recent latency and manager instruction; an overhead image for vision models | One action, such as `pass`, `press`, `mark`, `shoot` or `wait` |
| Each team's LLM manager | Available model catalog and fresh latency/validity samples; its own players' performance and health; aggregate opponent performance | Models for the starting eleven, initial instructions, zonal or man-to-man defending, updated instructions and legal substitutions |
| Optional assistants | The manager's match feed | Short advice to the manager about model performance or the run of play |
| Shared match engine | The full match state | Action targets and movement, ball physics, possession, restarts, fouls, cards, offside, clock and substitution legality |
| Browser | Match snapshots and decision/manager events | Presentation: camera, animation, labels and inspection controls |

Players choose an **action**, not coordinates or a named pass recipient. Shared
code turns that choice into football: for `pass`, it picks an open teammate and
aims ahead of their movement. Managers influence players through instructions;
they do not move them directly or change the fixed 4-4-2 formation.

Each player asks again as soon as its last answer is applied. The match keeps
running while answers are in flight, so speed changes how often a model can
reconsider. Local models queue requests within each team; API limits and stale
answers also affect play.

Read [how decisions work](docs/model-decisions.md) for the full action set,
manager inputs and outputs, timing, fallbacks and fairness limits.

## Run it locally

You need Git, [uv](https://docs.astral.sh/uv/) and a browser with WebGL support.
The Python package requires Python 3.12 or newer; uv can install a suitable Python.
The renderer is included, with no JavaScript build step.

```bash
git clone https://github.com/eandualem/decision-pitch.git
cd decision-pitch
uv tool install 'laya[serve]'
uv run decision-pitch
```

The default is **Laya players on both teams and two built-in managers**. No API
key is needed. Laya runs on your computer; its first start downloads about
850 MB, and each team gets a separate local model process. Allow time for the
initial download and model startup. LLM managers are optional; configure them
[below](#choose-the-managers).

The page opens at `http://127.0.0.1:8000/`. Each browser connection starts its
own match, including new model requests. Stop the server with Ctrl+C.

| Control | Effect |
|---|---|
| **O** | Show or hide player decisions, roles, model names, latency and manager messages |
| **P** or **Pause** | Freeze play and new requests; pending answers wait for resume before application |
| **Play again**, at full time | Start a new match |

Use `--port` to change the port, `--no-browser` to start without opening a page,
and `--half-length` for seconds per half (default 90). A default match takes
about three minutes of play, plus lineup selection, stoppages and half time.
The displayed football clock maps each half to 45 minutes.

To play without the page and print match events:

```bash
uv run decision-pitch --headless --seed 1
```

The seed controls engine randomness. Live model replies and arrival times can
still change the outcome between runs.

## Choose the models

Each team uses Laya unless you name the decision models its manager may
choose from with `--home` and `--away`, separated by commas. One
name puts the whole team on that model:

```bash
uv run decision-pitch --home laya --away laya
uv run decision-pitch --home laya,jev --away clef
```

| Name | Model | Needs |
|---|---|---|
| `laya` | Laya, run on this computer | `uv tool install 'laya[serve]'` once; its first start downloads about 850 MB |
| `d1` | Liquid's d1-3B, run on this computer | llama.cpp's `llama-server`; its first start downloads about 2.9 GB |
| `jev` | Jev at TypeSafe | `TYPESAFE_API_KEY` |
| `openai` | GPT-6 Luna Decisions | `OPENAI_API_KEY` |
| `perplexity` | Perplexity Decider | `PERPLEXITY_API_KEY` |
| `aplomb` | EmpirioLabs' Aplomb 1 | `EMPIRIO_LABS_API_KEY` |
| `microsoft`, `liquid` | Microsoft Decision-1 and Liquid D1, through Vercel's AI Gateway | `AI_GATEWAY_API_KEY` |
| `clef` | Cloudflare's Clef-flash | `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_AUTH_TOKEN` |

With no keys, Laya plays both teams. Built-in bots are not selectable. To use the others, copy
`.env.example` to `.env` and fill in the keys you have; the names are Decision
Arena's, so one `.env` serves both. Startup checks only the requested models,
with one question each (including a picture for image variants). A model that
does not answer is named with the key to check.

Add `-image` to `openai`, `perplexity`, `aplomb` or `clef` to offer its vision
variant alongside its text-only model. Vision players receive a fresh overhead
pitch image with every question: names and shirt numbers identify every player,
a yellow ring and YOU mark the deciding player, team colours distinguish sides,
and arrows show movement. The image always has the player's team attacking right.
Text-only players receive no picture. Image and text variants use the same key.

To give both managers every working API model configured in the environment,
including image variants, use `--home available --away available`. This probes
all configured APIs and excludes ones that fail. Local models such as Laya can
be named explicitly. Above each player, the match shows its decision model;
shirt numbers stay on the kits.

## Choose the managers

Each team has a manager. Before kick-off it picks a model for every player
from the allowed pool. An LLM manager also chooses `zonal` or `man_to_man`
defending and starting instructions. During play it receives the latest match
feed 30 match-seconds after its previous answer: it can give a player a one-line instruction,
which the player reads with its state, change defending style, and substitute a player, bringing on a
substitute with a model of its choice at the next stoppage. Press O on the
page to see every player's position, shirt number, model, latest decision and answer time, and the
managers' instructions and substitutions. Lime highlights the ball carrier;
blue highlights the nearest opposing defender, on the pitch and in the panel.
Press P or click Pause to freeze the match and new model requests; press it
again to resume. Already pending answers wait until resume before application.

The built-in manager (`builtin`, the default) needs no model credentials: it picks models
by their typical answer times and substitutes by simple rules. A language
model can manage instead, through Anthropic's API with `ANTHROPIC_API_KEY`
or OpenAI through the Codex CLI's ChatGPT subscription login (`codex login`).
OpenAI managers never use an API key; decision players still use their provider
keys. Install the [Codex CLI](https://learn.chatgpt.com/docs/cli) before selecting
an OpenAI manager:

```bash
uv run decision-pitch --home laya --home-manager anthropic --away-manager builtin
```

`anthropic` uses `claude-haiku-5-5` and `openai` uses `gpt-6-astra`; name
another model with `anthropic:MODEL` or `openai:MODEL`. Set each manager's
reasoning effort with `--home-effort low|medium|high` and `--away-effort` (default
`low`; the selected provider/model must support it). The touchline label and
decision panel show the exact manager model and effort.

For example, two LLM managers choosing from the same configured API pool:

```bash
uv run decision-pitch --home available --away available \
  --home-manager openai:gpt-6-astra --away-manager openai:gpt-6-sol \
  --home-effort high --away-effort high
```

Managers receive individual football statistics and model health for their own
players, summaries for each model they have fielded, and only aggregate opponent performance. Opponent model assignments,
individual statistics and instructions are hidden. Possession by pitch third
helps managers see where their team spends its time. Kicks count all passes,
shots and clearances, not successful passes. Goals are reported per team;
individual scoring attribution is not yet reliable. Lineup fallbacks and failed
consultations are shown in the decision panel.

LLM managers also receive the full available text/image model catalog. Before
lineup selection and each consultation, each candidate answers one off-pitch
question about the same current player state; image variants receive a labelled
pitch image too. These samples report current latency, validity, sample count
and age. They do not control players or establish football skill. The lineup
brief asks for a mixed team, including an image variant when available, and
substitutions weigh football contributions alongside speed and reliability.
Match telemetry accumulates continuously; the manager sees the latest snapshot
when consulted. Sampling adds one decision request per candidate per team per
consultation and a six-second deadline per dispatched probe. Local probes wait
for their model's queue and for resume before that deadline starts.

`--assistants 1` or `2` gives each language-model manager assistant models
(Claude Haiku, or the same subscription model as the OpenAI manager)
that send it a short note before each
consultation. A three-minute match allows roughly six consultations per team,
plus lineup selection; response time and stoppages affect the count. Player
requests run much more often, so their API cost must be budgeted separately.
OpenAI managers consume subscription usage. Each request has a three-minute
timeout; failures appear in the decision panel without switching to API billing.
A model that answers faster acts more often: each player asks its model again
as soon as its last answer is applied, and keeps carrying out that answer
while it waits.

### Inspect manager requests in Langfuse

Install tracing support with `uv sync --extra tracing`, then set
`LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY`, and `LANGFUSE_BASE_URL` in `.env`.
The URL defaults to `https://cloud.langfuse.com`; use your project's region or
self-hosted address. Start the game with `uv run --extra tracing decision-pitch`
and your usual model/manager arguments.

When both keys are present, manager and assistant requests export to that
Langfuse project, grouped by match with a team label. Each generation contains
the system instructions, full game/telemetry feed, response schema, response,
model, effort and duration. Subscription requests also include the exact prompt
sent to the Codex CLI. Failed requests record the exception type, never raw
authentication errors. Provider keys, login data and decision-player image
payloads are excluded. Export problems are logged without stopping play.
Remove the Langfuse keys and restart to turn tracing off.

## Current limits

- The formation is fixed at 4-4-2. Managers assign models to those slots and
  guide them, but cannot redesign the formation or control movement directly.
- Action execution uses shared football heuristics. A result reflects those
  heuristics, provider latency and limits, lineups and manager choices together.
- Headers, aerial duels and offside interference without playing the ball are
  not implemented. Handball and contact use simplified player geometry.
- Attacking flow and spacing remain experimental. One match is not evidence
  that a model is better at football; probe latency is not a skill score.
- Goals count correctly for the team, but the displayed scorer is a nearest-player
  approximation. Manager statistics therefore omit individual goals.

## Laws of the game

| Law | Status |
|---|---|
| Kick-off, at the start, after half time and after a goal | Implemented. Opponents stay outside the centre circle; players out of place run back and the kick-off waits for them, for up to 10 s |
| Ball in and out of play | Implemented. The ball is out when it has wholly crossed a line, on the ground or in the air |
| Goals | Implemented |
| Throw-ins | Implemented. Opponents stay 2 m away. The taker pauses for two seconds after collecting the ball for readable pacing. A foul throw cannot happen: the thrower always throws with both hands from where the ball went out |
| Goal kicks | Implemented. Opponents leave the penalty area until the kick is taken; it is taken once none is within 9.15 m of the ball, and one that had no time to leave may stay |
| Corners | Implemented. Opponents stay 9.15 m away |
| Two halves and half time | Implemented, with a change of ends and added time for goals, penalties, substitutions and cards |
| Goalkeepers | Implemented. A goalkeeper can handle the ball, so play it higher and further, in its own penalty area, except a ball a teammate deliberately kicked or threw to it, which it plays with its feet. A goalkeeper holding the ball for more than eight seconds concedes a corner, with the referee's count shown for the last five |
| Saves and deflections | Implemented. A ball faster than 18 m/s bounces off any player it reaches; a goalkeeper at full stretch parries a shot instead of catching it, so a parry or block can give a corner |
| Playing the ball twice at a restart | Implemented: an indirect free kick to the opponents |
| Goals that may not be scored directly from a restart | Implemented. A throw-in straight into the opponents' goal is a goal kick, and into the thrower's own goal a corner. An own goal straight from a kick-off, goal kick, corner or free kick is a corner, and a goal straight from an indirect free kick does not count |
| Fouls | Implemented for challenges on the player with the ball: a standing or slide tackle from behind, a tackle that takes the player and not the ball, and running into the carrier from behind or without being able to reach the ball. A fouled player goes down. Off the ball, running into an opponent from behind where the ball is contested is a foul. Handball is judged from where the ball meets a player, since players have no arms: a ball at arm height and wide of the body, not from close by |
| Free kicks and penalties | Implemented. Opponents stay 9.15 m away, with a wall near goal; at a penalty only the taker and the goalkeeper on its line stay in the area and arc |
| Advantage | Implemented: when the fouled team can play on in the opponents' half, play goes on, and comes back for the free kick if the opponents win the ball or receive an out-of-play restart within 3 s |
| Offside | Implemented, judged when a teammate kicks the ball, with an indirect free kick. Interfering with an opponent without playing the ball is not judged yet |
| Yellow and red cards | Implemented: a yellow for stopping a promising attack or a slide tackle from behind, a red for denying an obvious goal-scoring opportunity or a second yellow. A tackle in the offender's own penalty area is one card lower, as the penalty gives the chance back. A sent-off player leaves the match; a team with fewer than seven ends it |
| Substitutions | Implemented in the engine: five substitutes, at most three stoppages besides half time, made at the next stoppage, as the managers ask for them. A substitute takes the place and position of the player it replaces |

## Contribute and explore

The default and integration branch is `develop`; changes arrive through reviewed
pull requests into it. `main` contains promoted releases. Record design changes
in [docs/decisions.md](docs/decisions.md) before implementing them. Keep credentials
in your environment or ignored `.env` file; tests use fake or recorded responses.

```bash
uv run pytest
node --test tests/web/*.test.mjs
```

Node.js is needed only for the browser-module tests, not to run the game.

- [How decisions work](docs/model-decisions.md): player, manager and assistant responsibilities.
- [Design decisions](docs/decisions.md): architecture, action tradeoffs and implementation rationale.
- [Match protocol](docs/protocol.md): WebSocket messages for the renderer.
- [Figure assets](assets/figure/README.md): rebuilding and restyling the original characters.
- [Third-party notices](src/decision_pitch/web/THIRD_PARTY.md): renderer dependencies.

## License and credits

[MIT](LICENSE) covers the original project code and assets. Third-party code
retains its own notices.

The model adapters and timing approach come from
[Decision Arena](https://github.com/eandualem/decision-arena), with its
[MIT notice](src/decision_pitch/arena/LICENSE) retained. The manager tracing
transport adapts Entune code with its [MIT notice](src/decision_pitch/ENTUNE_LICENSE).
The figures, kits, animation and soccer engine are original project work.
