/* Yandex Delivery claims: the courier for a shipment is ordered when the store has packed it ("searching"),
   its status is polled every sweep, the buyer gets the live position and a tracking link.
   Claims API v2: https://yandex.ru/support2/delivery-profile/ru/api/  (b2b/cargo/integration/v2/claims/*)
   Without YANDEX_DELIVERY_TOKEN the statuses come from the store and the buyer's map has no courier position
   ("location unavailable"); only a test server with COURIER_SIMULATION=1 moves a pretend courier along the route. */
const H = (cfg, lang = "ru") => ({ Authorization: "Bearer " + cfg.token, "Content-Type": "application/json", "Accept-Language": lang });
const STATUS_MAP = {
  performer_lookup: "searching", performer_draft: "searching", performer_found: "to_store", pickup_arrived: "to_store",
  ready_for_pickup_confirmation: "on_way", pickuped: "on_way", pay_waiting: "on_way", delivery_arrived: "on_way", ready_for_delivery_confirmation: "on_way",
  delivered: "delivered", delivered_finish: "delivered",
  performer_not_found: "failed", failed: "failed", cancelled: "failed", cancelled_with_payment: "failed", cancelled_by_taxi: "failed", cancelled_with_items_on_hands: "failed", returning: "failed", returned: "failed", returned_finish: "failed"
};
const dist = (a, b) => { const R = 6371, dLa = (b.la - a.la) * Math.PI / 180, dLo = (b.lo - a.lo) * Math.PI / 180, x = Math.sin(dLa / 2) ** 2 + Math.cos(a.la * Math.PI / 180) * Math.cos(b.la * Math.PI / 180) * Math.sin(dLo / 2) ** 2; return 2 * R * Math.asin(Math.sqrt(x)); };

