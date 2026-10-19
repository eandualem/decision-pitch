# Match rules

Both teams use the same engine and rules. Headers, aerial duels and offside
interference without playing the ball are not implemented. Contact and handball
use simplified player geometry.

[Back to the overview](../README.md) · [Implementation decisions](decisions.md)


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
