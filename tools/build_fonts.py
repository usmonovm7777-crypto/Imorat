#!/usr/bin/env python3
"""The site's own copies of its three typefaces (Unbounded, Golos Text, JetBrains Mono — all under the SIL Open Font License).

Why: the fonts used to come from Google Fonts — a stylesheet from one more server and the font files from a third one. Served
from the site itself they need no extra connections, cannot hold the first paint, and work in the installed app offline.

What it writes:
  fonts/<name>.<hash>.woff2   each face cut down to the letters the site uses (Latin, Cyrillic, punctuation, signs) and to the
                              weights the styles ask for; one variable file per family
  tools/fonts.json            the @font-face rules for build_site.py, plus stand-in faces ("… Fallback") — a system font
                              scaled to the web font's width, so text does not re-wrap when the web font arrives
Run it only when the typefaces, the weights or the alphabet change:
  python3 tools/build_fonts.py /path/to/a/checkout/of/github.com/google/fonts
Needs fontTools; WOFF2 needs the "brotli" module — without it tools/_brotli_shim (Node's built-in brotli) is used."""
import sys, io, json, hashlib, pathlib, re
ROOT = pathlib.Path(__file__).resolve().parent.parent
try: import brotli  # noqa: F401
except ImportError: sys.path.insert(0, str(ROOT / "tools" / "_brotli_shim"))
from fontTools.ttLib import TTFont
from fontTools.varLib import instancer
from fontTools import subset

GF = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else "google-fonts")
FACES = [  # family, source file, weight range kept (None = all the styles ask for is one weight)
    ("Unbounded", "ofl/unbounded/Unbounded[wght].ttf", (500, 700), "unbounded"),
    ("Golos Text", "ofl/golostext/GolosText[wght].ttf", (400, 700), "golos"),
    ("JetBrains Mono", "ofl/jetbrainsmono/JetBrainsMono[wght].ttf", (500, 500), "jbmono"),
]
# the alphabet, in two parts. "base": everything the page itself contains (its three languages, the demo catalogue), ASCII
# and the Russian letters — the file every visitor gets. "ext": the rest of Latin and Cyrillic for what people type
# (names, addresses, reviews) — a second file the browser fetches only when such a letter is on the screen (unicode-range).
page = (ROOT / "src" / "page.html").read_text(encoding="utf-8")
base = {ord(c) for c in page if ord(c) >= 0x20} | set(range(0x20, 0x7F)) | set(range(0x410, 0x450)) | {0x401, 0x451, 0xA0, 0xAB, 0xBB, 0x2013, 0x2014, 0x2018, 0x2019, 0x201C, 0x201D, 0x201E, 0x2026, 0x2116}
ext = set()
for a, b in [(0xA0, 0xFF), (0x100, 0x17F), (0x2B9, 0x2BC), (0x400, 0x45F), (0x48A, 0x4FF), (0x2010, 0x2027), (0x2030, 0x203A), (0x20A0, 0x20BF), (0x2122, 0x2122), (0x2190, 0x2193), (0x2212, 0x2212), (0x2248, 0x2265)]:
    ext.update(range(a, b + 1))
ext -= base
def urange(cs):
    cs = sorted(cs); out = []; i = 0
    while i < len(cs):
        j = i
        while j + 1 < len(cs) and cs[j + 1] == cs[j] + 1: j += 1
        out.append(f"U+{cs[i]:X}" + (f"-{cs[j]:X}" if j > i else "")); i = j + 1
    return ",".join(out)

def advances(font, wght=None):
    """char → advance width in em, at one weight of a variable font"""
    f = font if wght is None else instancer.instantiateVariableFont(font, {"wght": wght, **{a.axisTag: a.defaultValue for a in font["fvar"].axes if a.axisTag != "wght"}}, inplace=False)
    cmap, hmtx, upm = f.getBestCmap(), f["hmtx"], f["head"].unitsPerEm
    return {c: hmtx[g][0] / upm for c, g in cmap.items()}