export function createCourier({ db, cfg, ref, log = console }) {
  const Y = cfg.yandex, D = Object.fromEntries(ref.districts.map(d => [d.id, d]));
  const live = !!Y.token;
  const api = async (path, body, method = "POST", lang = "ru") => {
    const r = await fetch(Y.url + "/b2b/cargo/integration/v2/" + path, { method, headers: H(Y, lang), body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(8000) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) { const e = new Error(`yandex ${path} ${r.status} ${j.code || ""} ${j.message || ""}`.trim()); e.status = r.status; e.body = j; throw e; }
    return j;
  };
  const storePt = s => ({ la: s.la ?? D[s.district].la, lo: s.lo ?? D[s.district].lo });
  const destPt = f => (f.la != null && f.lo != null ? { la: Number(f.la), lo: Number(f.lo) } : { la: D[f.district]?.la ?? D.mirob.la, lo: D[f.district]?.lo ?? D.mirob.lo });
  const tariffOf = sh => ref.tariffs.find(t => t.id === sh.tariff) || ref.tariffs[0];

  /* order a courier for a packed shipment; stores claim id and tracking link on the shipment */
  async function order(sh) {
    const o = db.get("SELECT * FROM orders WHERE id=?", sh.order_id), s = db.get("SELECT * FROM stores WHERE id=?", sh.store_id);
    if (!o || !s || !sh.tariff) return null;
    const f = JSON.parse(o.form), lines = JSON.parse(sh.lines), t = tariffOf(sh);
    if (!live) { db.run("UPDATE shipments SET claim_id=?, courier_at=? WHERE id=?", "sim-" + sh.id, Date.now(), sh.id); return { claim_id: "sim-" + sh.id, simulated: true }; }
    const loaders = f.help === "one" || (f.help == null && f.lift) ? 1 : 0; // unloading help chosen at checkout
    const requirements = t.id === "courier" ? { taxi_class: "express" } : { taxi_class: "cargo", cargo_type: t.id === "cargo_s" ? "lcv_m" : "lcv_l", ...(loaders ? { cargo_loaders: loaders } : {}) };
    const sp = storePt(s), dp = destPt(f);
    const names = db.all(`SELECT id, ru FROM products WHERE id IN (${lines.map(() => "?").join(",") || "0"})`, ...lines.map(l => l.id));
    const body = {
      comment: `Imorat Go, заказ ${o.num}${f.comment ? ". " + f.comment : ""}`,
      emergency_contact: { name: "Imorat Go", phone: cfg.supportPhone || f.phone },
      items: lines.map((l, i) => ({ pickup_point: 1, droppof_point: 2, title: names.find(n => n.id === l.id)?.ru || "Товар", quantity: l.q, cost_value: String(l.price), cost_currency: "UZS", weight: Math.max(0.1, Math.round((l.kg || 1) * 100) / 100), size: { length: 0.5, width: 0.4, height: 0.3 }, extra_id: String(l.id) })),
      route_points: [
        { point_id: 1, visit_order: 1, type: "source", address: { fullname: `Ташкент, ${s.addr || D[s.district]?.ru || ""}`, coordinates: [sp.lo, sp.la], comment: s.landmark || "" }, contact: { name: s.name, phone: "+" + s.phone }, skip_confirmation: true },
        { point_id: 2, visit_order: 2, type: "destination", address: { fullname: ["Ташкент", f.street].filter(Boolean).join(", "), coordinates: [dp.lo, dp.la], porch: f.entrance || undefined, sfloor: f.private ? undefined : String(f.floor || ""), sflat: f.private ? undefined : (f.flat || undefined), door_code: f.intercom || undefined, comment: f.comment || "" }, contact: { name: f.name, phone: "+" + f.phone.replace(/\D/g, "") }, external_order_id: o.num }
      ],
      // no help → the buyer meets the courier at the car / entrance
      client_requirements: requirements, skip_door_to_door: !loaders, skip_client_notify: false, optional_return: false
    };
    const c = await api(`claims/create?request_id=${encodeURIComponent(`imorat-${sh.id}-${Date.now()}`)}`, body);
    db.run("UPDATE shipments SET claim_id=?, courier_at=? WHERE id=?", c.id, Date.now(), sh.id);
    // the price was accepted at checkout; accept the claim so the search starts
    try { await api(`claims/accept?claim_id=${encodeURIComponent(c.id)}`, { version: c.version || 1 }); } catch (e) { log.warn("[yandex] accept", e.message); }
    try { const tl = await api(`claims/tracking-links?claim_id=${encodeURIComponent(c.id)}`, null, "GET"); const url = tl.route_points?.find(p => p.type === "destination")?.sharing_url || tl.route_points?.[0]?.sharing_url; if (url) db.run("UPDATE shipments SET tracking_url=? WHERE id=?", url, sh.id); } catch (e) { log.warn("[yandex] tracking link", e.message); }
    return { claim_id: c.id };
  }

  /* current claim status mapped to a shipment status (live) — null when nothing changed or unknown */
  async function poll(sh) {
    if (!live || !sh.claim_id || sh.claim_id.startsWith("sim-")) return null;
    const j = await api(`claims/info?claim_id=${encodeURIComponent(sh.claim_id)}`);
    const st = STATUS_MAP[j.status] || null, perf = j.performer_info;
    const courier = perf ? [perf.courier_name, perf.car_model, perf.car_number].filter(Boolean).join(" · ") : null;
    if (courier && courier !== sh.courier) db.run("UPDATE shipments SET courier=? WHERE id=?", courier.slice(0, 120), sh.id);
    return { status: st, raw: j.status, courier, eta: j.eta || null };
  }

  /* where the courier is right now: live from Yandex; without a claim the position is simply unavailable (no coordinates
     are invented) unless this is a test server with COURIER_SIMULATION=1 */
  async function position(sh) {
    const o = db.get("SELECT * FROM orders WHERE id=?", sh.order_id), s = db.get("SELECT * FROM stores WHERE id=?", sh.store_id);
    if (!o || !s) return null;
    const f = JSON.parse(o.form), from = storePt(s), to = destPt(f), km = dist(from, to);
    const base = { from, to, km: Math.round(km * 10) / 10, tracking_url: sh.tracking_url || null, courier: sh.courier || null, status: sh.status };
    if (!["searching", "to_store", "on_way"].includes(sh.status)) return { ...base, pos: null };
    if (live && sh.claim_id && !sh.claim_id.startsWith("sim-")) {
      try { const p = await api(`claims/performer-position?claim_id=${encodeURIComponent(sh.claim_id)}`, null, "GET"); if (p.position) return { ...base, pos: { la: p.position.lat, lo: p.position.lon }, speed: p.position.speed, direction: p.position.direction, updated: (p.position.timestamp || 0) * 1000 || Date.now(), eta_min: p.position.dist_to_point ? Math.max(1, Math.round(p.position.dist_to_point / 400)) : null, live: true }; }
      catch (e) { if (e.status !== 404) log.warn("[yandex] position", e.message); }
      return { ...base, pos: null, live: true, unavailable: true };
    }
    if (!cfg.courierSim) return { ...base, pos: null, unavailable: true }; // the store moves the statuses; nobody knows where the courier is
    // simulation (test servers): a courier 3 km away drives to the store in ~8 minutes, then to the address at ~25 km/h
    const t0 = sh.courier_at || sh.status_at, el = (Date.now() - t0) / 60000;
    const start = { la: from.la + 0.012, lo: from.lo - 0.016 };
    const lerp = (a, b, k) => ({ la: a.la + (b.la - a.la) * k, lo: a.lo + (b.lo - a.lo) * k });
    if (sh.status === "searching") return { ...base, pos: null, eta_min: 5, simulated: true };
    if (sh.status === "to_store") { const k = Math.min(1, el / 8); return { ...base, pos: lerp(start, from, k), eta_min: Math.max(1, Math.round(8 - el)), updated: Date.now(), simulated: true }; }
    const total = Math.max(6, km / 25 * 60), k = Math.min(1, el / total);
    return { ...base, pos: lerp(from, to, k), eta_min: Math.max(1, Math.round(total - el)), updated: Date.now(), simulated: true };
  }

  /* the shipment was cancelled after the courier was called: cancel the Yandex claim too, otherwise the trip is still charged.
     cancel-info says whether it is still free or already paid (the car is on its way); both are cancelled, the admin is told which. */
  async function cancel(sh) {
    if (!live || !sh.claim_id || sh.claim_id.startsWith("sim-")) return null;
    const info = await api(`claims/info?claim_id=${encodeURIComponent(sh.claim_id)}`);
    if (/^(delivered|delivered_finish|cancelled|cancelled_with_payment|cancelled_by_taxi|returned|returned_finish|failed)$/.test(info.status)) return { already: info.status };
    const ci = await api(`claims/cancel-info?claim_id=${encodeURIComponent(sh.claim_id)}`).catch(() => ({ cancel_state: "free" }));
    const r = await api(`claims/cancel?claim_id=${encodeURIComponent(sh.claim_id)}`, { version: info.version || 1, cancel_state: ci.cancel_state || "free" });
    return { status: r.status, cancel_state: ci.cancel_state || "free" };
  }
  return { live, order, poll, position, cancel, STATUS_MAP };
}
