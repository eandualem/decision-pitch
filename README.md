# Decision Pitch

Fast decision models play a real-time soccer match in 3D. Every player is
driven by a decision model and each team is managed by a language model that
picks the line-up, guides players and makes substitutions. There are no
turns: each model is asked again as soon as its answer is applied, so a
faster model acts more often while the match keeps running.

It is a sibling of [Decision Arena](https://github.com/eandualem/decision-arena),
where the same models race in a runner game.

**Status:** early. Decision models or built-in bots play a full match on the
page; the managers are being built. See [docs/decisions.md](docs/decisions.md)
for the design and [docs/protocol.md](docs/protocol.md) for the match stream.

## Run it

You need [uv](https://docs.astral.sh/uv/).

```bash
uv run decision-pitch
```

The page opens in your browser at `http://127.0.0.1:8000/` and a match starts
each time it connects. Use `--port` to change the port, `--no-browser` to start
without opening it and `--half-length` to set the length of each half in
seconds (default 180).

To play a match without the page and print what happens (with bots on both
teams it runs as fast as it can):

```bash
uv run decision-pitch --headless --seed 1
```

## Choose the models

Each team is played by the built-in bot unless you choose a decision model for
it with `--home` and `--away`:

```bash
uv run decision-pitch --home laya --away bot
```

| Name | Model | Needs |
|---|---|---|
| `bot` | The built-in bot | Nothing |
| `laya` | Laya, run on this computer | `uv tool install 'laya[serve]'` once; its first start downloads about 850 MB |
| `d1` | Liquid's d1-3B, run on this computer | llama.cpp's `llama-server`; its first start downloads about 2.9 GB |
| `jev` | Jev at TypeSafe | `TYPESAFE_API_KEY` |
| `openai` | GPT-6 Luna Decisions | `OPENAI_API_KEY` |
| `perplexity` | Perplexity Decider | `PERPLEXITY_API_KEY` |
| `aplomb` | EmpirioLabs' Aplomb 1 | `EMPIRIO_LABS_API_KEY` |
| `microsoft`, `liquid` | Microsoft Decision-1 and Liquid D1, through Vercel's AI Gateway | `AI_GATEWAY_API_KEY` |
| `clef` | Cloudflare's Clef-flash | `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_AUTH_TOKEN` |

With no keys, Laya and the bots play a full match. To use the others, copy
`.env.example` to `.env` and fill in the keys you have; the names are Decision
Arena's, so one `.env` serves both. At startup each model with a key is asked
one question, and one that does not answer is named with the key to check.
A model that answers faster acts more often: each player asks its model again
as soon as its last answer is applied, and keeps carrying out that answer
while it waits.

## Laws of the game

| Law | Status |
|---|---|
| Kick-off, at the start, after half time and after a goal | Implemented. Opponents stay outside the centre circle; players who are not in their own half after 5 s are moved there |
| Ball in and out of play | Implemented. The ball is out when it has wholly crossed a line, on the ground or in the air |
| Goals | Implemented |
| Throw-ins | Implemented. Opponents stay 2 m away; foul throws are not checked yet |
| Goal kicks | Implemented. Opponents stay 9.15 m away; they are not yet kept out of the penalty area |
| Corners | Implemented. Opponents stay 9.15 m away |
| Two halves and half time | Implemented, with a change of ends. No added time |
| Goalkeepers | A goalkeeper can play the ball higher and further in its own penalty area. Handling rules (back-passes, six seconds) are not implemented yet |
| Playing the ball twice at a restart | Not implemented yet |
| Goals that may not be scored directly from a restart (any goal from a throw-in; an own goal from a kick-off, goal kick or corner) | Not implemented yet: such a goal currently counts |
| Fouls, free kicks and penalties | Not implemented yet |
| Offside | Not implemented yet |
| Yellow and red cards | Not implemented yet |
| Substitutions | Not implemented yet |

## Test it

```bash
uv run pytest
```
