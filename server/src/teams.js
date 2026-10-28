import { HttpError, bad, readJson, str, int } from "./http.js";
import { escHtml as h } from "./telegram.js";
import { randomBytes } from "node:crypto";

/* Shared purchase lists for a crew: the foreman creates a project, invites by code,
   everyone adds what is needed, and anyone can move the whole list into their cart. */
export function registerTeams({ r, db, cfg, need, lim, tg, log }) {
  const safe = p => Promise.resolve(p).catch(e => log.warn("[teams]", e.message));
  const member = (pid, uid) => db.get("SELECT * FROM team_members WHERE project_id=? AND user_id=?", pid, uid);
  const out = p => ({ id: p.id, code: p.code, name: p.name, items: JSON.parse(p.items || "{}"), owner: p.owner_id, updated: p.updated_at, created: p.created_at,
    members: db.all("SELECT u.id, u.name FROM team_members m JOIN users u ON u.id=m.user_id WHERE m.project_id=? ORDER BY m.joined_at", p.id).map(x => ({ id: x.id, name: (x.name || "").split(" ")[0] || "—" })) });
  const cleanItems = obj => {
    const res = {};
    for (const [k, v] of Object.entries(obj || {}).slice(0, 300)) {
      const [id, store] = String(k).split("|"), q = int(typeof v === "object" ? v?.q : v, 0, 100000);
      if (!int(id, 1, 1e9) || !store || q === null) continue;
      if (!db.get("SELECT 1 FROM offers WHERE product_id=? AND store_id=?", Number(id), store.slice(0, 40))) continue;
      res[`${Number(id)}|${store.slice(0, 40)}`] = q;
    }
    return res;
  };
  const newCode = () => { const A = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; for (;;) { const c = [...randomBytes(6)].map(b => A[b % A.length]).join(""); if (!db.get("SELECT 1 FROM team_projects WHERE code=?", c)) return c; } };
  r.get("/api/team-projects", req => {
    const u = need(req);
    return { projects: db.all("SELECT p.* FROM team_projects p JOIN team_members m ON m.project_id=p.id WHERE m.user_id=? ORDER BY p.updated_at DESC", u.id).map(out) };
  });
  r.post("/api/team-projects", async req => {
    const u = need(req), b = await readJson(req);
    lim.hit("tp:" + u.id, 20, 86400_000);
    const name = str(b.name, 80) || "Проект", items = cleanItems(b.items), now = Date.now(), id = "tp" + now.toString(36) + randomBytes(2).toString("hex");
    const stamped = Object.fromEntries(Object.entries(items).map(([k, q]) => [k, { q, by: u.id, t: now }]));
    db.tx(() => {
      db.run("INSERT INTO team_projects(id,code,owner_id,name,items,created_at,updated_at) VALUES(?,?,?,?,?,?,?)", id, newCode(), u.id, name, JSON.stringify(stamped), now, now);
      db.run("INSERT INTO team_members(project_id,user_id,role,joined_at) VALUES(?,?,'owner',?)", id, u.id, now);
    });
    return { project: out(db.get("SELECT * FROM team_projects WHERE id=?", id)) };
  });
  r.post("/api/team-projects/join", async req => {
    const u = need(req), b = await readJson(req);
    lim.hit("tpj:" + u.id, 20, 3600_000);
    const p = db.get("SELECT * FROM team_projects WHERE code=?", String(b.code || "").trim().toUpperCase());
    if (!p) throw bad("bad_code", "No project with this code");
    if (!member(p.id, u.id)) {
      if (db.get("SELECT COUNT(*) n FROM team_members WHERE project_id=?", p.id).n >= 20) throw new HttpError(409, "team_full", "Up to 20 people in a project");
      db.run("INSERT INTO team_members(project_id,user_id,role,joined_at) VALUES(?,?,'member',?)", p.id, u.id, Date.now());
    }
    return { project: out(p) };
  });
  r.patch("/api/team-projects/:id", async (req, res, pp) => {
    const u = need(req), b = await readJson(req, 512 * 1024);
    const p = db.get("SELECT * FROM team_projects WHERE id=?", pp.id);
    if (!p || !member(p.id, u.id)) throw new HttpError(404, "not_found", "Project not found");
    const items = JSON.parse(p.items || "{}"), now = Date.now();
    let added = 0;
    for (const [k, q] of Object.entries(cleanItems(b.add))) { const cur = items[k]?.q || 0; items[k] = { q: cur + q, by: u.id, t: now }; added++; }
    for (const [k, q] of Object.entries(cleanItems(b.set))) { if (q > 0) items[k] = { q, by: u.id, t: now }; else delete items[k]; }
    for (const k of (Array.isArray(b.remove) ? b.remove : []).slice(0, 300)) delete items[String(k)];
    const name = b.name != null ? str(b.name, 80) || p.name : p.name;
    db.run("UPDATE team_projects SET items=?, name=?, updated_at=? WHERE id=?", JSON.stringify(items), name, now, p.id);
    if (added) for (const m of db.all("SELECT u.* FROM team_members m JOIN users u ON u.id=m.user_id WHERE m.project_id=? AND u.id<>?", p.id, u.id))
      if (m.tg_chat) safe(tg.send(m.tg_chat, `🧱 ${h((u.name || "Участник").split(" ")[0])} добавил ${added} поз. в проект «${h(name)}» на Imorat Go.`));
    return { project: out(db.get("SELECT * FROM team_projects WHERE id=?", p.id)) };
  });
  r.del("/api/team-projects/:id", (req, res, pp) => {
    const u = need(req), p = db.get("SELECT * FROM team_projects WHERE id=?", pp.id);
    if (!p || !member(p.id, u.id)) throw new HttpError(404, "not_found", "Project not found");
    if (p.owner_id === u.id) db.tx(() => { db.run("DELETE FROM team_members WHERE project_id=?", p.id); db.run("DELETE FROM team_projects WHERE id=?", p.id); });
    else db.run("DELETE FROM team_members WHERE project_id=? AND user_id=?", p.id, u.id);
    return { ok: true, deleted: p.owner_id === u.id };
  });
}
