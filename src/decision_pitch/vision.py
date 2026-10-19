"""A player's fresh, team-relative overhead view, with no model identities."""

import base64
import io
import math

from PIL import Image, ImageDraw, ImageFont

from decision_pitch import pitch

WIDTH, HEIGHT = 1000, 720
MARGIN, TOP, SCALE = 50, 65, 900 / pitch.LENGTH
FONT = ImageFont.load_default(size=14)


def overhead(match, player) -> str:
    """Draw the current state synchronously, before the player's API request yields."""
    image = Image.new("RGB", (WIDTH, HEIGHT), "#10251d")
    draw = ImageDraw.Draw(image)
    direction = match.attack(player.team)

    def point(x, y):
        return (MARGIN + (x * direction + pitch.HALF_LENGTH) * SCALE,
                TOP + (pitch.HALF_WIDTH - y * direction) * SCALE)

    def box(x1, y1, x2, y2):
        a, b = point(x1 * direction, y1 * direction), point(x2 * direction, y2 * direction)
        return min(a[0], b[0]), min(a[1], b[1]), max(a[0], b[0]), max(a[1], b[1])

    draw.rectangle(box(-52.5, -34, 52.5, 34), fill="#21633f", outline="white", width=2)
    draw.line((point(0, -34), point(0, 34)), fill="white", width=2)
    draw.ellipse(box(-9.15, -9.15, 9.15, 9.15), outline="white", width=2)
    for side in (-1, 1):
        draw.rectangle(box(side * 52.5, -20.16, side * 36, 20.16), outline="white", width=2)
        draw.rectangle(box(side * 52.5, -9.16, side * 47, 9.16), outline="white", width=2)
        draw.line((point(side * 52.5, -3.66), point(side * 52.5, 3.66)), fill="#ffe168", width=5)

    def arrow(x, y, vx, vy, colour):
        a, b = point(x, y), point(x + vx * 0.7, y + vy * 0.7)
        if math.dist(a, b) < 3:
            return
        draw.line((a, b), fill=colour, width=2)
        angle = math.atan2(b[1] - a[1], b[0] - a[0])
        ends = [(b[0] - 7 * math.cos(angle + t), b[1] - 7 * math.sin(angle + t)) for t in (-0.5, 0.5)]
        draw.line((ends[0], b, ends[1]), fill=colour, width=2)

    # Reserve labels separately so close players still have individually readable names.
    occupied = []
    for p in sorted(match.players, key=lambda p: (p.id != player.id, p.id)):
        x, y = point(p.x, p.y)
        colour = match.teams[p.team].colours["shirt"]
        arrow(p.x, p.y, p.vx, p.vy, colour)
        if p.id == player.id:
            draw.ellipse((x - 13, y - 13, x + 13, y + 13), outline="#ffe168", width=3)
        draw.ellipse((x - 7, y - 7, x + 7, y + 7), fill=colour, outline="white", width=1)
        text = f"{'YOU ' if p.id == player.id else ''}{p.number} {p.name}"
        width = draw.textbbox((0, 0), text, font=FONT)[2] + 8
        left = max(2, min(WIDTH - width - 2, x - width / 2))
        offsets = [12, -30] + [v for k in range(2, 30) for v in (k * 20, -k * 20)]
        for offset in offsets:
            top = max(TOP - 18, min(HEIGHT - 43, y + offset))
            rect = (left, top, left + width, top + 19)
            if not any(rect[0] < r[2] and rect[2] > r[0] and rect[1] < r[3] and rect[3] > r[1] for r in occupied):
                break
        occupied.append(rect)
        draw.line(((x, y), (left + width / 2, top + 9)), fill=colour, width=1)
        draw.rectangle(rect, fill="#10251d", outline=colour)
        draw.text((left + 4, top + 1), text, font=FONT, fill="#ffe168" if p.id == player.id else "white")
    b = match.ball
    arrow(b.x, b.y, b.vx, b.vy, "white")
    x, y = point(b.x, b.y)
    draw.ellipse((x - 4, y - 4, x + 4, y + 4), fill="white", outline="black")
    draw.text((MARGIN, 12), f"{match.clock()} | YOU: {player.number} {player.name} | attack RIGHT ->", font=FONT, fill="white")
    for index, team in enumerate((player.team, 1 - player.team)):
        draw.rectangle((MARGIN + index * 460, 36, MARGIN + index * 460 + 12, 49), fill=match.teams[team].colours["shirt"])
        draw.text((MARGIN + index * 460 + 18, 36), f"{'YOUR TEAM' if index == 0 else 'OPPONENTS'}: {match.teams[team].name}",
                  font=FONT, fill="white")
    draw.text((MARGIN, HEIGHT - 28), "White dot: ball | arrows: movement | yellow ring: YOU | labels: shirt number and name",
              font=FONT, fill="white")
    output = io.BytesIO()
    image.save(output, format="JPEG", quality=85)
    return "data:image/jpeg;base64," + base64.b64encode(output.getvalue()).decode("ascii")
