import base64
import io

from PIL import Image, ImageDraw

from decision_pitch.match import Match
from decision_pitch.vision import overhead


def test_overhead_identifies_every_player_and_self_without_models(monkeypatch):
    match = Match()
    written = []
    original = ImageDraw.ImageDraw.text
    def text(self, xy, value, *args, **kwargs):
        written.append(value)
        return original(self, xy, value, *args, **kwargs)
    monkeypatch.setattr(ImageDraw.ImageDraw, 'text', text)
    uri = overhead(match, match.player(7))
    image = Image.open(io.BytesIO(base64.b64decode(uri.split(',', 1)[1])))
    assert image.size == (1000, 720) and image.format == 'JPEG'
    assert 'YOU 7 Finch' in written
    assert all(any(f'{p.number} {p.name}' in label for label in written) for p in match.players)
    assert 'YOUR TEAM: Harbour' in written and 'OPPONENTS: Ridge' in written
    assert any('attack RIGHT' in label for label in written)


def test_overhead_rotates_positions_and_movement_when_teams_change_ends(monkeypatch):
    match = Match()
    match.player(7).x, match.player(7).y = -20, 10
    match.player(7).vx, match.player(7).vy = 3, 1
    ellipses = []
    original = ImageDraw.ImageDraw.ellipse
    def ellipse(self, xy, *args, **kwargs):
        if kwargs.get('outline') == '#ffe168': ellipses.append(xy)
        return original(self, xy, *args, **kwargs)
    monkeypatch.setattr(ImageDraw.ImageDraw, 'ellipse', ellipse)
    overhead(match, match.player(7))
    match.period = 2
    overhead(match, match.player(7))
    assert ellipses[0][0] < 500 < ellipses[1][0]
    assert ellipses[0][1] < ellipses[1][1]