# the text whose width must match: the site's own Russian words (letters weighted by how often the page uses them)
sample = re.sub(r"<[^>]+>", " ", page)
freq = {}
for c in sample:
    if c.isalpha() and (0x400 <= ord(c) <= 0x4FF) or c in " 0123456789": freq[ord(c)] = freq.get(ord(c), 0) + 1
def mean_width(adv): 
    tot = sum(n for c, n in freq.items() if c in adv); return sum(adv[c] * n for c, n in freq.items() if c in adv) / tot

out, css, fb = {}, [], []
for family, src, (lo, hi), slug in FACES:
    f = TTFont(str(GF / src))
    limits = {"wght": (lo, hi) if lo != hi else lo}
    limits.update({a.axisTag: a.defaultValue for a in f["fvar"].axes if a.axisTag != "wght"})
    inst = instancer.instantiateVariableFont(f, limits, inplace=False)
    _b = io.BytesIO(); inst.save(_b); inst = TTFont(io.BytesIO(_b.getvalue()))  # (a clean copy: the subsetter trips over the instancer's lazily loaded tables)
    out[slug] = {}
    for part, want in (("", base), ("-ext", ext)):
        one = TTFont(io.BytesIO(_b.getvalue()))
        have = sorted(c for c in want if c in one.getBestCmap())
        if not have: continue
        opt = subset.Options(); opt.layout_features = ["kern", "liga", "locl", "mark", "mkmk", "ccmp", "calt", "tnum", "lnum", "case"]; opt.hinting = False; opt.notdef_outline = True; opt.name_IDs = [1, 2, 3, 4, 6]; opt.drop_tables += ["DSIG"]
        ss = subset.Subsetter(opt); ss.populate(unicodes=have); ss.subset(one)
        one.flavor = "woff2"; buf = io.BytesIO(); one.save(buf); data = buf.getvalue()
        name = f"{slug}{part}.{hashlib.sha256(data).hexdigest()[:8]}.woff2"
        for old in (ROOT / "fonts").glob(f"{slug}{part}.*.woff2"):
            if re.fullmatch(re.escape(slug + part) + r"\.[0-9a-f]{8}\.woff2", old.name): old.unlink()
        (ROOT / "fonts" / name).write_bytes(data)
        css.append(f'@font-face{{font-family:"{family}";src:url(fonts/{name}) format("woff2");font-weight:{lo if lo == hi else f"{lo} {hi}"};font-style:normal;font-display:swap;unicode-range:{urange(have)}}}')
        out[slug]["file" + part] = "fonts/" + name; out[slug]["bytes" + part] = len(data); out[slug]["glyphs" + part] = len(have)
    hh = f["hhea"]; upm = f["head"].unitsPerEm
    # the stand-ins: Arial (measured on Arimo, its metric twin) for computers and iPhones, Roboto for Android
    if slug == "jbmono": continue
    w = 700 if slug == "unbounded" else 400  # headings are set bold, text regular
    own = mean_width(advances(f, w))
    for label, path, local in (("", "ofl/arimo/Arimo[wght].ttf", ["Arial Bold", "Arial-BoldMT", "Arial"] if w == 700 else ["Arial", "ArialMT"]), (" R", "ofl/roboto/Roboto[wdth,wght].ttf", ["Roboto Bold", "Roboto-Bold", "Roboto"] if w == 700 else ["Roboto", "Roboto-Regular"])):
        ref = mean_width(advances(TTFont(str(GF / path)), w)); k = own / ref
        fb.append(f'@font-face{{font-family:"{family} Fallback{label}";src:{",".join(f"local(\"{n}\")" for n in local)};size-adjust:{k * 100:.1f}%;ascent-override:{hh.ascent / upm / k * 100:.1f}%;descent-override:{-hh.descent / upm / k * 100:.1f}%;line-gap-override:0%}}')
        out[slug]["fallback" + label.strip()] = round(k, 4)
(ROOT / "tools" / "fonts.json").write_text(json.dumps({"faces": "".join(css), "fallbacks": "".join(fb), "files": out}, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
print(json.dumps(out, indent=1))
