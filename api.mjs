import { getStore } from "@netlify/blobs";

const J = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json", "cache-control": "no-store" } });
const CONDS = ["Unconscious", "Dizziness / weakness", "Chest pain / breathing", "Injury / fracture", "Crowd crush", "Other"];
const STATUS = ["new", "dispatched", "done", "cancelled"];
const clip = (s, n) => String(s ?? "").trim().slice(0, n);
const num = (v, a, b) => { if (v === null || v === undefined || v === "") return null; v = Number(v); return Number.isFinite(v) && v >= a && v <= b ? v : null; };
const ABC = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const newId = () => "SA" + Array.from(crypto.getRandomValues(new Uint8Array(7)), (b) => ABC[b % 32]).join("");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export default async (req) => {
  const store = getStore({ name: "requests", consistency: "strong" });
  const parts = new URL(req.url).pathname.replace(/^\/api\/?/, "").split("/").filter(Boolean);
  try {
    /* ---------- public ---------- */
    if (parts[0] === "request") {
      if (req.method === "POST" && parts.length === 1) {
        let b; try { b = await req.json(); } catch { return J({ error: "bad json" }, 400); }
        const phone = String(b.phone || "").replace(/\D/g, "").slice(-10);
        if (!/^[6-9]\d{9}$/.test(phone)) return J({ error: "phone" }, 400);
        const lat = num(b.lat, -90, 90), lng = num(b.lng, -180, 180);
        const loc = clip(b.loc, 200);
        if (!loc && (lat === null || lng === null)) return J({ error: "location" }, 400);
        // double-tap protection: same phone, still "new", within 2 minutes
        const prev = await store.get("p:" + phone, { type: "json" });
        if (prev && Date.now() - prev.ts < 120000) {
          const cur = await store.get("r:" + prev.rid, { type: "json" });
          if (cur && cur.status === "new") return J({ rid: cur.rid, dup: true });
        }
        const rid = newId();
        const rec = {
          rid, name: clip(b.name, 60) || "Unknown", phone, loc: loc || "GPS location",
          cond: CONDS.includes(b.cond) ? b.cond : "Other", lat, lng, acc: num(b.acc, 0, 1e7),
          src: b.src === "qr" ? "qr" : "gps", lang: ["en", "hi", "mr"].includes(b.lang) ? b.lang : "en",
          status: "new", eta: null, ts: Date.now(),
        };
        await store.setJSON("r:" + rid, rec);
        await store.setJSON("p:" + phone, { rid, ts: rec.ts });
        return J({ rid });
      }
      const rid = parts[1];
      if (rid && /^SA[A-Z0-9]{7}$/.test(rid)) {
        const rec = await store.get("r:" + rid, { type: "json" });
        if (!rec) return J({ error: "not found" }, 404);
        if (req.method === "GET" && parts.length === 2) return J(rec);
        if (req.method === "POST" && parts[2] === "cancel") {
          if (rec.status === "new" || rec.status === "dispatched") { rec.status = "cancelled"; await store.setJSON("r:" + rid, rec); }
          return J(rec);
        }
      }
      return J({ error: "bad request" }, 400);
    }

    /* ---------- admin (server-side PIN) ---------- */
    if (parts[0] === "admin") {
      const pin = process.env.ADMIN_PIN;
      if (!pin) return J({ error: "ADMIN_PIN not set on server" }, 500);
      if (req.headers.get("x-admin-pin") !== pin) { await sleep(800); return J({ error: "unauthorized" }, 401); }
      if (req.method === "GET" && parts[1] === "list") {
        const { blobs } = await store.list({ prefix: "r:" });
        const recs = (await Promise.all(blobs.map((x) => store.get(x.key, { type: "json" }))))
          .filter(Boolean).filter((r) => Date.now() - r.ts < 48 * 3600e3)
          .sort((a, b) => b.ts - a.ts).slice(0, 200);
        return J(recs);
      }
      if (req.method === "POST" && parts[1] === "update") {
        let b; try { b = await req.json(); } catch { return J({ error: "bad json" }, 400); }
        if (!/^SA[A-Z0-9]{7}$/.test(String(b.rid)) || !STATUS.includes(b.status)) return J({ error: "bad input" }, 400);
        const rec = await store.get("r:" + b.rid, { type: "json" });
        if (!rec) return J({ error: "not found" }, 404);
        rec.status = b.status;
        if (b.status === "dispatched") rec.eta = num(b.eta, 0, 600);
        rec.updated = Date.now();
        await store.setJSON("r:" + b.rid, rec);
        return J(rec);
      }
    }
    return J({ error: "not found" }, 404);
  } catch (e) {
    console.error(e);
    return J({ error: "server error" }, 500);
  }
};

export const config = { path: "/api/*" };
