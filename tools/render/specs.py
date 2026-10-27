"""Render specs for every product id (1..96) of the Imorat catalog."""
import colorsys

CAT_H = {"build": 32, "metal": 210, "tools": 14, "fasten": 255, "plumb": 196, "heat": 6, "elec": 46, "light": 52,
         "paint": 330, "wall": 280, "tile": 176, "floor": 24, "doors": 98, "kitchen": 140, "furn": 36, "garden": 118,
         "security": 228, "work": 60, "house": 300}
CAT_OF = {}
ranges = [("build", 1, 14), ("metal", 15, 18), ("tools", 19, 26), ("fasten", 27, 29), ("plumb", 30, 38), ("heat", 39, 43),
          ("elec", 44, 50), ("light", 51, 54), ("paint", 55, 60), ("wall", 61, 63), ("tile", 64, 67), ("floor", 68, 71),
          ("doors", 72, 75), ("kitchen", 76, 79), ("furn", 80, 83), ("garden", 84, 87), ("security", 88, 90), ("work", 91, 93), ("house", 94, 96)]
for c, a, b in ranges:
    for i in range(a, b + 1):
        CAT_OF[i] = c

def bg_for(i):
    h = CAT_H[CAT_OF[i]] / 360
    r, g, b = colorsys.hls_to_rgb(h, 0.905, 0.16)
    return "#%02x%02x%02x" % (round(r * 255), round(g * 255), round(b * 255))

# material types: 0 matte,1 satin,2 glossy,3 colored metal,4 brushed,5 wood,6 porous,7 fabric,8 emissive,11 marble,12 wallpaper,13 mosaic,14 painted metal
M = {n: i for i, n in enumerate("""bag bricks gasblock sheets channels pack foamboards corrugated beams rebar profpipe drill grinder hammer sdset tape laser discs fasteners faucet toilet basin bath shower pipes waterheater boiler radiator ac fan coil socket breaker extension bulb ledpanel chandelier flood bucket roller can wallpaper pvcpanels tiles planks bigroll door window handle cabinet countertop hood rack shovel hose mangal gardenset lock camera gloves helmet boots mop ladder container""".split())}

TALL = [1.15, 11.5, .3, .62]
LOW = [.3, 8.2, .62, .55]
CAM = {
    "bag": [1.0, 10.2, .3, .6], "bricks": [.45, 8.4, .42, .62], "gasblock": [.6, 9.4, .38, .62], "sheets": [.25, 9.0, .5, .6],
    "channels": [.15, 9.0, .55, .6], "pack": [.65, 9.2, .36, .6], "foamboards": [.45, 8.8, .45, .6], "corrugated": [.2, 9.4, .55, .6],
    "beams": [.25, 9.4, .5, .62], "rebar": [.25, 9.4, .5, .6], "profpipe": [.25, 9.2, .48, .62], "drill": [.85, 9.6, .3, .7],
    "grinder": [.3, 9.0, .5, .55], "hammer": LOW, "sdset": [.2, 7.8, .62, .55], "tape": [.55, 8.0, .36, .62], "laser": [.6, 7.4, .36, .62],
    "discs": [.15, 7.6, .7, .55], "fasteners": [.15, 6.6, .66, .55], "faucet": [.65, 7.4, .32, .7], "toilet": [.75, 9.4, .36, .62],
    "basin": [.7, 9.0, .34, .62], "bath": [.4, 11.0, .42, .62], "shower": [1.2, 10.6, .26, .62], "pipes": [.25, 9.0, .5, .6], "waterheater": [1.05, 10.4, .3, .62],
    "boiler": [1.0, 10.2, .3, .62], "radiator": [.65, 9.2, .33, .55], "ac": [1.0, 11.0, .3, .62], "fan": [.6, 7.6, .3, .45],
    "coil": [.35, 7.8, .5, .6], "socket": [.55, 7.6, .26, .45], "breaker": [.55, 7.8, .32, .55], "extension": [.2, 8.6, .58, .55],
    "bulb": [.95, 8.2, .25, .62], "ledpanel": [.85, 9.0, .26, .5], "chandelier": [1.65, 11.0, .2, .62], "flood": [.75, 9.0, .32, 1.0],
    "bucket": [.7, 8.4, .36, .62], "roller": [.3, 8.4, .62, .55], "can": [1.0, 9.4, .3, .62], "wallpaper": [.45, 8.4, .42, .6],
    "pvcpanels": [.2, 9.2, .55, .6], "tiles": [.6, 9.4, .4, .62], "planks": [.25, 9.4, .5, .6], "bigroll": [.35, 9.4, .48, .6],
    "door": [1.08, 11.0, .22, .55], "window": [.8, 9.6, .25, .5], "handle": [.8, 8.6, .26, .55], "cabinet": [.6, 9.4, .34, .62], "wardrobe": [1.12, 13.2, .24, .62],
    "countertop": [.15, 9.2, .55, .6], "hood": [1.15, 10.0, .25, .6], "rack": [1.0, 11.4, .28, .62], "shovel": LOW, "hose": [.3, 8.0, .55, .6],
    "mangal": [.6, 9.6, .4, .62], "gardenset": [.55, 10.2, .4, .62], "lock": [.6, 8.4, .3, .55], "camera": [.5, 7.4, .3, .7],
    "gloves": [.1, 7.0, .75, .5], "helmet": [.4, 7.4, .4, .62], "boots": [.55, 8.6, .36, .6], "mop": [1.0, 10.6, .3, .62],
    "ladder": [1.0, 11.0, .26, .62], "container": [.55, 9.2, .38, .62],
}
TEAL, ORANGE = "#0B6E69", "#E8662A"

