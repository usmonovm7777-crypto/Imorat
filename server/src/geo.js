/* Address search for the checkout map: suggestions while typing and "what is at this point" when the pin is moved.
   With YANDEX_MAPS_KEY (the "JavaScript API и HTTP Геокодер" key) the Yandex geocoder answers; without it, OpenStreetMap's
   Nominatim (one request per second, cached) — enough to start, Yandex is more accurate for Tashkent house numbers. */
const TASHKENT = { la: 41.311, lo: 69.24, spanLa: 0.42, spanLo: 0.6 };
const inBox = (la, lo) => Math.abs(la - TASHKENT.la) < 1.2 && Math.abs(lo - TASHKENT.lo) < 1.6;

export function createGeo({ cfg, log = console }) {
  const Y = cfg.maps || {}, cache = new Map(), TTL = 6 * 3600_000;
  const remember = (k, v) => { if (cache.size > 2000) cache.delete(cache.keys().next().value); cache.set(k, { v, t: Date.now() }); return v; };
  const cached = k => { const c = cache.get(k); if (c && Date.now() - c.t < TTL) return c.v; cache.delete(k); return undefined; };
  // Nominatim asks for at most one request per second from one app: a tiny queue keeps us polite
  let chain = Promise.resolve(), last = 0;
  const polite = fn => (chain = chain.then(async () => { const wait = 1050 - (Date.now() - last); if (wait > 0) await new Promise(r => setTimeout(r, wait)); last = Date.now(); return fn(); }).catch(e => { log.warn("[geo]", e.message); return []; }));
  const get = async (url, headers = {}) => { const r = await fetch(url, { headers: { Accept: "application/json", ...headers }, signal: AbortSignal.timeout(7000) }); if (!r.ok) throw new Error(`geo ${r.status} ${url.split("?")[0]}`); return r.json(); };
  const ymLang = l => (l === "uz" ? "uz_UZ" : l === "en" ? "en_US" : "ru_RU");

  /* ---- Yandex HTTP geocoder ---- */
  const yaItem = g => {
    const [lo, la] = String(g.Point?.pos || "").split(" ").map(Number), md = g.metaDataProperty?.GeocoderMetaData || {}, comps = md.Address?.Components || [];
    const street = comps.find(c => c.kind === "street")?.name || "", house = comps.find(c => c.kind === "house")?.name || "", area = comps.find(c => c.kind === "district")?.name || comps.find(c => c.kind === "locality")?.name || "";
    const line = street ? `${street}${house ? ", " + house : ""}` : g.name || md.text || "";
    return Number.isFinite(la) && Number.isFinite(lo) ? { label: line, sub: area || g.description || "", street: line, la: +la.toFixed(6), lo: +lo.toFixed(6), kind: md.kind || "" } : null;
  };
  const yaGeocode = async (q, lang, extra = "") => {
    const u = `${Y.geocoderUrl}?apikey=${encodeURIComponent(Y.geocoderKey)}&format=json&lang=${ymLang(lang)}&geocode=${encodeURIComponent(q)}&ll=${TASHKENT.lo},${TASHKENT.la}&spn=${TASHKENT.spanLo},${TASHKENT.spanLa}&rspn=1&results=7${extra}`;
    const j = await get(u);
    return (j.response?.GeoObjectCollection?.featureMember || []).map(m => yaItem(m.GeoObject)).filter(Boolean).filter(x => inBox(x.la, x.lo));
  };

  /* ---- OpenStreetMap Nominatim ---- */
  const osmItem = x => {
    const a = x.address || {}, road = a.road || a.pedestrian || a.residential || a.neighbourhood || a.suburb || "", house = a.house_number || "";
    const name = x.namedetails?.name || (x.category === "amenity" || x.category === "shop" || x.category === "building" ? x.name : "") || "";
    const line = road ? `${road}${house ? ", " + house : ""}` : name || String(x.display_name || "").split(",").slice(0, 2).join(",").trim();
    return { label: name && road && name !== road ? `${name} · ${line}` : line, sub: [a.suburb && a.suburb !== road ? a.suburb : "", a.city_district || a.county || ""].filter(Boolean).join(", "), street: line, la: +(+x.lat).toFixed(6), lo: +(+x.lon).toFixed(6), kind: x.addresstype || x.type || "" };
  };
  const osmHeaders = { "User-Agent": `QurilishGo/1.0 (${cfg.siteUrl || "https://imorat.uz"})`, "Accept-Language": "ru,uz;q=0.8,en;q=0.5" };
  const box = `${TASHKENT.lo - TASHKENT.spanLo / 2},${TASHKENT.la + TASHKENT.spanLa / 2},${TASHKENT.lo + TASHKENT.spanLo / 2},${TASHKENT.la - TASHKENT.spanLa / 2}`;
  const osmSearch = q => polite(async () => (await get(`${Y.nominatim}/search?format=jsonv2&addressdetails=1&namedetails=1&limit=7&countrycodes=uz&viewbox=${box}&bounded=1&q=${encodeURIComponent(q)}`, osmHeaders)).map(osmItem));
  const osmReverse = (la, lo) => polite(async () => { const j = await get(`${Y.nominatim}/reverse?format=jsonv2&addressdetails=1&zoom=18&lat=${la}&lon=${lo}`, osmHeaders); return j && !j.error ? [osmItem(j)] : []; });

  /* suggestions for a typed query (≥ 3 letters); [] on any failure so the form keeps working without a geocoder */
  async function suggest(q, lang = "ru") {
    q = String(q || "").trim().slice(0, 120); if (q.length < 3) return [];
    const k = `s:${lang}:${q.toLowerCase()}`, hit = cached(k); if (hit) return hit;
    try {
      const list = Y.geocoderKey ? await yaGeocode(q, lang) : await osmSearch(q);
      const seen = new Set(); return remember(k, list.filter(x => x.label && !seen.has(x.label + x.sub) && seen.add(x.label + x.sub)).slice(0, 6));
    } catch (e) { log.warn("[geo] suggest", e.message); return []; }
  }
  /* the address at a point — street and house when there is one */
  async function reverse(la, lo, lang = "ru") {
    la = Number(la); lo = Number(lo); if (!Number.isFinite(la) || !Number.isFinite(lo)) return null;
    const k = `r:${lang}:${la.toFixed(4)},${lo.toFixed(4)}`, hit = cached(k); if (hit !== undefined) return hit;
    try {
      const list = Y.geocoderKey ? await yaGeocode(`${lo},${la}`, lang, "&kind=house") : await osmReverse(la, lo);
      return remember(k, list[0] || null);
    } catch (e) { log.warn("[geo] reverse", e.message); return null; }
  }
  return { suggest, reverse, provider: Y.geocoderKey ? "yandex" : "osm" };
}
