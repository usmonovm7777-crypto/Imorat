"""Imorat Go logo: SVG with outlined type (no font needed to view), several layouts and colour versions.
Writes to ./out: wordmark + mark (horizontal), stacked, mark only, monochrome, inverted, app icons, favicon, OG image."""
import os, math
from fontTools.ttLib import TTFont
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "out")
os.makedirs(OUT, exist_ok=True)
TEAL, ORANGE, DTEAL, INK, PAPER = "#0B6E69", "#D9530A", "#2E8F89", "#131B1A", "#F3F5F2"
LTEAL = "#3DB3AA"  # teal for dark backgrounds (the site's dark-theme accent)
FONT = "/usr/share/fonts/opentype/inter/InterDisplay-Black.otf"

font = TTFont(FONT); UPM = font["head"].unitsPerEm; cmap = font.getBestCmap(); glyphs = font.getGlyphSet(); hmtx = font["hmtx"]
# manual kerning for the pairs in the wordmark (em units ×1000), tuned by eye on the render
KERN = {("r", "a"): -28, ("a", "t"): -10, ("m", "o"): -8, ("o", "r"): -6, ("g", "o"): -12, ("i", "m"): -6}

def word_paths(text, size, x=0.0, y=0.0, tracking=-0.015, fill=INK):
    """Outlines of `text` at `size` px with the baseline at `y`; returns (svg, advance)."""
    s = size / UPM; pen_out = []; cx = x; prev = None
    for ch in text:
        g = cmap[ord(ch)]
        if prev and (prev, ch) in KERN: cx += KERN[(prev, ch)] / 1000 * size
        if ch != " ":
            sp = SVGPathPen(glyphs); tp = TransformPen(sp, (s, 0, 0, -s, cx, y)); glyphs[g].draw(tp)
            pen_out.append(f'<path d="{sp.getCommands()}" fill="{fill}"/>')
        cx += hmtx[g][0] * s + tracking * size
        prev = ch
    return "".join(pen_out), cx - x

def mark(x, y, size, cols=(TEAL, ORANGE, DTEAL, TEAL), gap=0.09, radius=0.11, variant="grid", arrow_col="#FFFFFF"):
    """The Imorat Go mark: four rounded tiles in a grid; in the "go" variant the orange tile breaks out to the right."""
    c = size * (1 - gap) / 2; g = size * gap; r = size * radius; out = []
    pos = [(0, 0), (c + g, 0), (0, c + g), (c + g, c + g)]
    if variant == "go":
        pos[1] = (c + g + size * 0.16, -size * 0.16)  # the orange tile slides out: movement, "go"
    for i, ((px, py), col) in enumerate(zip(pos, cols)):
        out.append(f'<rect x="{x + px:.2f}" y="{y + py:.2f}" width="{c:.2f}" height="{c:.2f}" rx="{r:.2f}" fill="{col}"/>')
        if variant == "arrow" and i == 1:  # a chevron in the orange tile: forward, delivery, "go"
            cx, cy, k = x + px + c / 2, y + py + c / 2, c * 0.21
            out.append(f'<path d="M{cx - k * 0.55:.2f} {cy - k:.2f} L{cx + k * 0.45:.2f} {cy:.2f} L{cx - k * 0.55:.2f} {cy + k:.2f}" fill="none" stroke="{arrow_col}" stroke-width="{c * 0.13:.2f}" stroke-linecap="round" stroke-linejoin="round"/>')
    return "".join(out)

def svg(w, h, body, bg=None, title="Imorat Go"):
    bgrect = f'<rect width="{w}" height="{h}" fill="{bg}"/>' if bg else ""
    return f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {w} {h}" width="{w}" height="{h}" role="img" aria-label="{title}">{bgrect}{body}</svg>'

def horizontal(variant="grid", ink=INK, teal=TEAL, cols=None, bg=None, pad=24):
    size = 100  # type size
    m = size * 0.96; mx, my = pad, pad + (size * 0.74 - m) / 2 + size * 0.1
    base = pad + size * 0.84
    tx = mx + m + size * 0.28
    w1, adv1 = word_paths("imorat", size, tx, base, fill=ink)
    w2, adv2 = word_paths("go", size, tx + adv1 + size * 0.2, base, fill=teal)
    total_w = tx + adv1 + size * 0.2 + adv2 + pad
    body = mark(mx, my, m, cols or (TEAL, ORANGE, DTEAL, TEAL), variant=variant) + w1 + w2
    return svg(round(total_w), round(pad * 2 + size * 1.0), body, bg)

def stacked(variant="grid", ink=INK, teal=TEAL, cols=None, bg=None):
    size = 120; m = 150; pad = 40
    w1, adv1 = word_paths("imorat", size, 0, 0, fill=ink)
    w2, adv2 = word_paths("go", size, 0, 0, fill=teal)
    line = adv1 + size * 0.2 + adv2
    W = max(line, m) + pad * 2; cx = W / 2
    body = mark(cx - m / 2, pad, m, cols or (TEAL, ORANGE, DTEAL, TEAL), variant=variant)
    base = pad + m + size * 0.98
    tx = cx - line / 2
    body += word_paths("imorat", size, tx, base, fill=ink)[0] + word_paths("go", size, tx + adv1 + size * 0.2, base, fill=teal)[0]
    return svg(round(W), round(base + size * 0.32 + pad * 0.6), body, bg)

