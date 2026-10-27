/* Yandex Delivery: price check per store (POST /b2b/cargo/integration/v2/check-price).
   Works only when YANDEX_DELIVERY_TOKEN is set; otherwise the tariff formula is used. */
export async function yandexPrices(db, ref, cfg, lines, form, log = console) {
  if (!cfg.token || form.mode === "pickup") return null;
  const D = Object.fromEntries(ref.districts.map(d => [d.id, d]));
  const dest = form.la != null && form.lo != null ? { la: Number(form.la), lo: Number(form.lo) } : D[form.district] || D.mirob;
  const destName = ["Ташкент", form.street || D[form.district]?.ru || ""].filter(Boolean).join(", ");
  const byStore = new Map();
  for (const l of lines) { const g = byStore.get(l.store) || { kg: 0 }; g.kg += l.p.kg * l.q; byStore.set(l.store, g); }
  const out = {};
  await Promise.all([...byStore].map(async ([sid, g]) => {
    const s = db.get("SELECT * FROM stores WHERE id=?", sid);
    const t = ref.tariffs.find(x => g.kg <= x.maxKg) || ref.tariffs[ref.tariffs.length - 1];
    const requirements = t.id === "courier" ? { taxi_class: "express" }
      : { taxi_class: "cargo", cargo_type: t.id === "cargo_s" ? "lcv_m" : "lcv_l", ...(form.lift ? { cargo_loaders: 1 } : {}) };
    const body = {
      route_points: [
        { id: 1, coordinates: [s.lo ?? D[s.district].lo, s.la ?? D[s.district].la], fullname: `Ташкент, ${s.addr || D[s.district].ru}` },
        { id: 2, coordinates: [dest.lo, dest.la], fullname: destName }
      ],
      items: [{ weight: Math.max(0.1, Math.round(g.kg * 100) / 100), quantity: 1, pickup_point: 1, dropoff_point: 2 }],
      requirements
    };
    try {
      const r = await fetch(cfg.url + "/b2b/cargo/integration/v2/check-price", {
        method: "POST", headers: { Authorization: "Bearer " + cfg.token, "Content-Type": "application/json", "Accept-Language": "ru" },
        body: JSON.stringify(body), signal: AbortSignal.timeout(6000)
      });
      const j = await r.json().catch(() => ({}));
      if (r.ok && j.price != null) out[sid] = Math.round(Number(j.price));
      else log.warn("[yandex] check-price", r.status, j.code || "", j.message || "");
    } catch (e) { log.warn("[yandex] check-price failed:", e.message); }
  }));
  return out;
}