def S(model, **kw):
    d = {"m": M[model], "model": model, "cam": CAM[model]}
    d.update(kw)
    return d

def bag(big, sub, kg, paper, band=TEAL, accent=ORANGE, line="", ink="#1b1b1b"):
    return dict(lm=1, lr=[-.62, .14, .62, 1.84], label=dict(kind="bag", big=big, sub=sub, kg=kg, paper=paper, band=band, accent=accent, line=line, ink=ink), a=paper, ma=0)

SPECS = {
    1: S("bag", **bag("M400", "PORTLANDSEMENT D20", "50 kg", "#c9b48d", line="GOST 10178-85")),
    2: S("bag", **bag("GIPS", "SUVOQ · PLASTER", "30 kg", "#e9e6df", band="#2b5ea7", accent="#2b5ea7", line="MASHINA / QO'L")),
    3: S("bag", **bag("FINISH", "SHPAKLYOVKA", "20 kg", "#f1efe9", band="#3f8f4e", accent="#3f8f4e", line="OQ · WHITE")),
    4: S("bag", **bag("KLEY", "KAFEL YELIMI · C1T", "25 kg", "#a9aeb1", band="#b3261e", accent="#b3261e", line="KERAMOGRANIT UCHUN")),
    5: S("bricks", a="#a24a32", ma=6),
    6: S("gasblock", a="#e4e1da", ma=6),
    7: S("sheets", a="#a9c2a6", ma=0),
    8: S("channels", a="#c6c9cc", ma=4),
    9: S("pack", a="#f0c63c", ma=2, lm=1, lr=[-.78, .22, .78, 1.02], label=dict(kind="front", big="MINERAL WOOL", sub="50 mm · 6 m²", paper="#f0c63c", line="ISSIQLIK IZOLYATSIYASI", h=560)),
    10: S("foamboards", a="#f4f4f1", ma=6),
    11: S("corrugated", a="#c3c7cb", ma=4, v=0),
    12: S("corrugated", a="#6a3226", ma=14, v=1),
    13: S("beams", a="#d9b27c", ma=5),
    14: S("sheets", a="#dcc092", ma=5),
    15: S("rebar", a="#5a4a40", ma=14, b="#2a2a2a", mb=1),
    16: S("rebar", a="#61534a", ma=14, b="#2a2a2a", mb=1),
    17: S("profpipe", a="#4f5559", ma=14),
    18: S("sheets", a="#c8ccd0", ma=4),
    19: S("drill", a=TEAL, ma=1, b="#f0c12e", mb=1, v=1),
    20: S("drill", a=ORANGE, ma=1, b="#222222", mb=1, v=0),
    21: S("grinder", a=TEAL, ma=1, b="#2c3a5e", mb=0),
    22: S("hammer", b="#d04a1c", mb=1),
    23: S("sdset", a="#c62f2f", ma=2, b="#f0c12e", mb=2),
    24: S("laser", a="#3c9a3c", ma=1),
    25: S("tape", a="#f2c230", ma=1, b="#f2d64a", mb=2),
    26: S("discs", a="#24376b", ma=0, lm=3, lr=[-.85, -.85, .85, .85], label=dict(kind="disc", big="125", sub="1.2 mm")),
    27: S("fasteners", a="#d0b25a", ma=3, v=0),
    28: S("fasteners", a="#9da3a6", ma=1, v=1),
    29: S("fasteners", a="#c0c4c8", ma=3, v=2),
    30: S("faucet", v=0),
    31: S("faucet", v=1),
    32: S("toilet"),
    33: S("basin", v=0),
    34: S("bath"),
    35: S("shower", b="#e9e6e0", mb=2),
    36: S("pipes", a="#eceeed", ma=1, v=0),
    37: S("pipes", a="#e9ebea", ma=1, v=1),
    38: S("waterheater", a="#f3f4f3", ma=2, e="#3fa8ff"),
    39: S("boiler", a="#f2f3f2", ma=2, e="#58c6ff"),
    40: S("radiator", a="#f5f5f3", ma=2, v=0),
    41: S("radiator", a="#f2f2f0", ma=2, v=1),
    42: S("ac", a="#f6f6f4", ma=2, e="#7fd4ff"),
    43: S("fan", a="#f2f2f0", ma=1),
    44: S("coil", a="#1d1d1f", ma=2, b="#c0392b", mb=1, v=0),
    45: S("coil", a="#f2f2f2", ma=2, b="#2f6fc7", mb=1, v=1),
    46: S("socket", a="#f5f5f2", ma=2, v=0),
    47: S("socket", a="#f5f5f2", ma=2, v=1, e="#ff8a3d"),
    48: S("breaker", a="#ecebe7", ma=1, b="#1f3e8a", mb=1, v=0),
    49: S("breaker", a="#f1f1ee", ma=1, b="#c9c9c9", mb=1, v=1),
    50: S("extension", a="#f3f3f0", ma=2, b="#d63a2f", mb=2),
    51: S("chandelier", b="#c9a24a", mb=3),
    52: S("ledpanel", a="#f2f2f0", ma=1, e="#f6f8ff"),
    53: S("bulb"),
    54: S("flood", a="#2b2e31", ma=14, e="#eef4ff"),
    55: S("bucket", a="#fbfbfa", ma=2, b="#e7e7e5", mb=2, v=0, lm=2, lr=[0, .12, 1, 1.02], lc=[0, 0, 0], label=dict(kind="wrap", big="INTERIOR", sub="MAT · OQ · WHITE", vol="10 L", accent=TEAL, accent2=ORANGE, u=.6, h=480, pw=760)),
    56: S("bucket", a="#fbfbfa", ma=2, b="#e7e7e5", mb=2, v=1, lm=2, lr=[0, .14, 1, 1.15], lc=[0, 0, 0], label=dict(kind="wrap", big="FASAD", sub="OB-HAVOGA CHIDAMLI", vol="15 L", accent="#2b5ea7", accent2="#f0c12e", u=.6, h=520, pw=760)),
    57: S("bucket", a="#f5f5f2", ma=2, b="#2b5ea7", mb=2, v=2, lm=1, lr=[-.36, .18, .36, 1.0], label=dict(kind="front", big="GRUNT", sub="CHUQUR SINGUVCHI · 10 L", paper="#ffffff", band="#2b5ea7", accent="#2b5ea7", line="ICHKI / TASHQI", h=1170)),
    58: S("can", a="#2f8a4f", ma=3, b="#1a1a1a", mb=1, v=0, lm=2, lr=[0, .08, 1, 1.5], lc=[0, 0, 0], label=dict(kind="wrap", big="PRO FOAM", sub="MONTAJ KO'PIGI · 750 ml", vol="", paper="#2f8a4f", ink="#ffffff", ink2="#e6f2ea", accent="#1d5e35", accent2=ORANGE, u=.6, h=1150, pw=560)),
    59: S("can", a="#ffffff", ma=2, b="#e8e8e6", mb=1, v=1, lm=4, lr=[0, -.6, .6, .6], lc=[-.25, .26, 0], label=dict(kind="sleeve", big="SILIKON", sub="SANITAR · OQ · 280 ml", accent="#2b8bd1", accent2="#0d4c7a")),
    60: S("roller", a="#f2f0ea", ma=7, b="#1f6fb2", mb=1),
    61: S("wallpaper", a="#e9dcc3", ma=12, b="#b08d57"),
    62: S("pvcpanels", a="#f4f4f2", ma=2),
    63: S("bag", **bag("KOROED", "DEKORATIV SUVOQ", "25 kg", "#ebe7de", band="#7a4b8a", accent="#7a4b8a", line="FASAD · INTERYER")),
    64: S("tiles", a="#f3f3f1", ma=2, v=0),
    65: S("tiles", a="#d9c7a8", ma=6, v=1),
    66: S("tiles", a="#a7aaac", ma=11, v=2),
    67: S("tiles", a="#2f7fb0", ma=13, b="#9fd8e6", mb=2, v=3),
    68: S("planks", a="#c9a06d", ma=5, v=0),
    69: S("bigroll", a="#b98a5a", ma=5, v=0),
    70: S("planks", a="#e2cfa6", ma=5, v=1),
    71: S("bigroll", a="#6f7f8f", ma=7, v=1),
    72: S("door", a="#f3f2ee", ma=1, b="#ecebe6", mb=1, v=0),
    73: S("door", a="#3a3330", ma=14, b="#2a2624", mb=14, v=1),
    74: S("window", a="#f7f7f5", ma=1),
    75: S("handle", b="#c9a27a", mb=5),
    76: S("cabinet", a="#8fa694", ma=1, b="#d8d4cc", mb=11, v=0),
    77: S("countertop", a="#d6d2ca", ma=11),
    78: S("basin", a="#c8ccd0", ma=4, v=1),
    79: S("hood", a="#c8ccd0", ma=4),
    80: S("cabinet", a="#d8b98e", ma=5, v=1, cam=CAM["wardrobe"]),
    81: S("rack", a="#9aa1a6", ma=14, b="#c79a62", mb=0, v=0),
    82: S("rack", a="#c9a06d", ma=5, b="#ece6dc", mb=0, v=1),
    83: S("basin", a="#f1efe9", ma=1, v=2),
    84: S("shovel", a="#2f6b3a", ma=14, b="#c8a06a", mb=5),
    85: S("hose", a="#3f9b3a", ma=2),
    86: S("gardenset", a="#b07a45", ma=5, b="#8a5a32", mb=5),
    87: S("mangal", a="#2b2b2c", ma=14),
    88: S("lock"),
    89: S("camera", a="#f4f4f2", ma=2),
    90: S("cabinet", a="#4b5157", ma=14, v=2, e="#7cf0a8"),
    91: S("gloves", a="#f2efe6", ma=7, b="#2a62b8"),
    92: S("helmet", a="#f2b51d", ma=2),
    93: S("boots", a="#4a3426", ma=1),
    94: S("mop", a="#2a7fc4", ma=2, b="#e9e9e6", mb=1),
    95: S("ladder", a="#c4c8cc", ma=4, b=ORANGE, mb=1),
    96: S("container", a="#cfe3ea", ma=2, b="#2e8f8a", mb=1),
}
for i, s in SPECS.items():
    s.setdefault("bg", bg_for(i))
assert len(SPECS) == 96
