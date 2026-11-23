# Draws the synthetic test sheets for the entourage cutter (all shapes drawn here, no outside material).
#   py -3 tests/entourage/make_sheets.py     -> sheet_pen.png, sheet_flat.png, sheet_white_inside.png, expected.json
import json, os
from PIL import Image, ImageDraw
H = os.path.dirname(os.path.abspath(__file__))
S = 3  # supersample for smooth edges
def canvas(w, h): return Image.new("RGB", (w * S, h * S), "white")
def done(im, name):
    w, h = im.size; im.resize((w // S, h // S), Image.LANCZOS).save(os.path.join(H, name))

def person_outline(d, cx, base, hgt, lw=3):
    """closed pen outline: head circle + body polygon (white inside)"""
    u = hgt / 100.0
    r = 7 * u
    d.ellipse([(cx - r) * S, (base - hgt) * S, (cx + r) * S, (base - hgt + 2 * r) * S], outline="black", width=lw * S)
    pts = [(cx - 10 * u, base - hgt + 17 * u), (cx + 10 * u, base - hgt + 17 * u), (cx + 12 * u, base - 45 * u), (cx + 8 * u, base - 45 * u), (cx + 7 * u, base), (cx + 1 * u, base), (cx, base - 40 * u), (cx - 1 * u, base), (cx - 7 * u, base), (cx - 8 * u, base - 45 * u), (cx - 12 * u, base - 45 * u)]
    d.polygon([(x * S, y * S) for x, y in pts], outline="black", width=lw * S)
    d.line([(p[0] * S, p[1] * S) for p in pts + [pts[0]]], fill="black", width=lw * S, joint="curve")

def tree_outline(d, cx, base, hgt, lw=3):
    r = hgt * 0.32
    top = base - hgt
    d.ellipse([(cx - r * 1.1) * S, top * S, (cx + r * 1.1) * S, (top + 2 * r) * S], outline="black", width=lw * S)
    d.rectangle([(cx - 4) * S, (top + 2 * r - 3) * S, (cx + 4) * S, base * S], outline="black", width=lw * S)
    d.rectangle([(cx - 3) * S, (top + 2 * r - 6) * S, (cx + 3) * S, (top + 2 * r + 1) * S], fill="white")  # open the trunk into the crown

# ---- sheet 1: 8 pen-outline figures, white inside, well separated --------------------------------------------------------------
im = canvas(1200, 520); d = ImageDraw.Draw(im)
exp1 = []
for i in range(4):
    cx = 150 + i * 280; person_outline(d, cx, 230, 170 - 10 * i); exp1.append("person")
for i in range(4):
    cx = 150 + i * 280; tree_outline(d, cx, 480, 190 + 15 * (i % 2)); exp1.append("tree")
done(im, "sheet_pen.png")

# ---- sheet 2: 6 flat colour blobs (no outline), 2-3 tones; light areas pale, not white ---------------------------------------------
im = canvas(1200, 520); d = ImageDraw.Draw(im)
tones = [("#4C6A92", "#8FA9C9"), ("#8A5A44", "#C79A7C"), ("#3F7D5B", "#9CC7A8"), ("#7A6BA6", "#B9AEDB"), ("#A0522D", "#E3B58F"), ("#2F5D62", "#8DB8BC")]
for i, (a, b) in enumerate(tones):
    cx = 150 + (i % 3) * 400; cy = 130 + (i // 3) * 260
    d.ellipse([(cx - 70) * S, (cy - 90) * S, (cx + 70) * S, (cy + 90) * S], fill=a)
    d.ellipse([(cx - 35) * S, (cy - 60) * S, (cx + 25) * S, (cy + 20) * S], fill=b)
done(im, "sheet_flat.png")

# ---- sheet 3: white areas INSIDE figures must survive (white shirts / eyes / window panes), one figure has a gap in its outline ----
im = canvas(1000, 420); d = ImageDraw.Draw(im)
for i in range(3):
    cx = 160 + i * 300
    d.ellipse([(cx - 60) * S, 40 * S, (cx + 60) * S, 380 * S], fill="#33475B")                 # dark body
    d.ellipse([(cx - 30) * S, 120 * S, (cx + 30) * S, 220 * S], fill="white")                  # white patch fully inside
    d.rectangle([(cx - 12) * S, 250 * S, (cx + 12) * S, 300 * S], fill="white")                # white window inside
done(im, "sheet_white_inside.png")
json.dump({"sheet_pen.png": {"figures": 8}, "sheet_flat.png": {"figures": 6}, "sheet_white_inside.png": {"figures": 3, "inner_white_probe": [[160, 170], [160, 275], [460, 170], [460, 275], [760, 170], [760, 275]]}}, open(os.path.join(H, "expected.json"), "w"), indent=1)
print("ok")
