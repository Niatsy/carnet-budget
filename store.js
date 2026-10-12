// Magasin local + synchronisation Supabase.
// Tout est écrit d'abord sur l'appareil (localStorage) : l'appli marche sans réseau.
// Dès que le réseau revient, les changements partent vers Supabase et ceux des autres appareils arrivent.
(function () {
  const cfg = window.CARNET_CONFIG || {};
  const SYNC_ON = !!(cfg.supabaseUrl && cfg.supabaseAnonKey);
  const URL_ = (cfg.supabaseUrl || "").replace(/\/+$/, "");
  const KEY = cfg.supabaseAnonKey || "";
  const LS = "carnet.v1.";

  const read = (k, d) => { try { const v = localStorage.getItem(LS + k); return v ? JSON.parse(v) : d; } catch { return d; } };
  const write = (k, v) => { try { localStorage.setItem(LS + k, JSON.stringify(v)); } catch {} };

  // items : id -> { kind: "profile" | "tx", data, deleted }
  let items = read("items", {});
  let pending = read("pending", {});
  let lastPull = read("lastPull", null);
  let session = read("session", null);
  const listeners = new Set();
  const statusListeners = new Set();
  let status = SYNC_ON ? (navigator.onLine ? "idle" : "offline") : "local";
  let firstPullDone = !SYNC_ON;

  const save = () => { write("items", items); write("pending", pending); };
  const emit = () => listeners.forEach((f) => { try { f(); } catch (e) { console.error(e); } });
  const setStatus = (s) => { status = s; statusListeners.forEach((f) => f(s)); };

  // ---------- Écritures locales ----------
  function put(id, kind, data, deleted = false) {
    items[id] = { kind, data: JSON.parse(JSON.stringify(data || {})), deleted: !!deleted };
    pending[id] = true;
    save(); emit(); scheduleSync(800);
  }
  const live = (kind) => Object.entries(items).filter(([, v]) => v.kind === kind && !v.deleted);

  const newId = () => "x" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

  function txRef(id) {
    id = id || newId();
    return {
      id,
      async set(data) { put(id, "tx", data); },
      async update(patch) {
        const cur = items[id];
        if (!cur || cur.deleted) { const e = new Error("absent"); e.code = "invalid_argument"; throw e; }
        put(id, "tx", { ...cur.data, ...patch });
      },
      async delete() { const cur = items[id]; put(id, "tx", cur ? cur.data : {}, true); },
    };
  }
  const profileRef = {
    onSnapshot(next) {
      const f = () => { const p = items.profile; next({ exists: !!(p && !p.deleted), data: () => p && p.data }); };
      listeners.add(f); setTimeout(f, 0); return () => listeners.delete(f);
    },
    async set(data) { put("profile", "profile", data); },
    async update(patch) {
      const cur = items.profile;
      if (!cur) { const e = new Error("absent"); e.code = "invalid_argument"; throw e; }
      put("profile", "profile", { ...cur.data, ...patch });
    },
  };
  const txCol = {
    orderBy() { return txCol; }, limit() { return txCol; },
    doc: txRef,
    onSnapshot(next) {
      const f = () => {
        const docs = live("tx").map(([id, v]) => ({ id, data: () => v.data }))
          .sort((a, b) => (b.data().date || "").localeCompare(a.data().date || ""));
        next({ docs, size: docs.length, empty: !docs.length, metadata: { fromCache: !firstPullDone } });
      };
      listeners.add(f); setTimeout(f, 0); return () => listeners.delete(f);
    },
  };

  // ---------- Compte Supabase ----------
  async function auth(path, body) {
    const r = await fetch(`${URL_}/auth/v1/${path}`, { method: "POST", headers: { apikey: KEY, "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) { const e = new Error(j.error_description || j.msg || j.message || "Erreur de connexion"); e.status = r.status; e.code = j.error_code || j.code; throw e; }
    return j;
  }
  function keepSession(j) {
    if (!j.access_token) return false;
    session = { access_token: j.access_token, refresh_token: j.refresh_token, expires_at: Date.now() + (j.expires_in || 3600) * 1000, user: { id: j.user.id, email: j.user.email } };
    write("session", session);
    return true;
  }
  // Les données locales appartiennent à un seul compte : si un autre compte se connecte sur l'appareil, on repart de zéro.
  function claimDevice(uid) {
    const owner = read("owner", null);
    if (owner && owner !== uid) wipeLocal();
    write("owner", uid);
  }
  function wipeLocal() {
    items = {}; pending = {}; lastPull = null;
    try { Object.keys(localStorage).filter((k) => k.startsWith(LS) && k !== LS + "session").forEach((k) => localStorage.removeItem(k)); } catch {}
    emit();
  }
  async function getUser(accessToken) {
    const r = await fetch(`${URL_}/auth/v1/user`, { headers: { apikey: KEY, Authorization: "Bearer " + accessToken } });
    if (!r.ok) throw new Error("Lien expiré ou invalide.");
    return r.json();
  }
  // Retour depuis un e-mail (confirmation d'inscription ou mot de passe oublié) : la session arrive dans l'adresse.
  let linkType = null, linkError = null;
  async function readLinkSession() {
    if (!SYNC_ON || !location.hash || location.hash.length < 2) return;
    const h = new URLSearchParams(location.hash.slice(1));
    const clean = () => history.replaceState(null, "", location.pathname + location.search);
    if (h.get("error")) { linkError = h.get("error_code") || h.get("error"); clean(); return; }
    const at = h.get("access_token");
    if (!at) return;
    try {
      const user = await getUser(at);
      keepSession({ access_token: at, refresh_token: h.get("refresh_token"), expires_in: +h.get("expires_in") || 3600, user });
      claimDevice(user.id);
      linkType = h.get("type");
    } catch (e) { linkError = "invalid"; }
    clean();
  }

  async function token() {
    if (!session) return null;
    if (Date.now() < session.expires_at - 60000) return session.access_token;
    try { keepSession(await auth("token?grant_type=refresh_token", { refresh_token: session.refresh_token })); return session.access_token; }
    catch (e) { if (e.status === 400 || e.status === 401) { session = null; write("session", null); } throw e; }
  }

  // ---------- Synchronisation ----------
  let syncTimer = null, syncing = false;
  function scheduleSync(ms = 0) {
    if (!SYNC_ON || !session) return;
    clearTimeout(syncTimer); syncTimer = setTimeout(sync, ms);
  }
  async function sync() {
    if (!SYNC_ON || !session || syncing) return;
    if (!navigator.onLine) { setStatus("offline"); return; }
    syncing = true; setStatus("syncing");
    try {
      const t = await token();
      if (!t) { setStatus("signedout"); return; }
      const H = { apikey: KEY, Authorization: "Bearer " + t, "Content-Type": "application/json" };
      // 1) Envoyer les changements faits sur cet appareil
      const ids = Object.keys(pending);
      if (ids.length) {
        const rows = ids.filter((id) => items[id]).map((id) => ({ id, kind: items[id].kind, data: items[id].data, deleted: items[id].deleted }));
        const r = await fetch(`${URL_}/rest/v1/items?on_conflict=user_id,id`, { method: "POST", headers: { ...H, Prefer: "resolution=merge-duplicates,return=minimal" }, body: JSON.stringify(rows) });
        if (!r.ok) throw new Error("envoi " + r.status);
        ids.forEach((id) => delete pending[id]);
        save();
      }
      // 2) Recevoir les changements des autres appareils
      let q = `${URL_}/rest/v1/items?select=id,kind,data,deleted,updated_at&order=updated_at.asc&limit=1000`;
      if (lastPull) q += `&updated_at=gt.${encodeURIComponent(lastPull)}`;
      const r2 = await fetch(q, { headers: H });
      if (!r2.ok) throw new Error("réception " + r2.status);
      const rows = await r2.json();
      let changed = false;
      for (const row of rows) {
        if (pending[row.id]) continue; // la modification locale, plus récente, repartira au prochain envoi
        items[row.id] = { kind: row.kind, data: row.data, deleted: row.deleted };
        lastPull = row.updated_at; changed = true;
      }
      if (rows.length) write("lastPull", lastPull);
      save();
      const wasFirst = !firstPullDone; firstPullDone = true;
      if (changed || wasFirst) emit();
      setStatus("synced");
      if (rows.length === 1000) scheduleSync(0);
    } catch (e) {
      console.warn("Synchronisation :", e);
      setStatus(!session ? "signedout" : navigator.onLine ? "error" : "offline");
    } finally {
      syncing = false;
      if (!firstPullDone && !navigator.onLine) { firstPullDone = true; emit(); }
    }
  }
  window.addEventListener("online", () => scheduleSync(0));
  window.addEventListener("offline", () => setStatus("offline"));
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") scheduleSync(0); });
  setInterval(() => { if (document.visibilityState === "visible") scheduleSync(0); }, 60000);
  // Hors connexion au démarrage : on n'attend pas la première réception pour afficher.
  setTimeout(() => { if (!firstPullDone) { firstPullDone = true; emit(); } }, 4000);

  window.CarnetStore = {
    syncEnabled: SYNC_ON,
    get session() { return session; },
    get status() { return status; },
    onStatus(f) { statusListeners.add(f); f(status); return () => statusListeners.delete(f); },
    profileRef, txCol,
    get linkType() { return linkType; },
    get linkError() { return linkError; },
    get hasPending() { return Object.keys(pending).length > 0; },
    async signIn(email, password) {
      const j = await auth("token?grant_type=password", { email, password });
      claimDevice(j.user.id); keepSession(j); firstPullDone = false; setStatus("idle"); await sync();
    },
    async signUp(email, password) {
      const j = await auth("signup", { email, password });
      if (j.access_token) { claimDevice(j.user.id); keepSession(j); firstPullDone = false; await sync(); return "ok"; }
      return "confirm";
    },
    // Envoie l'e-mail « mot de passe oublié » ; le lien ramène sur l'appli.
    async recover(email) {
      const back = location.origin + location.pathname;
      await auth("recover?redirect_to=" + encodeURIComponent(back), { email });
    },
    async updatePassword(password) {
      const t = await token();
      const r = await fetch(`${URL_}/auth/v1/user`, { method: "PUT", headers: { apikey: KEY, Authorization: "Bearer " + t, "Content-Type": "application/json" }, body: JSON.stringify({ password }) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { const e = new Error(j.msg || j.message || j.error_description || "Échec"); e.code = j.error_code || j.code; throw e; }
      linkType = null;
    },
    // Déconnexion : on envoie d'abord ce qui reste, puis on efface tout de l'appareil.
    async signOut() {
      if (Object.keys(pending).length && navigator.onLine) { try { await sync(); } catch {} }
      session = null; write("session", null); wipeLocal(); write("owner", null);
      setStatus("signedout");
    },
    // Droit à l'effacement : supprime le compte et toutes ses données sur le serveur, puis sur l'appareil.
    async deleteAccount() {
      const t = await token();
      const r = await fetch(`${URL_}/rest/v1/rpc/delete_my_account`, { method: "POST", headers: { apikey: KEY, Authorization: "Bearer " + t, "Content-Type": "application/json" }, body: "{}" });
      if (!r.ok) { const j = await r.json().catch(() => ({})); throw new Error(j.message || "Suppression impossible (" + r.status + ")"); }
      session = null; write("session", null); wipeLocal(); write("owner", null);
      setStatus("signedout");
    },
    syncNow: () => scheduleSync(0),
    // Export / import : un fichier JSON lisible, au même format que le carnet claude.ai
    exportData() {
      const p = items.profile && !items.profile.deleted ? items.profile.data : null;
      return { app: "carnet-de-budget", version: 1, exportedAt: new Date().toISOString(), profile: p, tx: live("tx").map(([id, v]) => ({ id, ...v.data })) };
    },
    importData(obj) {
      if (!obj || obj.app !== "carnet-de-budget" || !Array.isArray(obj.tx)) throw new Error("Ce fichier ne vient pas du Carnet de budget.");
      if (obj.profile) put("profile", "profile", obj.profile);
      for (const t of obj.tx) { const { id, ...data } = t; if (id) put(id, "tx", data); }
      return obj.tx.length;
    },
  };
  window.CarnetStore.ready = readLinkSession().then(() => { if (session) scheduleSync(0); });
})();