def icon(size=512, bg=TEAL, cols=(PAPER, ORANGE, "#CFE8E5", PAPER), variant="grid", maskable=False):
    # app icon: a tile of the brand colour with the mark; maskable keeps the mark inside the 80% safe zone
    inset = size * (0.26 if maskable else 0.2); m = size - inset * 2
    r = 0 if maskable else size * 0.22
    body = f'<rect width="{size}" height="{size}" rx="{r}" fill="{bg}"/>' + mark(inset, inset, m, cols, variant=variant)
    return svg(size, size, body)

def og(variant="grid"):
    W, H = 1200, 630
    body = f'<rect width="{W}" height="{H}" fill="{PAPER}"/>'
    body += f'<rect x="0" y="0" width="{W}" height="{H}" fill="url(#g)"/>'
    defs = f'<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#0E3F3C"/><stop offset="1" stop-color="#0B6E69"/></linearGradient></defs>'
    size = 150; m = 160; x0 = 90; base = 300
    body += mark(x0, base - m + 14, m, (LTEAL, "#FF8040", "#1E6F6A", LTEAL), variant=variant)
    tx = x0 + m + 44
    w1, a1 = word_paths("imorat", size, tx, base, fill="#FFFFFF"); w2, a2 = word_paths("go", size, tx + a1 + size * 0.2, base, fill=LTEAL)
    body += w1 + w2
    sub = word_paths_light("Стройматериалы из магазинов Ташкента · доставка · мастера", 32, x0, 400, fill="#CFE3E0")
    body += sub
    return svg(W, H, defs + body)

_light = TTFont("/usr/share/fonts/opentype/inter/InterDisplay-Medium.otf"); _lg = _light.getGlyphSet(); _lc = _light.getBestCmap(); _lh = _light["hmtx"]
def word_paths_light(text, size, x, y, fill=INK):
    s = size / UPM; out = []; cx = x
    for ch in text:
        g = _lc.get(ord(ch)) or _lc[ord("?")]
        if ch != " ":
            sp = SVGPathPen(_lg); tp = TransformPen(sp, (s, 0, 0, -s, cx, y)); _lg[g].draw(tp); out.append(f'<path d="{sp.getCommands()}" fill="{fill}"/>')
        cx += _lh[g][0] * s
    return "".join(out)

def mark_only(size=200, cols=(TEAL, ORANGE, DTEAL, TEAL), bg=None, pad=0.0, variant="arrow", arrow_col="#FFFFFF"):
    inset = size * pad; return svg(size, size, mark(inset, inset, size - inset * 2, cols, variant=variant, arrow_col=arrow_col), bg)

def splash(size=2732, bg=PAPER, cols=(TEAL, ORANGE, DTEAL, TEAL)):
    m = size * 0.22; return svg(size, size, mark((size - m) / 2, (size - m) / 2, m, cols, variant="arrow"), bg)

DARKCOLS = (LTEAL, "#FF8040", "#1E6F6A", LTEAL)
ICONCOLS = (PAPER, ORANGE, "#CFE8E5", PAPER)
if __name__ == "__main__":
    v = "arrow"; files = {}
    files["imorat-go-logo.svg"] = horizontal(v)
    files["imorat-go-logo-dark.svg"] = horizontal(v, ink="#FFFFFF", teal=LTEAL, cols=DARKCOLS, bg=None)
    files["imorat-go-logo-mono.svg"] = horizontal(v, ink=INK, teal=INK, cols=(INK, INK, INK, INK))
    files["imorat-go-logo-white.svg"] = horizontal(v, ink="#FFFFFF", teal="#FFFFFF", cols=("#FFFFFF",) * 4, bg=None)
    files["imorat-go-logo-white.svg"] = files["imorat-go-logo-white.svg"].replace('stroke="#FFFFFF"', f'stroke="{TEAL}"')
    files["imorat-go-logo-stacked.svg"] = stacked(v)
    files["imorat-go-logo-stacked-dark.svg"] = stacked(v, ink="#FFFFFF", teal=LTEAL, cols=DARKCOLS)
    files["imorat-go-mark.svg"] = mark_only(200)
    files["imorat-go-mark-mono.svg"] = mark_only(200, cols=(INK,) * 4)
    files["icon-512.svg"] = icon(512, variant=v, cols=ICONCOLS)
    files["maskable-512.svg"] = icon(512, variant=v, cols=ICONCOLS, maskable=True)
    files["telegram-avatar.svg"] = mark_only(640, cols=ICONCOLS, bg=TEAL, pad=0.27)
    files["telegram-avatar-dark.svg"] = mark_only(640, cols=DARKCOLS, bg="#0E1514", pad=0.27)
    files["og-image.svg"] = og(v)
    files["app-icon-only.svg"] = icon(1024, variant=v, cols=ICONCOLS)
    files["app-icon-foreground.svg"] = mark_only(1024, cols=ICONCOLS, pad=0.3)
    files["app-icon-background.svg"] = svg(1024, 1024, f'<rect width="1024" height="1024" fill="{TEAL}"/>')
    files["app-splash.svg"] = splash()
    files["app-splash-dark.svg"] = splash(bg="#0E1514", cols=DARKCOLS)
    for n, t in files.items(): open(os.path.join(OUT, n), "w", encoding="utf-8").write(t)
    print("wrote", len(files))
