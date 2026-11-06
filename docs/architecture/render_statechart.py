#!/usr/bin/env python3
"""Render docs/architecture/statechart.png — one clean frame for an X post."""

from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

W, H = 1600, 900
BG = (247, 244, 238)
INK = (28, 25, 22)
MUTED = (107, 101, 96)
LINE = (42, 38, 34)
CARD = (255, 253, 248)
ACCENT = (196, 92, 42)
OK = (47, 111, 79)
FAIL = (154, 48, 40)
SOFT = (220, 214, 204)
WASH = (252, 236, 230)

OUT = Path(__file__).resolve().parent / "statechart.png"
FONT_DIR = Path("/usr/share/fonts/truetype/dejavu")


def fnt(name: str, size: int) -> ImageFont.FreeTypeFont:
    return ImageFont.truetype(str(FONT_DIR / name), size)


TITLE = fnt("DejaVuSans-Bold.ttf", 34)
H2 = fnt("DejaVuSans-Bold.ttf", 15)
BOX = fnt("DejaVuSans-Bold.ttf", 17)
BODY = fnt("DejaVuSans.ttf", 15)
SMALL = fnt("DejaVuSans.ttf", 14)
TINY = fnt("DejaVuSans.ttf", 12)


def box(draw, xy, text, fill=CARD, outline=LINE, color=INK, tfont=BOX, thick=2):
    x, y, w, h = xy
    draw.rounded_rectangle((x, y, x + w, y + h), radius=12, fill=fill, outline=outline, width=thick)
    tw = draw.textlength(text, font=tfont)
    draw.text((x + (w - tw) / 2, y + (h - tfont.size) / 2 - 2), text, font=tfont, fill=color)
    return x, y, w, h


def h_arrow(draw, x1, y, x2, color=LINE):
    draw.line((x1, y, x2 - 9, y), fill=color, width=2)
    draw.polygon([(x2, y), (x2 - 9, y - 5), (x2 - 9, y + 5)], fill=color)


