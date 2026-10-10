"""Generate HyperspaceBox.ttf: the box-drawing, block and arrow glyphs that VT323 lacks, drawn on
VT323's grid (1000 units/em, advance 400, ascent 800 / descent 200, 40-unit pixels) so the stats box,
sparklines and progress lines stay on the monospace character grid. Vertical strokes span the full
CSS line box (line-height 1.15 -> 75 units of half-leading above and below) so borders connect.

Run: uv run python frontend/src/ui/fonts/make_box_font.py
"""
from pathlib import Path

from fontTools.fontBuilder import FontBuilder
from fontTools.pens.ttGlyphPen import TTGlyphPen

ADV = 400
TOP, BOT = 880, -280            # line box (875 / -275) plus 5 units of overlap
L, R = -5, 405                  # horizontal strokes overlap neighbours by 5 units
XA, XB = (120, 160), (240, 280) # double vertical strokes
YA, YB = (320, 360), (200, 240) # double horizontal strokes (upper, lower)
XS, YS = (180, 220), (260, 300) # single strokes
YH = (240, 320)                 # heavy horizontal


def rect(pen, x0, y0, x1, y1):
    # clockwise (TrueType outer contour)
    pen.moveTo((x0, y0)); pen.lineTo((x0, y1)); pen.lineTo((x1, y1)); pen.lineTo((x1, y0)); pen.closePath()


def poly(pen, pts):
    pen.moveTo(pts[0])
    for p in pts[1:]:
        pen.lineTo(p)
    pen.closePath()


def hline(y, x0=L, x1=R):
    return (x0, y[0], x1, y[1])


def vline(x, y0=BOT, y1=TOP):
    return (x[0], y0, x[1], y1)


G = {}
# single lines
G['─'] = [hline(YS)]
G['━'] = [hline(YH)]
G['│'] = [vline(XS)]
G['┌'] = [hline(YS, XS[0]), vline(XS, BOT, YS[1])]
G['┐'] = [hline(YS, L, XS[1]), vline(XS, BOT, YS[1])]
G['└'] = [hline(YS, XS[0]), vline(XS, YS[0], TOP)]
G['┘'] = [hline(YS, L, XS[1]), vline(XS, YS[0], TOP)]
G['├'] = [vline(XS), hline(YS, XS[0])]
G['┤'] = [vline(XS), hline(YS, L, XS[1])]
G['┬'] = [hline(YS), vline(XS, BOT, YS[1])]
G['┴'] = [hline(YS), vline(XS, YS[0], TOP)]
G['┼'] = [hline(YS), vline(XS)]
# double lines
G['═'] = [hline(YA), hline(YB)]
G['║'] = [vline(XA), vline(XB)]
G['╔'] = [vline(XA, BOT, YA[1]), hline(YA, XA[0]), vline(XB, BOT, YB[1]), hline(YB, XB[0])]
G['╗'] = [vline(XB, BOT, YA[1]), hline(YA, L, XB[1]), vline(XA, BOT, YB[1]), hline(YB, L, XA[1])]
G['╚'] = [vline(XA, YB[0], TOP), hline(YB, XA[0]), vline(XB, YA[0], TOP), hline(YA, XB[0])]
G['╝'] = [vline(XB, YB[0], TOP), hline(YB, L, XB[1]), vline(XA, YA[0], TOP), hline(YA, L, XA[1])]
G['╠'] = [vline(XA), vline(XB, YA[0], TOP), hline(YA, XB[0]), vline(XB, BOT, YB[1]), hline(YB, XB[0])]
G['╣'] = [vline(XB), vline(XA, YA[0], TOP), hline(YA, L, XA[1]), vline(XA, BOT, YB[1]), hline(YB, L, XA[1])]
G['╦'] = [hline(YA), vline(XA, BOT, YB[1]), hline(YB, L, XA[1]), vline(XB, BOT, YB[1]), hline(YB, XB[0])]
G['╩'] = [hline(YB), vline(XA, YA[0], TOP), hline(YA, L, XA[1]), vline(XB, YA[0], TOP), hline(YA, XB[0])]
G['╬'] = [vline(XA, YA[0], TOP), vline(XA, BOT, YB[1]), vline(XB, YA[0], TOP), vline(XB, BOT, YB[1]),
          hline(YA, L, XA[1]), hline(YA, XB[0]), hline(YB, L, XA[1]), hline(YB, XB[0])]
# blocks: full line box, eighths from the bottom
H = TOP - BOT
G['█'] = [(0, BOT, ADV, TOP)]
for k, ch in enumerate('▁▂▃▄▅▆▇', start=1):
    G[ch] = [(0, BOT, ADV, BOT + round(H * k / 8))]
G['▀'] = [(0, BOT + H // 2, ADV, TOP)]
# squares for progress lines and sliders
G['■'] = [(60, 80, 340, 360)]
G['□'] = [(60, 80, 340, 120), (60, 320, 340, 360), (60, 80, 100, 360), (300, 80, 340, 360)]

ARROWS = {
    '→': [[(40, 260), (40, 300), (240, 300), (240, 400), (360, 280), (240, 160), (240, 260)]],
    '←': [[(360, 260), (160, 260), (160, 160), (40, 280), (160, 400), (160, 300), (360, 300)]],
    '↑': [[(180, 40), (180, 440), (80, 440), (200, 600), (320, 440), (220, 440), (220, 40)]],
    '↓': [[(180, 600), (220, 600), (220, 200), (320, 200), (200, 40), (80, 200), (180, 200)]],
}


def glyph_name(ch: str) -> str:
    return f'uni{ord(ch):04X}'


def main() -> None:
    names = ['.notdef'] + [glyph_name(c) for c in list(G) + list(ARROWS)]
    fb = FontBuilder(1000, isTTF=True)
    fb.setupGlyphOrder(names)
    cmap = {ord(c): glyph_name(c) for c in list(G) + list(ARROWS)}
    fb.setupCharacterMap(cmap)
    glyphs = {}
    pen = TTGlyphPen(None)
    rect(pen, 40, 0, 360, 800)
    glyphs['.notdef'] = pen.glyph()
    for ch, rects in G.items():
        pen = TTGlyphPen(None)
        for r in rects:
            rect(pen, *r)
        glyphs[glyph_name(ch)] = pen.glyph()
    for ch, polys in ARROWS.items():
        pen = TTGlyphPen(None)
        for p in polys:
            poly(pen, p)
        glyphs[glyph_name(ch)] = pen.glyph()
    fb.setupGlyf(glyphs)
    glyf = fb.font['glyf']
    metrics = {}
    for n in names:
        g = glyf[n]
        g.recalcBounds(glyf)
        metrics[n] = (ADV, getattr(g, 'xMin', 0))  # lsb must equal xMin or renderers shift the outline
    fb.setupHorizontalMetrics(metrics)
    fb.setupHorizontalHeader(ascent=800, descent=-200)
    fb.setupNameTable({'familyName': 'HyperspaceBox', 'styleName': 'Regular'})
    fb.setupOS2(version=4, sTypoAscender=800, sTypoDescender=-200, sTypoLineGap=0, usWinAscent=1040, usWinDescent=240,
                fsSelection=0b11000000)
    fb.setupPost()
    out = Path(__file__).with_name('HyperspaceBox.ttf')
    fb.save(str(out))
    print(out, len(cmap), 'glyphs')


if __name__ == '__main__':
    main()
