/* ================= Furniture & extra products (ids 501+) =================
   Each 3D model is a list of simple parts (rounded boxes, cylinders, cushions) in metres, floor at y = 0.
   The same parts are used for the product photos (ray-marched renderer) and for the 3D room in the designer. */
const XB = (x, y, z, hx, hy, hz, c, m = 1, r = .02) => ({ s: 0, p: [x, y, z], h: [hx, hy, hz], c, m, r });
const XC = (x, y, z, rad, hh, c, m = 1, r = .01) => ({ s: 1, p: [x, y, z], h: [rad, hh, rad], c, m, r });
const XE = (x, y, z, hx, hy, hz, c, m = 7) => ({ s: 2, p: [x, y, z], h: [hx, hy, hz], c, m, r: 0 });
const XW = { wood: "#b98a5e", lwood: "#d9bb92", dwood: "#5e4030", white: "#f1efea", metal: "#2b2e31", linen: "#efe9df", steel: "#b9bdc0" };
const legs4 = (w, d, h, c, rad = .025, inset = .06) => [-1, 1].flatMap(i => [-1, 1].map(j => XC(i * (w / 2 - inset), h / 2, j * (d / 2 - inset), rad, h / 2, c, 3)));
const XMODELS = {
  bed_kid: (a, b = "#ffffff") => [XB(0, .2, 0, .44, .13, .84, a, 1, .03), XB(0, .4, .02, .4, .08, .79, XW.linen, 7, .06), XB(0, .56, -.83, .44, .44, .035, a, 1, .04), XB(0, .42, .83, .44, .28, .035, a, 1, .04),
    XE(0, .52, -.58, .27, .07, .14, b), XB(0, .495, .28, .41, .03, .5, b, 7, .03), ...legs4(.84, 1.64, .08, a, .03, .05)],
  bed_double: (a, b = "#e9e4da") => [XB(0, .2, 0, .84, .14, 1.04, a, 1, .03), XB(0, .41, .03, .8, .1, .99, XW.linen, 7, .07), XB(0, .62, -1.02, .86, .55, .07, a, 7, .07),
    XE(-.4, .56, -.78, .32, .08, .16, "#ffffff"), XE(.4, .56, -.78, .32, .08, .16, "#ffffff"), XB(0, .52, .32, .81, .035, .66, b, 7, .03), ...legs4(1.64, 2.04, .08, XW.metal, .025, .08)],
  bed_single: (a, b = "#dfe6ea") => [XB(0, .2, 0, .47, .13, 1.02, a, 5, .02), XB(0, .4, .02, .44, .09, .98, XW.linen, 7, .06), XB(0, .55, -1.0, .47, .42, .03, a, 5, .02), XE(0, .53, -.76, .3, .07, .14, "#ffffff"), XB(0, .505, .3, .45, .03, .64, b, 7, .03), ...legs4(.9, 2.0, .08, a, .03, .06)],
  sofa: (a, w = 2.1) => { const hw = w / 2; const n = w > 1.2 ? 3 : 1, cw = (w - .44) / n; const P = [XB(0, .27, .02, hw, .15, .44, a, 7, .06), XB(0, .62, -.33, hw - .02, .26, .12, a, 7, .1), XB(-hw + .1, .43, .02, .1, .21, .44, a, 7, .08), XB(hw - .1, .43, .02, .1, .21, .44, a, 7, .08)];
    for (let i = 0; i < n; i++) P.push(XB(-hw + .22 + cw * (i + .5), .48, .07, cw / 2 - .01, .07, .36, a, 7, .07));
    return [...P, ...legs4(w - .1, .82, .12, XW.dwood, .025, .06)]; },
  armchair: a => XMODELS.sofa(a, .86),
  desk: (a = XW.lwood, b = XW.metal) => [XB(0, .735, 0, .6, .02, .3, a, 5, .01), XB(.42, .44, 0, .16, .27, .28, a === XW.white ? "#e9e6df" : XW.white, 1, .015), XB(.42, .55, .285, .14, .06, .005, XW.metal, 3, .003), ...legs4(1.2, .6, .72, b, .018, .04).filter((_, i) => i < 2)],
  desk_kid: () => [XB(0, .64, 0, .5, .02, .27, XW.white, 1, .01), XB(-.38, .32, 0, .1, .3, .26, XW.white, 1, .01), XB(.38, .32, 0, .1, .3, .26, XW.white, 1, .01), XB(0, .98, -.22, .5, .02, .05, XW.lwood, 5, .01), XB(-.48, .82, -.22, .02, .17, .05, XW.white, 1, .005), XB(.48, .82, -.22, .02, .17, .05, XW.white, 1, .005)],
  table_dining: (a = XW.wood) => [XB(0, .735, 0, .7, .025, .4, a, 5, .015), ...legs4(1.4, .8, .71, a, .03, .08)],
  chair: (a, s = 1) => [XB(0, .46 * s, 0, .22 * s, .04, .22 * s, a, 7, .03), XB(0, .72 * s, -.2 * s, .21 * s, .2 * s, .025, a, 7, .03), ...legs4(.42 * s, .42 * s, .44 * s, XW.metal, .014, .03)],
  coffee: (a = XW.wood) => [XB(0, .41, 0, .5, .02, .28, a, 5, .015), XB(0, .14, 0, .46, .012, .24, a, 5, .01), ...legs4(1, .56, .4, XW.metal, .015, .04)],
  tvstand: (a = XW.white, b = XW.wood) => [XB(0, .25, 0, .8, .18, .2, a, 1, .02), XB(-.4, .25, .202, .38, .15, .004, b, 5, .004), XB(.4, .25, .202, .38, .15, .004, b, 5, .004), ...legs4(1.5, .36, .07, XW.metal, .015, .05)],
  dresser: (a = XW.white, b = XW.metal) => { const P = [XB(0, .45, 0, .45, .4, .22, a, 1, .02)]; for (let i = 0; i < 4; i++) { const y = .17 + i * .19; P.push(XB(0, y, .224, .42, .085, .004, a, 1, .005), XB(0, y + .04, .232, .07, .008, .008, b, 3, .004)); } return [...P, ...legs4(.84, .4, .06, XW.dwood, .02, .05)]; },
  rug: (a, b, w = 1.6, d = 2.3) => [XB(0, .006, 0, w / 2, .006, d / 2, b, 7, .004), XB(0, .009, 0, w / 2 - .09, .005, d / 2 - .09, a, 7, .004)],
  curtains: (a, w = 1.5, h = 2.5) => { const P = [XC(0, h, 0, .014, w / 2 + .14, XW.metal, 3)].map(q => ({ ...q, s: 1, h: [.014, w / 2 + .14, .014], rotZ: 1 }));
    const rod = XB(0, h + .01, 0, w / 2 + .14, .012, .012, XW.metal, 3, .01);
    const folds = []; for (const side of [-1, 1]) for (let k = 0; k < 6; k++) folds.push(XC(side * (w / 2 - .05 - k * .085), h / 2 - .02, (k % 2 ? .035 : -.005), .047, h / 2 - .03, a, 7, .02));
    return [rod, ...folds]; },
  rack_kid: () => { const P = [XB(-.44, .55, 0, .02, .55, .2, XW.white, 1, .006), XB(.44, .55, 0, .02, .55, .2, XW.white, 1, .006)]; for (let i = 0; i < 4; i++) P.push(XB(0, .03 + i * .35, 0, .44, .015, .2, XW.white, 1, .006));
    const cols = ["#f2a7b8", "#9cc3e6", "#f6d36b", "#9fd3b5", "#c9b6e8", "#f6a96b"]; let k = 0; for (let r = 0; r < 3; r++) for (let c = -1; c <= 1; c += 2) P.push(XB(c * .21, .18 + r * .35, .02, .19, .13, .17, cols[k++ % 6], 1, .03)); return P; },
  lamp_floor: (a = "#efe6d4") => [XC(0, .015, 0, .16, .015, XW.metal, 3), XC(0, .8, 0, .014, .78, XW.metal, 3), XC(0, 1.6, 0, .22, .13, a, 8, .02)],
  bucket: () => [],
  // models for existing catalog items (used only inside the 3D room)
  wardrobe: (a = XW.white, w = 1.5) => [XB(0, 1.1, 0, w / 2, 1.1, .3, a, 1, .02), XB(-w / 4, 1.1, .302, w / 4 - .01, 1.06, .004, a === XW.white ? "#e8e5de" : a, 2, .004), XB(w / 4, 1.1, .302, w / 4 - .01, 1.06, .004, "#cfd8dc", 2, .004)],
  shelf: (a = XW.white, w = .8) => [XB(0, 1.5, 0, w / 2, .02, .12, a, 1, .006)],
  chand: (a = "#f6efe0") => [XC(0, 2.45, 0, .02, .15, XW.metal, 3), XC(0, 2.25, 0, .3, .07, a, 8, .03)],
  ledpanel: () => [XC(0, 2.6, 0, .25, .03, "#fffbea", 8, .01)],
  door: (a = XW.wood) => [XB(0, 1.02, 0, .41, 1.02, .02, a, 5, .01), XB(.3, 1.0, .03, .06, .01, .01, XW.steel, 3, .005)]
};
/* Product list: [id, key, cat, sub, icon, ru, uz, unit, price, kg, stores, model, color(s), size [w,d] m, place] */
const XPRODUCTS = [
  [501, "paint_rose", "paint", "inter", "paint", "Краска интерьерная «Пудра», 2,5 л", "Ichki bo‘yoq «Pudra», 2,5 l", "l10", 26000, 3, "boyoq,usta", "bucket", ["#e7c3c8", "#c98b97", "PUDRA"], null, "paint"],
  [502, "paint_mint", "paint", "inter", "paint", "Краска интерьерная «Мята», 2,5 л", "Ichki bo‘yoq «Yalpiz», 2,5 l", "l10", 26000, 3, "boyoq,usta", "bucket", ["#bfe0cf", "#6fae90", "MINT"], null, "paint"],
  [503, "paint_lav", "paint", "inter", "paint", "Краска интерьерная «Лаванда», 2,5 л", "Ichki bo‘yoq «Lavanda», 2,5 l", "l10", 26000, 3, "boyoq,usta", "bucket", ["#d2c9e6", "#8f80b8", "LAVENDER"], null, "paint"],
  [510, "bed_kid_pink", "furn", "kids", "wardrobe", "Кровать детская 80×160, розовая", "Bolalar karavoti 80×160, pushti", "pcs", 1850000, 38, "uy", "bed_kid", ["#eaa9bb", "#ffe3ea"], [.88, 1.7], "wall"],
  [511, "bed_kid_blue", "furn", "kids", "wardrobe", "Кровать детская 80×160, голубая", "Bolalar karavoti 80×160, havorang", "pcs", 1850000, 38, "uy", "bed_kid", ["#9cc3e6", "#e3efff"], [.88, 1.7], "wall"],
  [512, "bed_kid_white", "furn", "kids", "wardrobe", "Кровать детская 80×160, белая", "Bolalar karavoti 80×160, oq", "pcs", 1750000, 38, "uy", "bed_kid", ["#f1efea", "#f6d36b"], [.88, 1.7], "wall"],
  [513, "bed_dbl_graphite", "furn", "bed", "wardrobe", "Кровать двуспальная 160×200, мягкая, графит", "Ikki kishilik karavot 160×200, yumshoq, grafit", "pcs", 4200000, 85, "uy", "bed_double", ["#5d6266", "#d9d4ca"], [1.72, 2.12], "wall"],
  [514, "bed_dbl_oak", "furn", "bed", "wardrobe", "Кровать двуспальная 160×200, дуб", "Ikki kishilik karavot 160×200, eman", "pcs", 3600000, 80, "uy", "bed_double", ["#b98a5e", "#e9e4da"], [1.72, 2.12], "wall"],
  [515, "bed_single", "furn", "bed", "wardrobe", "Кровать односпальная 90×200, светлый дуб", "Bir kishilik karavot 90×200, och eman", "pcs", 2100000, 45, "uy", "bed_single", ["#d9bb92", "#dfe6ea"], [.94, 2.04], "wall"],
  [520, "sofa_grey", "furn", "sofa", "wardrobe", "Диван трёхместный, серый", "Uch kishilik divan, kulrang", "pcs", 6900000, 80, "uy", "sofa", ["#737a80"], [2.1, .92], "wall"],
  [521, "sofa_beige", "furn", "sofa", "wardrobe", "Диван трёхместный, бежевый", "Uch kishilik divan, bej", "pcs", 6900000, 80, "uy", "sofa", ["#cdbb9e"], [2.1, .92], "wall"],
  [522, "sofa_emerald", "furn", "sofa", "wardrobe", "Диван трёхместный, изумрудный велюр", "Uch kishilik divan, zumrad velyur", "pcs", 8400000, 82, "uy", "sofa", ["#2f6b5a"], [2.1, .92], "wall"],
  [523, "armchair", "furn", "sofa", "wardrobe", "Кресло мягкое, горчичное", "Yumshoq kreslo, xantal rang", "pcs", 2300000, 25, "uy", "armchair", ["#d29b3a"], [.86, .92], "corner"],
  [530, "desk", "furn", "table", "wardrobe", "Стол письменный 120 см, светлый дуб", "Yozuv stoli 120 sm, och eman", "pcs", 1450000, 28, "uy", "desk", [], [1.2, .6], "window"],
  [531, "desk_kid", "furn", "kids", "wardrobe", "Стол детский с полкой, белый", "Bolalar stoli tokchali, oq", "pcs", 1150000, 22, "uy", "desk_kid", [], [1.0, .55], "window"],
  [532, "table_dining", "furn", "table", "wardrobe", "Стол обеденный 140 см, дуб", "Ovqat stoli 140 sm, eman", "pcs", 2700000, 35, "uy", "table_dining", [], [1.4, .8], "center"],
  [533, "chair_grey", "furn", "table", "wardrobe", "Стул мягкий, серый", "Yumshoq stul, kulrang", "pcs", 420000, 6, "uy", "chair", ["#737a80"], [.45, .45], "desk"],
  [534, "chair_kid", "furn", "kids", "wardrobe", "Стул детский, розовый", "Bolalar stuli, pushti", "pcs", 290000, 3, "uy", "chair", ["#eaa9bb", .8], [.38, .38], "desk"],
  [535, "coffee_table", "furn", "table", "wardrobe", "Столик журнальный, дуб", "Jurnal stolchasi, eman", "pcs", 790000, 14, "uy", "coffee", [], [1.0, .56], "front"],
  [536, "tvstand", "furn", "table", "wardrobe", "Тумба под ТВ 160 см", "TV tumbasi 160 sm", "pcs", 1250000, 32, "uy", "tvstand", [], [1.6, .42], "wall"],
  [537, "dresser", "furn", "ward", "wardrobe", "Комод, 4 ящика, белый", "Komod, 4 tortma, oq", "pcs", 1600000, 40, "uy", "dresser", [], [.9, .46], "wall"],
  [540, "rug_beige", "furn", "decor", "wardrobe", "Ковёр 160×230, бежевый", "Gilam 160×230, bej", "pcs", 1100000, 9, "uy", "rug", ["#d8c8ad", "#b49d79"], [1.6, 2.3], "rug"],
  [541, "rug_kid", "furn", "decor", "wardrobe", "Ковёр детский 120×170, розовый", "Bolalar gilami 120×170, pushti", "pcs", 690000, 5, "uy", "rug", ["#f3c3cf", "#ffffff", 1.2, 1.7], [1.2, 1.7], "rug"],
  [542, "rug_graphite", "furn", "decor", "wardrobe", "Ковёр 160×230, графит", "Gilam 160×230, grafit", "pcs", 1150000, 9, "uy", "rug", ["#5b6064", "#3a3e41"], [1.6, 2.3], "rug"],
  [543, "curt_grey", "furn", "decor", "wardrobe", "Шторы блэкаут, серые, пара", "Blekaut pardalar, kulrang, juft", "pair", 520000, 3, "uy", "curtains", ["#737a80"], [1.7, .1], "curtain"],
  [544, "curt_linen", "furn", "decor", "wardrobe", "Шторы лён, бежевые, пара", "Zig‘ir pardalar, bej, juft", "pair", 480000, 3, "uy", "curtains", ["#ddd0b8"], [1.7, .1], "curtain"],
  [545, "curt_pink", "furn", "decor", "wardrobe", "Шторы детские, розовые, пара", "Bolalar pardalari, pushti, juft", "pair", 450000, 3, "uy", "curtains", ["#f2b8c6"], [1.7, .1], "curtain"],
  [546, "rack_kid", "furn", "kids", "wardrobe", "Стеллаж детский с ящиками", "Bolalar stellaji qutichali", "pcs", 980000, 24, "uy", "rack_kid", [], [.92, .42], "wall"],
  [547, "lamp_floor", "light", "lamps", "bulb", "Торшер напольный", "Torsher", "pcs", 650000, 6, "uy,elp", "lamp_floor", [], [.44, .44], "corner"]
];
const XDESC = {
  kids: ["Детская мебель с закруглёнными углами и безопасными красками. Подходит для комнат от 9 м².", "Burchaklari dumaloq, xavfsiz bo‘yoqli bolalar mebeli. 9 m² dan xonalar uchun."],
  bed: ["Кровати с ортопедическим основанием, матрас подбирается отдельно.", "Ortopedik asosli karavotlar, matras alohida tanlanadi."],
  sofa: ["Мягкая мебель с износостойкой тканью, чехлы можно чистить.", "Chidamli matoli yumshoq mebel, g‘iloflarini tozalash mumkin."],
  table: ["Столы и стулья для дома и офиса. Сборка мастером — по запросу.", "Uy va ofis uchun stol va stullar. Usta yig‘ishi — so‘rov bo‘yicha."],
  decor: ["Ковры и шторы, которые завершают интерьер. Размеры указаны в названии.", "Interyerni yakunlaydigan gilam va pardalar. O‘lchamlar nomida ko‘rsatilgan."]
};
if (typeof module !== "undefined") module.exports = { XMODELS, XPRODUCTS, XW };