def main() -> None:
    img = Image.new("RGB", (W, H), BG)
    d = ImageDraw.Draw(img)

    d.text((56, 32), "engram", font=TITLE, fill=INK)
    d.text((198, 46), "memory + routing", font=BODY, fill=MUTED)
    right = "last-write-wins pages  ·  per-process lock  ·  Jev fail-open"
    rw = d.textlength(right, font=SMALL)
    d.text((W - 56 - rw, 48), right, font=SMALL, fill=MUTED)

    # 1. request
    d.text((56, 104), "REQUEST", font=H2, fill=MUTED)
    y, h = 132, 58
    a = box(d, (56, y, 168, h), "Auth")
    p = box(d, (264, y, 168, h), "Parse")
    o = box(d, (472, y, 210, h), "Org + brain")
    s = box(d, (722, y, 176, h), "Dispatch")
    mid = y + h / 2
    h_arrow(d, a[0] + a[2], mid, p[0])
    h_arrow(d, p[0] + p[2], mid, o[0])
    h_arrow(d, o[0] + o[2], mid, s[0])
    box(d, (948, y, 168, h), "401 / 400", fill=WASH, outline=FAIL, color=FAIL)
    d.line((140, y, 140, y - 16), fill=FAIL, width=2)
    d.line((348, y, 348, y - 16), fill=FAIL, width=2)
    d.line((140, y - 16, 1032, y - 16), fill=FAIL, width=2)
    d.line((1032, y - 16, 1032, y), fill=FAIL, width=2)
    d.text((1140, y + 18), "header ≠ body is 400", font=TINY, fill=MUTED)

    # 2. remember
    d.text((56, 220), "REMEMBER", font=H2, fill=MUTED)
    y, h = 248, 58
    nodes = [
        (56, "Suggest"),
        (248, "Slug lock"),
        (440, "Read"),
        (612, "Write"),
        (784, "Read-back"),
        (992, "Roll"),
        (1164, "ok"),
    ]
    placed = []
    for x, label in nodes:
        w = 168 if label in {"Suggest", "Slug lock", "Read-back"} else 148
        if label == "ok":
            placed.append(box(d, (x, y, 140, h), label, fill=OK, outline=OK, color=(255, 255, 255)))
        else:
            placed.append(box(d, (x, y, w, h), label))
    for i in range(len(placed) - 1):
        x, _, w, _ = placed[i]
        h_arrow(d, x + w, mid := y + h / 2, placed[i + 1][0])

    # retry loop: read-back → back to read
    loop_y = y + h + 36
    rb = placed[4]
    rd = placed[2]
    d.line((rb[0] + rb[2] / 2, y + h, rb[0] + rb[2] / 2, loop_y), fill=ACCENT, width=2)
    d.line((rd[0] + rd[2] / 2, loop_y, rb[0] + rb[2] / 2, loop_y), fill=ACCENT, width=2)
    d.line((rd[0] + rd[2] / 2, loop_y, rd[0] + rd[2] / 2, y + h), fill=ACCENT, width=2)
    draw_chevron = d.polygon
    draw_chevron(
        [
            (rd[0] + rd[2] / 2, y + h + 2),
            (rd[0] + rd[2] / 2 - 5, y + h + 11),
            (rd[0] + rd[2] / 2 + 5, y + h + 11),
        ],
        fill=ACCENT,
    )
    box(d, (720, loop_y - 18, 130, 36), "retry ×3", fill=WASH, outline=ACCENT, color=ACCENT, tfont=SMALL)
    box(d, (1360, y, 184, h), "fail after 3", fill=WASH, outline=FAIL, color=FAIL, tfont=SMALL)
    d.line((868, loop_y, 1452, loop_y), fill=FAIL, width=2)
    d.line((1452, loop_y, 1452, y + h), fill=FAIL, width=2)
    d.polygon([(1452, y + h + 1), (1447, y + h + 10), (1457, y + h + 10)], fill=FAIL)

    d.text((56, loop_y + 28), "suggestTopic is outside the lock    ·    lock is this Cloud Run instance only", font=TINY, fill=MUTED)

    # 3. recall
    d.text((56, 400), "RECALL", font=H2, fill=MUTED)
    y, h = 428, 58
    r1 = box(d, (56, y, 200, h), "Search 20")
    r2 = box(d, (300, y, 200, h), "Jev rerank")
    r3 = box(d, (544, y, 184, h), "5 snippets")
    r4 = box(d, (772, y, 210, h), "optional full")
    mid = y + h / 2
    h_arrow(d, r1[0] + r1[2], mid, r2[0])
    h_arrow(d, r2[0] + r2[2], mid, r3[0])
    h_arrow(d, r3[0] + r3[2], mid, r4[0])
    d.text((300, y + h + 10), "timeout keeps gbrain order", font=TINY, fill=MUTED)
    d.text((772, y + h + 10), "head + tail, middle elided", font=TINY, fill=MUTED)

    # concurrency
    d.rounded_rectangle((56, 548, 1544, 852), radius=16, fill=CARD, outline=SOFT, width=2)
    d.text((80, 568), "WHEN SEVERAL AGENTS WRITE AT ONCE", font=H2, fill=MUTED)
    d.text(
        (80, 594),
        "The in-process queue cannot see another replica, a console put_page, or a deploy overlap.",
        font=SMALL,
        fill=MUTED,
    )

    cards = [
        (80, "Same replica", "serializeBySlug(org:slug) chains\npromises. A throw does not poison\nthe next append.\n\nTLC: AckedWritePresent holds."),
        (560, "Two replicas", "put_page last-write-wins.\nRead-back retries a clobber\nbefore ack — not after.\n\nTLC: AckedWritePresent fails."),
        (1040, "Dream lock", "pg_try_advisory_lock is per\nsession. Unlock is a second\npooled query.\n\nTLC: the lock can leak."),
    ]
    for x, title, body in cards:
        d.rounded_rectangle((x, 636, x + 440, 820), radius=12, fill=BG, outline=SOFT, width=2)
        d.text((x + 20, 652), title, font=H2, fill=INK)
        yy = 684
        for line in body.split("\n"):
            d.text((x + 20, yy), line, font=SMALL, fill=MUTED)
            yy += 20

    d.text(
        (80, 832),
        "index.ts   proxy.ts   brain.ts   memory-entries.ts   reflex/write.ts   dream/lock.ts",
        font=TINY,
        fill=MUTED,
    )

    img.save(OUT, "PNG", optimize=True)
    print(f"wrote {OUT} {img.size}")


if __name__ == "__main__":
    main()
