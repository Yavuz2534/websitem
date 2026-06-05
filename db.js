/* ============================================================
   db.js — Supabase veri katmanı (servis yönetim sürümü)

   Model (Supabase / PostgreSQL):
     auth.users → Supabase Auth (e-posta + şifre)
     profiles   → kişisel profiller (auth.users ile 1:1)
     companies  → şirketler
     members    → kullanıcı ↔ şirket bağı + rol (owner | usta)
     services   → servis kayıtları (çağrıdan kapanışa tüm akış)

   Not: Tüm API Promise döner ve app.js'in beklediği camelCase
   biçiminde nesne alır/verir. snake_case ↔ camelCase ve
   timestamptz ↔ ms dönüşümleri burada yapılır.
   ============================================================ */
(function (global) {
  "use strict";

  // ---- Supabase bağlantısı ----
  const SUPABASE_URL = "https://dqktytpcvmfxjiwerewn.supabase.co";
  const SUPABASE_KEY = "sb_publishable_q7I9LUFKKLJ_rekeCfcSIQ_q7iaepcF";

  if (!global.supabase || !global.supabase.createClient) {
    throw new Error("supabase-js yüklenemedi. index.html'deki CDN script'ini kontrol edin.");
  }
  const sb = global.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);

  /* ---------- Dönüştürücüler (snake_case ↔ camelCase) ---------- */
  const toMs = (v) => (v == null ? null : new Date(v).getTime());
  const toISO = (v) => (v == null ? null : new Date(v).toISOString());

  function rowToUser(r) {
    if (!r) return null;
    return { id: r.id, email: r.email, username: r.username, displayName: r.display_name, phone: r.phone };
  }
  function rowToCompany(r) {
    if (!r) return null;
    return { id: r.id, name: r.name, ownerId: r.owner_id, createdAt: toMs(r.created_at) };
  }
  function rowToMember(r) {
    if (!r) return null;
    return {
      id: r.id, companyId: r.company_id, userId: r.user_id, role: r.role,
      username: r.username, displayName: r.display_name, phone: r.phone,
    };
  }
  function rowToService(r) {
    if (!r) return null;
    return {
      id: r.id, companyId: r.company_id,
      customerName: r.customer_name, customerPhone: r.customer_phone,
      address: r.address, problem: r.problem, status: r.status,
      assignedUserId: r.assigned_user_id, assignedName: r.assigned_name, assignedPhone: r.assigned_phone,
      createdBy: r.created_by,
      createdAt: toMs(r.created_at), assignedAt: toMs(r.assigned_at),
      enrouteAt: toMs(r.enroute_at), closedAt: toMs(r.closed_at),
      completion: r.completion, payment: r.payment,
    };
  }
  function serviceToRow(s) {
    // id'yi bilerek dışarıda bırakıyoruz: ekleme/güncellemede sunucudaki uuid korunur.
    return {
      company_id: s.companyId,
      customer_name: s.customerName, customer_phone: s.customerPhone,
      address: s.address || "", problem: s.problem, status: s.status,
      assigned_user_id: s.assignedUserId, assigned_name: s.assignedName, assigned_phone: s.assignedPhone,
      created_by: s.createdBy,
      created_at: toISO(s.createdAt), assigned_at: toISO(s.assignedAt),
      enroute_at: toISO(s.enrouteAt), closed_at: toISO(s.closedAt),
      completion: s.completion || null, payment: s.payment || null,
    };
  }

  function must(res) {
    if (res.error) throw res.error;
    return res.data;
  }

  /* ======================================================
     KİMLİK DOĞRULAMA (Supabase Auth)
     ====================================================== */
  const Auth = {
    /** Kişisel hesap aç (e-posta + şifre). Profil trigger ile oluşur. */
    async signUp({ email, password, displayName, phone, username }) {
      const res = await sb.auth.signUp({
        email, password,
        options: { data: { display_name: displayName || "", phone: phone || "", username: username || "" } },
      });
      if (res.error) throw res.error;
      return res.data.user;
    },

    async signIn({ email, password }) {
      const res = await sb.auth.signInWithPassword({ email, password });
      if (res.error) throw res.error;
      return res.data.user;
    },

    async signOut() {
      await sb.auth.signOut();
    },

    /** Oturumdaki kullanıcının profilini döner (yoksa null). */
    async currentUser() {
      const { data } = await sb.auth.getSession();
      const u = data.session && data.session.user;
      if (!u) return null;
      let profile = await DB.getUser(u.id);
      if (!profile) {
        // Trigger gecikmesi ihtimaline karşı profili oluştur/garantiye al
        await sb.from("profiles").upsert({
          id: u.id, email: u.email,
          username: (u.user_metadata && u.user_metadata.username) || (u.email || "").split("@")[0],
          display_name: (u.user_metadata && u.user_metadata.display_name) || "",
          phone: (u.user_metadata && u.user_metadata.phone) || "",
        }, { onConflict: "id" });
        profile = await DB.getUser(u.id);
      }
      return profile;
    },

    /**
     * Patronun, ustanın hesabını kendi oturumunu bozmadan açması için
     * ikincil (geçici) bir client ile signUp yapar.
     * E-posta doğrulaması kapalı olduğundan hesap anında kullanılabilir.
     */
    async createWorkerAccount({ email, password, displayName, phone, username }) {
      const tmp = global.supabase.createClient(SUPABASE_URL, SUPABASE_KEY, {
        auth: { persistSession: false, autoRefreshToken: false, storageKey: "sb-tmp-" + Date.now() },
      });
      const res = await tmp.auth.signUp({
        email, password,
        options: { data: { display_name: displayName || "", phone: phone || "", username: username || "" } },
      });
      if (res.error) throw res.error;
      try { await tmp.auth.signOut(); } catch (e) { /* yok say */ }
      return res.data.user;
    },
  };

  /* ======================================================
     VERİ KATMANI
     ====================================================== */
  const DB = {
    sb, // ham erişim gerekirse

    /* ---- Kullanıcılar / profiller ---- */
    async getUser(id) {
      const data = must(await sb.from("profiles").select("*").eq("id", id).maybeSingle());
      return rowToUser(data);
    },
    async getUserByEmail(email) {
      const data = must(await sb.from("profiles").select("*").eq("email", email).maybeSingle());
      return rowToUser(data);
    },

    /* ---- Şirketler ---- */
    async addCompany(c) {
      const row = { name: c.name, owner_id: c.ownerId };
      const data = must(await sb.from("companies").insert(row).select().single());
      return rowToCompany(data);
    },
    async getCompany(id) {
      const data = must(await sb.from("companies").select("*").eq("id", id).maybeSingle());
      return rowToCompany(data);
    },

    /* ---- Üyelikler ---- */
    async addMember(m) {
      const row = {
        company_id: m.companyId, user_id: m.userId, role: m.role,
        username: m.username, display_name: m.displayName, phone: m.phone,
      };
      const data = must(await sb.from("members").insert(row).select().single());
      return rowToMember(data);
    },
    async deleteMember(id) {
      must(await sb.from("members").delete().eq("id", id));
    },
    async getMembersByCompany(companyId) {
      const data = must(await sb.from("members").select("*").eq("company_id", companyId));
      return (data || []).map(rowToMember);
    },
    async getMembershipsByUser(userId) {
      const data = must(await sb.from("members").select("*").eq("user_id", userId));
      return (data || []).map(rowToMember);
    },
    async getMembership(companyId, userId) {
      const data = must(await sb.from("members").select("*")
        .eq("company_id", companyId).eq("user_id", userId).maybeSingle());
      return rowToMember(data);
    },

    /* ---- Servisler ---- */
    async addService(s) {
      const data = must(await sb.from("services").insert(serviceToRow(s)).select().single());
      return rowToService(data);
    },
    async updateService(s) {
      const data = must(await sb.from("services").update(serviceToRow(s)).eq("id", s.id).select().single());
      return rowToService(data);
    },
    async deleteService(id) {
      must(await sb.from("services").delete().eq("id", id));
    },
    async getService(id) {
      const data = must(await sb.from("services").select("*").eq("id", id).maybeSingle());
      return rowToService(data);
    },
    async getServicesByCompany(companyId) {
      const data = must(await sb.from("services").select("*").eq("company_id", companyId));
      return (data || []).map(rowToService);
    },
    async getServicesAssignedTo(userId) {
      const data = must(await sb.from("services").select("*").eq("assigned_user_id", userId));
      return (data || []).map(rowToService);
    },
  };

  global.DB = DB;
  global.Auth = Auth;
})(window);
