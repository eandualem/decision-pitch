# Decision Pitch — contributor notes

Decision Pitch is an experiment: a real-time 3D soccer match in which every
player is driven by a fast decision model and each team is managed by a
large language model. It is a sibling of
[Decision Arena](https://github.com/eandualem/decision-arena): the same
class of models, now playing a team game with full rules.

## The game

- Two teams of eleven. Every player sees the ball, its teammates and its
  opponents, and is driven by one decision model.
- Full rules, clearly implemented: kick-off, ball out of play, throw-ins,
  goal kicks, corners, fouls and free kicks, offside, yellow and red cards,
  two halves and substitutions. A rule that isn't implemented yet is listed
  as such, never silently skipped.
- Real time, no turns. Each model gets the current state, answers with one
  action and gets the next state as soon as the answer is applied, while the
  match keeps running. A faster model acts more often; that is the story the
  game tells.
- Fairness: both teams play under the same rules, the same physics and the
  same state format. A player's state includes what it is already doing.

## Managers

- Each team's manager is a language model, optionally helped by assistant
  models that support the main manager.
- Before the match, the manager picks a decision model for every position,
  from the models' stated characteristics and capabilities.
- During the match, the manager gets a continuous feed of how the game is
  going. It can give instructions or guidance to individual players, and
  substitute one decision model for another when a player underperforms,
  within the substitution rules.

## Decision models

- The contestants are the models Decision Arena races: fast single-move
  answerers such as Laya (local), Jev, GPT-6 Luna Decisions, Perplexity
  Decider and Clef. Built-in bots are internal test fixtures, not player options.
- Reuse Decision Arena's model adapters and timing approach rather than
  writing new ones. How (a shared package, a dependency or a copy with
  attribution) is your decision; record it in `docs/decisions.md`. Read,
  never change, the decision-arena repository; ask its agent when its code
  doesn't settle a question.
- It runs with no keys: Laya plays both teams.
- API keys come from the environment only and are never committed, logged
  or shown on screen. Tests use fake or recorded responses. Spending beyond
  the keys already configured, and any paid model run at scale, needs the
  maintainer's go-ahead with its expected cost.

## Look and feel

- It must look good; 3D is preferred. A camera that follows play, readable
  team colours and names, and clear moments for goals, fouls and cards.
- A toggle shows each player's model, latest decision and latency, and the
  managers' instructions and substitutions. Hidden, the screen is just the
  match.
- It runs locally with one command, and a few minutes of play should look
  good as a screen recording.
- The maintainer authorises backbone swarms in this repository, with Codex
  `gpt-6-astra` members, to build the graphic elements. Write the issue
  first, as the swarm flow requires; the usual review and merge rules apply
  to what it produces.

## Engine and references

The soccer engine (rules and physics) is the hard part. You have full
freedom on approach. Prefer original work; studying open-source soccer
implementations for rules and physics is allowed. Respect each licence:
record what was studied or reused, and where, in `docs/decisions.md`, and
keep third-party notices with any reused code or assets. Use no club,
league, player or tournament names, logos or kits.

## Working on it

`develop` is the default and integration branch. Every change, including a
swarm's, lands through a reviewed pull request into `develop`, with
conventional commits (`feat:`, `fix:`, `docs:`, `chore:`) and a body saying
why. `main` is the released branch: it receives only a promotion pull request
from `develop` when the maintainer asks for one. Record stack and design
decisions in `docs/decisions.md` before implementing them.

The repository is private for now but written for publication: everything
in it, and every issue, PR, commit and comment, is written as if public.

## Local continuity

At startup, read `.backbone/memory/SCRATCHPAD.md` when present and update
it at handoffs. It is never tracked; the shared project-context policy
governs it.
