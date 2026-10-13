# Decision Pitch

Fast decision models play a real-time soccer match in 3D. Every player is
driven by a decision model and each team is managed by a language model that
picks the line-up, guides players and makes substitutions. There are no
turns: each model is asked again as soon as its answer is applied, so a
faster model acts more often while the match keeps running.

It is a sibling of [Decision Arena](https://github.com/eandualem/decision-arena),
where the same models race in a runner game.

**Status:** early. The page draws an empty pitch; the match engine, the
models and the managers are being built. See [docs/decisions.md](docs/decisions.md)
for the design and [docs/protocol.md](docs/protocol.md) for the match stream.

## Run it

You need [uv](https://docs.astral.sh/uv/).

```bash
uv run decision-pitch
```

The page opens in your browser at `http://127.0.0.1:8000/`. Use `--port` to
change the port and `--no-browser` to start without opening it.

## Test it

```bash
uv run pytest
```
