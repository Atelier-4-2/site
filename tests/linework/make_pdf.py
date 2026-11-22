"""Builds plan_sample.pdf (same drawing as plan_sample.svg, vector) with reportlab. Run: py -3 make_pdf.py"""
from reportlab.pdfgen import canvas
from reportlab.lib.units import mm

W, H = 420 * mm, 297 * mm
c = canvas.Canvas("plan_sample.pdf", pagesize=(W, H))
X = lambda x: (x + 20) * mm            # same group translate(20 10) as the SVG
Y = lambda y: H - (y + 10) * mm        # PDF y points up

def tint():
    c.setFillColorRGB(0.933, 0.933, 0.933); c.rect(40 * mm, H - 240 * mm, 300 * mm, 200 * mm, stroke=0, fill=1)

def lines(width_mm, rgb, dash=None):
    c.setLineWidth(width_mm * mm); c.setStrokeColorRGB(*rgb); c.setDash(*(dash or ([], 0))); c.setFillColorRGB(0, 0, 0)

tint()
lines(0.7, (0, 0, 0)); p = c.beginPath(); p.moveTo(X(20), Y(30)); p.lineTo(X(320), Y(30)); p.lineTo(X(320), Y(230)); p.lineTo(X(20), Y(230)); p.close(); c.drawPath(p, stroke=1, fill=0)
c.line(X(170), Y(30), X(170), Y(230))
lines(0.35, (0, 0, 0)); c.line(X(20), Y(130), X(170), Y(130)); c.line(X(170), Y(150), X(320), Y(150))
lines(0.18, (0.2, 0.2, 0.2))
c.line(X(60), Y(30), X(100), Y(30)); c.line(X(60), Y(27), X(100), Y(27))
p = c.beginPath(); p.moveTo(X(260), Y(230)); p.lineTo(X(300), Y(230)); p.lineTo(X(300), Y(226)); c.drawPath(p, stroke=1, fill=0)
c.arc(X(100), Y(150), X(140), Y(110), startAng=0, extent=90)
c.rect(X(230), Y(90), 60 * mm, 30 * mm, stroke=1, fill=0)
lines(0.09, (0.47, 0.47, 0.47))
c.rect(X(30), Y(65), 40 * mm, 25 * mm, stroke=1, fill=0); c.rect(X(190), Y(200), 50 * mm, 30 * mm, stroke=1, fill=0)
c.circle(X(260), Y(190), 12 * mm, stroke=1, fill=0); c.line(X(20), Y(245), X(320), Y(245))
lines(0.18, (0.33, 0.33, 0.33), ([3 * mm, 2 * mm], 0))
p = c.beginPath(); p.moveTo(X(40), Y(60)); p.lineTo(X(150), Y(60)); p.lineTo(X(150), Y(110)); c.drawPath(p, stroke=1, fill=0)
lines(0.18, (0, 0, 0)); c.setFillColorRGB(0, 0, 0); p = c.beginPath(); p.moveTo(X(165), Y(125)); p.lineTo(X(175), Y(125)); p.lineTo(X(175), Y(135)); p.lineTo(X(165), Y(135)); p.close(); c.drawPath(p, stroke=0, fill=1)
c.setFillColorRGB(0, 0, 0)
for (x, y, s, t) in [(60, 80, 5, "Sejour"), (215, 90, 5, "Chambre"), (30, 270, 3.5, "1/100")]:
    c.setFont("Helvetica", s / 0.352778); c.drawString(x * mm, H - y * mm, t)
c.save()
