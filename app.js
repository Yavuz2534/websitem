/* ============================================================
   app.js — Servis Takip Sistemi ana mantığı

   Akış: Çağrı → Servis Kaydı → Usta Atama → WhatsApp Bildirimi
        → Yola Çıkış → Müşteriye "Geliyoruz" → İş Tamamlama
        → Servis Formu (foto+açıklama+ücret) → PDF + WhatsApp
        → Tahsilat & Kapanış
   ============================================================ */
(function () {
  "use strict";

  const WS_KEY = "servisTakip_workspace";       // son seçilen companyId (cihaz bazlı tercih)

  let currentUser = null;      // {id, username, displayName, phone}
  let currentCompany = null;   // {id, name, ownerId}
  let currentRole = null;      // 'owner' | 'usta'
  let currentFilter = "active";

  const STATUS = {
    open:      { label: "Yeni Kayıt",  cls: "st-open" },
    assigned:  { label: "Usta Atandı", cls: "st-assigned" },
    enroute:   { label: "Yolda",       cls: "st-enroute" },
    completed: { label: "Tamamlandı",  cls: "st-completed" },
    closed:    { label: "Kapandı",     cls: "st-closed" },
  };

  /* ---------------- Yardımcılar ---------------- */
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => Array.from(document.querySelectorAll(sel));

  function todayStr() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  }
  function dateStrOf(ts) {
    const d = new Date(ts);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  }
  function formatDateTR(dateStr) {
    const [y, m, d] = dateStr.split("-");
    const aylar = ["Ocak","Şubat","Mart","Nisan","Mayıs","Haziran","Temmuz","Ağustos","Eylül","Ekim","Kasım","Aralık"];
    const dt = new Date(Number(y), Number(m) - 1, Number(d));
    const gunler = ["Pazar","Pazartesi","Salı","Çarşamba","Perşembe","Cuma","Cumartesi"];
    return `${Number(d)} ${aylar[Number(m) - 1]} ${y}, ${gunler[dt.getDay()]}`;
  }
  function formatTime(ts) {
    return new Date(ts).toLocaleTimeString("tr-TR", { hour: "2-digit", minute: "2-digit" });
  }
  function formatMoney(n) {
    return new Intl.NumberFormat("tr-TR", { maximumFractionDigits: 2 }).format(n || 0) + " ₺";
  }

  function escapeHtml(str) {
    return String(str == null ? "" : str)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  function toast(msg) {
    const t = $("#toast");
    t.textContent = msg;
    t.classList.remove("hidden");
    clearTimeout(t._timer);
    t._timer = setTimeout(() => t.classList.add("hidden"), 2800);
  }

  /** Telefonu WhatsApp uluslararası biçimine çevirir (TR varsayılan). */
  function normalizePhone(raw) {
    let d = String(raw || "").replace(/\D/g, "");
    if (!d) return "";
    if (d.startsWith("90") && d.length === 12) return d;
    if (d.startsWith("0") && d.length === 11) return "90" + d.slice(1);
    if (d.length === 10) return "90" + d;       // 5xx xxx xx xx
    return d;
  }
  function waLink(phone, text) {
    const p = normalizePhone(phone);
    return `https://wa.me/${p}?text=${encodeURIComponent(text)}`;
  }
  function openWa(phone, text) {
    window.open(waLink(phone, text), "_blank");
  }

  /** Fotoğrafı küçültüp JPEG base64'e çevirir. */
  function compressImage(file, maxSize = 1280, quality = 0.7) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const img = new Image();
        img.onload = () => {
          let { width, height } = img;
          if (width > height && width > maxSize) {
            height = Math.round((height * maxSize) / width); width = maxSize;
          } else if (height > maxSize) {
            width = Math.round((width * maxSize) / height); height = maxSize;
          }
          const canvas = document.createElement("canvas");
          canvas.width = width; canvas.height = height;
          canvas.getContext("2d").drawImage(img, 0, 0, width, height);
          resolve(canvas.toDataURL("image/jpeg", quality));
        };
        img.onerror = reject;
        img.src = reader.result;
      };
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  }

  function confirmDialog(title, text, confirmLabel = "Evet") {
    return new Promise((resolve) => {
      $("#confirm-title").textContent = title;
      $("#confirm-text").textContent = text;
      $("#confirm-yes").textContent = confirmLabel;
      const modal = $("#confirm-modal");
      modal.classList.remove("hidden");
      const cleanup = (val) => {
        modal.classList.add("hidden");
        $("#confirm-yes").onclick = null; $("#confirm-no").onclick = null;
        resolve(val);
      };
      $("#confirm-yes").onclick = () => cleanup(true);
      $("#confirm-no").onclick = () => cleanup(false);
    });
  }

  function showModal(id) { $("#" + id).classList.remove("hidden"); }
  function hideModal(id) { $("#" + id).classList.add("hidden"); }

  /* ======================================================
     KİMLİK DOĞRULAMA
     ====================================================== */
  function initAuth() {
    $$(".tab").forEach((tab) => {
      tab.addEventListener("click", () => {
        $$(".tab").forEach((t) => t.classList.remove("active"));
        tab.classList.add("active");
        const isLogin = tab.dataset.tab === "login";
        $("#login-form").classList.toggle("hidden", !isLogin);
        $("#register-form").classList.toggle("hidden", isLogin);
        $("#login-error").textContent = "";
        $("#register-error").textContent = "";
      });
    });

    // Kişisel hesap kaydı (e-posta + şifre)
    $("#register-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      const err = $("#register-error"); err.textContent = "";
      const name = $("#reg-name").value.trim();
      const phone = $("#reg-phone").value.trim();
      const email = $("#reg-email").value.trim().toLowerCase();
      const password = $("#reg-password").value;
      if (!name || !email || !password) { err.textContent = "Lütfen zorunlu alanları doldurun."; return; }
      if (password.length < 6) { err.textContent = "Şifre en az 6 karakter olmalı."; return; }
      const btn = e.submitter; if (btn) btn.classList.add("is-loading");
      try {
        await Auth.signUp({ email, password, displayName: name, phone, username: email.split("@")[0] });
        const profile = await Auth.currentUser();
        if (!profile) { err.textContent = "Hesap açıldı ama oturum başlatılamadı, giriş yapın."; return; }
        startSession(profile);
        toast("Hesabınız oluşturuldu 🎉");
      } catch (ex) {
        console.error(ex);
        err.textContent = /registered|already/i.test(ex.message || "")
          ? "Bu e-posta zaten kayıtlı." : "Hesap oluşturulamadı: " + (ex.message || "");
      } finally { if (btn) btn.classList.remove("is-loading"); }
    });

    // Giriş (e-posta + şifre)
    $("#login-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      const err = $("#login-error"); err.textContent = "";
      const email = $("#login-email").value.trim().toLowerCase();
      const password = $("#login-password").value;
      const btn = e.submitter; if (btn) btn.classList.add("is-loading");
      try {
        await Auth.signIn({ email, password });
        const profile = await Auth.currentUser();
        if (!profile) { err.textContent = "Giriş yapıldı ama profil bulunamadı."; return; }
        startSession(profile);
      } catch (ex) {
        console.error(ex);
        err.textContent = "E-posta veya şifre hatalı.";
      } finally { if (btn) btn.classList.remove("is-loading"); }
    });

    const doLogout = async () => {
      try { await Auth.signOut(); } catch (ex) { console.error(ex); }
      localStorage.removeItem(WS_KEY);
      currentUser = currentCompany = currentRole = null;
      $("#app-screen").classList.add("hidden");
      $("#workspace-screen").classList.add("hidden");
      $("#auth-screen").classList.remove("hidden");
      $("#login-form").reset();
    };
    $("#logout-btn").addEventListener("click", doLogout);
    $("#ws-logout-btn").addEventListener("click", doLogout);
  }

  function startSession(user) {
    currentUser = user;
    $("#auth-screen").classList.add("hidden");
    routeAfterLogin();
  }

  /** Giriş sonrası: şirket seçimi mi, doğrudan uygulama mı? */
  async function routeAfterLogin() {
    const memberships = await DB.getMembershipsByUser(currentUser.id);
    const lastWs = localStorage.getItem(WS_KEY);
    if (lastWs && memberships.some((m) => m.companyId === lastWs)) {
      return enterWorkspace(lastWs);
    }
    if (memberships.length === 1) return enterWorkspace(memberships[0].companyId);
    showWorkspaceScreen(memberships);
  }

  /* ======================================================
     ÇALIŞMA ALANI (ŞİRKET) SEÇİMİ
     ====================================================== */
  async function showWorkspaceScreen(memberships) {
    if (!memberships) memberships = await DB.getMembershipsByUser(currentUser.id);
    $("#app-screen").classList.add("hidden");
    $("#workspace-screen").classList.remove("hidden");
    $("#ws-user-name").textContent = currentUser.displayName || currentUser.username;
    $("#ws-user-initial").textContent = (currentUser.displayName || currentUser.username).charAt(0).toUpperCase();

    const list = $("#workspace-list");
    list.innerHTML = "";
    $("#workspace-empty").classList.toggle("hidden", memberships.length > 0);

    for (const m of memberships) {
      const company = await DB.getCompany(m.companyId);
      if (!company) continue;
      const card = document.createElement("button");
      card.className = "workspace-card";
      card.innerHTML = `
        <div class="company-badge">${escapeHtml(company.name.charAt(0).toUpperCase())}</div>
        <div class="workspace-info">
          <div class="company-name">${escapeHtml(company.name)}</div>
          <div class="company-owner"><span class="role-badge ${m.role}">${m.role === "owner" ? "Patron" : "Usta"}</span></div>
        </div>`;
      card.addEventListener("click", () => enterWorkspace(company.id));
      list.appendChild(card);
    }
  }

  async function enterWorkspace(companyId) {
    currentCompany = await DB.getCompany(companyId);
    const membership = await DB.getMembership(companyId, currentUser.id);
    if (!currentCompany || !membership) return showWorkspaceScreen();
    currentRole = membership.role;
    localStorage.setItem(WS_KEY, companyId);

    $("#auth-screen").classList.add("hidden");
    $("#workspace-screen").classList.add("hidden");
    $("#app-screen").classList.remove("hidden");

    renderHeader();
    applyRoleVisibility();
    switchView("services");
  }

  function renderHeader() {
    $("#company-name").textContent = currentCompany.name;
    $("#company-initial").textContent = currentCompany.name.trim().charAt(0).toUpperCase();
    $("#current-user-name").textContent = currentUser.displayName || currentUser.username;
    const badge = $("#user-role-badge");
    badge.textContent = currentRole === "owner" ? "Patron" : "Usta";
    badge.className = "role-badge " + currentRole;
  }

  function applyRoleVisibility() {
    const ownerOnly = currentRole === "owner";
    $$(".owner-only").forEach((el) => el.classList.toggle("hidden", !ownerOnly));
  }

  function initWorkspace() {
    $("#switch-company-btn").addEventListener("click", () => showWorkspaceScreen());
    $("#create-company-btn").addEventListener("click", () => {
      $("#company-form").reset();
      $("#company-error").textContent = "";
      showModal("company-modal");
    });
    $("#company-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      const err = $("#company-error"); err.textContent = "";
      const name = $("#company-input-name").value.trim();
      if (!name) { err.textContent = "Şirket adı gerekli."; return; }
      const btn = e.submitter; if (btn) btn.classList.add("is-loading");
      try {
        const company = await DB.addCompany({ name, ownerId: currentUser.id });
        await DB.addMember({
          companyId: company.id, userId: currentUser.id, role: "owner",
          username: currentUser.username, displayName: currentUser.displayName, phone: currentUser.phone,
        });
        hideModal("company-modal");
        toast("Şirket oluşturuldu 🎉");
        enterWorkspace(company.id);
      } catch (ex) { console.error(ex); err.textContent = "Şirket oluşturulamadı: " + (ex.message || ""); }
      finally { if (btn) btn.classList.remove("is-loading"); }
    });
  }

  /* ======================================================
     GÖRÜNÜM YÖNETİMİ
     ====================================================== */
  function initNav() {
    $$(".nav-btn").forEach((btn) => btn.addEventListener("click", () => switchView(btn.dataset.view)));
    // Modal kapatma butonları (data-close)
    $$("[data-close]").forEach((el) =>
      el.addEventListener("click", () => hideModal(el.dataset.close)));
  }

  function switchView(view) {
    $$(".nav-btn").forEach((b) => b.classList.toggle("active", b.dataset.view === view));
    $("#view-services").classList.toggle("hidden", view !== "services");
    $("#view-employees").classList.toggle("hidden", view !== "employees");
    $("#view-reports").classList.toggle("hidden", view !== "reports");
    if (view === "services") renderServices();
    if (view === "employees") renderEmployees();
    if (view === "reports") renderReports();
  }

  /* ======================================================
     SERVİSLER
     ====================================================== */
  async function getVisibleServices() {
    let list;
    if (currentRole === "owner") {
      list = await DB.getServicesByCompany(currentCompany.id);
    } else {
      list = (await DB.getServicesAssignedTo(currentUser.id))
        .filter((s) => s.companyId === currentCompany.id);
    }
    return list.sort((a, b) => b.createdAt - a.createdAt);
  }

  function initServices() {
    $("#add-service-btn").addEventListener("click", openServiceModal);

    $("#status-filter").addEventListener("click", (e) => {
      const chip = e.target.closest(".chip");
      if (!chip) return;
      $$("#status-filter .chip").forEach((c) => c.classList.remove("active"));
      chip.classList.add("active");
      currentFilter = chip.dataset.status;
      renderServices();
    });

    initServiceModal();
    initAssignModal();
    initCompleteModal();
  }

  async function renderServices() {
    const all = await getVisibleServices();

    // İstatistik
    const today = todayStr();
    const open = all.filter((s) => s.status !== "closed").length;
    const doneToday = all.filter((s) => (s.status === "completed" || s.status === "closed") && s.completion && dateStrOf(s.completion.completedAt) === today);
    const totalToday = doneToday.reduce((sum, s) => sum + Number(s.completion.amount || 0), 0);
    $("#stat-open").textContent = open;
    $("#stat-done").textContent = doneToday.length;
    $("#stat-total").textContent = formatMoney(totalToday);

    // Filtre
    let list = all;
    if (currentFilter === "active") list = all.filter((s) => s.status !== "closed");
    else if (currentFilter !== "all") list = all.filter((s) => s.status === currentFilter);

    const wrap = $("#service-list");
    wrap.innerHTML = "";
    $("#services-empty").classList.toggle("hidden", list.length > 0);
    list.forEach((s) => wrap.appendChild(serviceCard(s)));
  }

  function serviceCard(s) {
    const card = document.createElement("div");
    card.className = "service-card";
    const st = STATUS[s.status] || STATUS.open;
    card.innerHTML = `
      <div class="service-card-top">
        <span class="status-badge ${st.cls}">${st.label}</span>
        <span class="service-time">${formatTime(s.createdAt)}</span>
      </div>
      <h4 class="service-customer">${escapeHtml(s.customerName)}</h4>
      <p class="service-problem">${escapeHtml(s.problem)}</p>
      ${s.address ? `<p class="service-line">📍 ${escapeHtml(s.address)}</p>` : ""}
      ${s.assignedName ? `<p class="service-line">🔧 ${escapeHtml(s.assignedName)}</p>` : `<p class="service-line muted">Usta atanmadı</p>`}
      ${s.completion ? `<p class="service-line strong">${formatMoney(s.completion.amount)}</p>` : ""}
    `;
    card.addEventListener("click", () => openDetail(s.id));
    return card;
  }

  /* ---- Yeni servis ---- */
  async function fillTechSelect(selectEl, includeEmpty) {
    const members = await DB.getMembersByCompany(currentCompany.id);
    const techs = members; // owner da saha işine atanabilir
    selectEl.innerHTML = includeEmpty ? `<option value="">— Sonra atanacak —</option>` : "";
    techs.forEach((m) => {
      const opt = document.createElement("option");
      opt.value = m.userId;
      opt.textContent = `${m.displayName || m.username}${m.role === "owner" ? " (Patron)" : ""}`;
      opt.dataset.name = m.displayName || m.username;
      opt.dataset.phone = m.phone || "";
      selectEl.appendChild(opt);
    });
  }

  function openServiceModal() {
    $("#service-form").reset();
    $("#service-error").textContent = "";
    fillTechSelect($("#svc-assign"), true);
    showModal("service-modal");
    $("#svc-customer").focus();
  }

  function initServiceModal() {
    $("#service-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      const err = $("#service-error"); err.textContent = "";
      const customerName = $("#svc-customer").value.trim();
      const customerPhone = $("#svc-phone").value.trim();
      const address = $("#svc-address").value.trim();
      const problem = $("#svc-problem").value.trim();
      if (!customerName || !customerPhone || !problem) { err.textContent = "Müşteri, telefon ve arıza zorunlu."; return; }

      const assignSel = $("#svc-assign");
      const assignedUserId = assignSel.value || null;
      const opt = assignSel.selectedOptions[0];

      const service = {
        companyId: currentCompany.id,
        customerName, customerPhone, address, problem,
        status: assignedUserId ? "assigned" : "open",
        assignedUserId,
        assignedName: assignedUserId ? opt.dataset.name : null,
        assignedPhone: assignedUserId ? opt.dataset.phone : null,
        createdBy: currentUser.id,
        createdAt: Date.now(),
        assignedAt: assignedUserId ? Date.now() : null,
        enrouteAt: null, completion: null, payment: null, closedAt: null,
      };
      const btn = e.submitter; if (btn) btn.classList.add("is-loading");
      try {
        await DB.addService(service);
        hideModal("service-modal");
        toast("Servis kaydı açıldı.");
        renderServices();
        if (assignedUserId) notifyTechAssigned(service);
      } catch (ex) { console.error(ex); err.textContent = "Kaydedilemedi."; }
      finally { if (btn) btn.classList.remove("is-loading"); }
    });
  }

  function notifyTechAssigned(s) {
    if (!s.assignedPhone) return;
    const text =
      `Merhaba ${s.assignedName}, yeni servis atandı:\n` +
      `Müşteri: ${s.customerName}\nTelefon: ${s.customerPhone}\n` +
      (s.address ? `Adres: ${s.address}\n` : "") +
      `Arıza: ${s.problem}`;
    openWa(s.assignedPhone, text);
  }

  /* ---- Usta atama ---- */
  let assignTargetId = null;
  function initAssignModal() {
    $("#assign-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      const err = $("#assign-error"); err.textContent = "";
      const sel = $("#assign-select");
      if (!sel.value) { err.textContent = "Usta seçin."; return; }
      const opt = sel.selectedOptions[0];
      const s = await DB.getService(assignTargetId);
      if (!s) return;
      s.assignedUserId = sel.value;
      s.assignedName = opt.dataset.name;
      s.assignedPhone = opt.dataset.phone;
      s.assignedAt = Date.now();
      if (s.status === "open") s.status = "assigned";
      await DB.updateService(s);
      hideModal("assign-modal");
      toast("Usta atandı.");
      renderServices();
      notifyTechAssigned(s);
    });
  }
  async function openAssign(serviceId) {
    assignTargetId = serviceId;
    $("#assign-error").textContent = "";
    await fillTechSelect($("#assign-select"), false);
    showModal("assign-modal");
  }

  /* ---- İş tamamlama ---- */
  let completeTargetId = null;
  let pendingPhotos = [];
  function initCompleteModal() {
    $("#cmp-photos").addEventListener("change", async (e) => {
      for (const file of Array.from(e.target.files)) {
        try { pendingPhotos.push(await compressImage(file)); }
        catch (ex) { console.error("Fotoğraf işlenemedi", ex); }
      }
      renderPhotoPreview();
      e.target.value = "";
    });

    $("#complete-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      const err = $("#complete-error"); err.textContent = "";
      const desc = $("#cmp-desc").value.trim();
      const amount = parseFloat($("#cmp-amount").value);
      if (!desc) { err.textContent = "Açıklama gerekli."; return; }
      if (isNaN(amount) || amount < 0) { err.textContent = "Geçerli bir ücret girin."; return; }
      const s = await DB.getService(completeTargetId);
      if (!s) return;
      s.completion = { description: desc, amount, photos: pendingPhotos.slice(), completedAt: Date.now(), completedBy: currentUser.id };
      s.status = "completed";
      const btn = e.submitter; if (btn) btn.classList.add("is-loading");
      try {
        await DB.updateService(s);
        hideModal("complete-modal");
        toast("İş tamamlandı. Servis formu hazır.");
        renderServices();
        openDetail(s.id);
      } catch (ex) { console.error(ex); err.textContent = "Kaydedilemedi (fotoğraflar büyük olabilir)."; }
      finally { if (btn) btn.classList.remove("is-loading"); }
    });
  }
  function openComplete(serviceId) {
    completeTargetId = serviceId;
    $("#complete-form").reset();
    pendingPhotos = [];
    $("#cmp-photo-preview").innerHTML = "";
    $("#complete-error").textContent = "";
    showModal("complete-modal");
    $("#cmp-desc").focus();
  }
  function renderPhotoPreview() {
    const wrap = $("#cmp-photo-preview");
    wrap.innerHTML = "";
    pendingPhotos.forEach((p, i) => {
      const item = document.createElement("div");
      item.className = "preview-item";
      item.innerHTML = `<img src="${p}" alt="önizleme" /><button type="button" class="preview-del">&times;</button>`;
      item.querySelector(".preview-del").addEventListener("click", () => {
        pendingPhotos.splice(i, 1); renderPhotoPreview();
      });
      wrap.appendChild(item);
    });
  }

  /* ======================================================
     SERVİS DETAYI + AKSİYONLAR
     ====================================================== */
  async function openDetail(serviceId) {
    const s = await DB.getService(serviceId);
    if (!s) return;
    const st = STATUS[s.status] || STATUS.open;
    const isOwner = currentRole === "owner";
    const isAssigned = s.assignedUserId === currentUser.id;
    const canAct = isOwner || isAssigned;

    const photosHtml = (s.completion?.photos || [])
      .map((p) => `<img src="${p}" class="job-thumb" alt="iş fotoğrafı" />`).join("");

    // Zaman çizelgesi
    const steps = [
      ["Servis açıldı", s.createdAt],
      ["Usta atandı", s.assignedAt],
      ["Yola çıkıldı", s.enrouteAt],
      ["İş tamamlandı", s.completion?.completedAt],
      ["Kapandı", s.closedAt],
    ].filter(([, t]) => t)
     .map(([label, t]) => `<li><span>${label}</span><time>${formatTime(t)}</time></li>`).join("");

    const body = $("#detail-body");
    body.innerHTML = `
      <div class="detail-status"><span class="status-badge ${st.cls}">${st.label}</span></div>
      <div class="detail-grid">
        <div><span class="dt-label">Müşteri</span><span class="dt-val">${escapeHtml(s.customerName)}</span></div>
        <div><span class="dt-label">Telefon</span><span class="dt-val">${escapeHtml(s.customerPhone)}</span></div>
        <div class="full"><span class="dt-label">Adres</span><span class="dt-val">${escapeHtml(s.address) || "—"}</span></div>
        <div class="full"><span class="dt-label">Arıza / Talep</span><span class="dt-val">${escapeHtml(s.problem)}</span></div>
        <div class="full"><span class="dt-label">Atanan Usta</span><span class="dt-val">${escapeHtml(s.assignedName) || "—"}</span></div>
        ${s.completion ? `
          <div class="full"><span class="dt-label">Yapılan İş</span><span class="dt-val">${escapeHtml(s.completion.description)}</span></div>
          <div><span class="dt-label">Tutar</span><span class="dt-val strong">${formatMoney(s.completion.amount)}</span></div>
          ${s.payment ? `<div><span class="dt-label">Tahsilat</span><span class="dt-val">${escapeHtml(s.payment.method || "Alındı")}</span></div>` : ""}
        ` : ""}
      </div>
      ${photosHtml ? `<div class="job-photos">${photosHtml}</div>` : ""}
      ${steps ? `<ul class="timeline">${steps}</ul>` : ""}
      <div class="detail-actions" id="detail-actions"></div>
    `;

    body.querySelectorAll(".job-thumb").forEach((img) =>
      img.addEventListener("click", () => openLightbox(img.src)));

    // Aksiyon butonları
    const act = body.querySelector("#detail-actions");
    const addBtn = (label, cls, fn) => {
      const b = document.createElement("button");
      b.className = "btn " + cls;
      b.textContent = label;
      b.addEventListener("click", fn);
      act.appendChild(b);
    };

    if (isOwner && s.status !== "closed") {
      addBtn(s.assignedUserId ? "Ustayı Değiştir" : "Usta Ata", "btn-ghost", () => { hideModal("detail-modal"); openAssign(s.id); });
    }
    if (canAct && s.status === "assigned") {
      addBtn("Yola Çıktım → Müşteriye Haber Ver", "btn-primary", () => markEnroute(s.id));
    }
    if (canAct && (s.status === "assigned" || s.status === "enroute")) {
      addBtn("İşi Tamamla", "btn-success", () => { hideModal("detail-modal"); openComplete(s.id); });
    }
    if (s.completion) {
      addBtn("Servis Formu (PDF / Yazdır)", "btn-ghost", () => printServiceForm(s));
      addBtn("WhatsApp ile Müşteriye Gönder", "btn-ghost", () => sendFormToCustomer(s));
    }
    if (isOwner && s.status === "completed") {
      addBtn("Tahsilatı Al & Servisi Kapat", "btn-success", () => closeService(s.id));
    }
    if (isOwner && s.status !== "closed") {
      addBtn("Servisi Sil", "btn-danger", () => deleteService(s.id));
    }

    showModal("detail-modal");
  }

  async function markEnroute(serviceId) {
    const s = await DB.getService(serviceId);
    if (!s) return;
    s.status = "enroute";
    s.enrouteAt = Date.now();
    await DB.updateService(s);
    const text = `Merhaba ${s.customerName}, ${currentCompany.name} servis ekibi yola çıktı, kısa süre içinde adresinize geliyoruz. 🛠`;
    openWa(s.customerPhone, text);
    toast("Müşteriye WhatsApp mesajı açıldı.");
    renderServices();
    openDetail(serviceId);
  }

  function sendFormToCustomer(s) {
    const c = s.completion;
    const text =
      `Merhaba ${s.customerName}, servis işleminiz tamamlandı.\n\n` +
      `🛠 Yapılan İşlem: ${c.description}\n` +
      `💰 Tutar: ${formatMoney(c.amount)}\n` +
      (s.address ? `📍 Adres: ${s.address}\n` : "") +
      `\n${currentCompany.name} — bizi tercih ettiğiniz için teşekkürler.`;
    openWa(s.customerPhone, text);
    toast("Servis formu WhatsApp ile açıldı.");
  }

  async function closeService(serviceId) {
    const s = await DB.getService(serviceId);
    if (!s) return;
    const ok = await confirmDialog("Tahsilat & Kapanış",
      `${s.customerName} — ${formatMoney(s.completion.amount)} tahsil edildi olarak işaretlenip servis kapatılsın mı?`, "Kapat");
    if (!ok) return;
    s.status = "closed";
    s.payment = { amount: s.completion.amount, method: "Tahsil edildi", collectedAt: Date.now() };
    s.closedAt = Date.now();
    await DB.updateService(s);
    hideModal("detail-modal");
    toast("Servis kapatıldı ✓");
    renderServices();
  }

  async function deleteService(serviceId) {
    const ok = await confirmDialog("Servisi sil", "Bu servis kaydı tamamen silinsin mi?", "Sil");
    if (!ok) return;
    await DB.deleteService(serviceId);
    hideModal("detail-modal");
    toast("Servis silindi.");
    renderServices();
  }

  /* ---- Servis formu PDF / yazdır ---- */
  function printServiceForm(s) {
    const c = s.completion || {};
    const win = window.open("", "_blank");
    const photos = (c.photos || []).map((p) => `<img src="${p}" style="max-width:48%;margin:4px;border:1px solid #cbd5e1;border-radius:6px" />`).join("");
    win.document.write(`
      <html lang="tr"><head><meta charset="utf-8"><title>Servis Formu - ${escapeHtml(s.customerName)}</title>
      <style>
        body{font-family:Arial,sans-serif;padding:32px;color:#1e293b;max-width:800px;margin:auto}
        h1{font-size:22px;margin:0 0 2px}
        .sub{color:#64748b;margin-bottom:20px;font-size:13px}
        table{width:100%;border-collapse:collapse;margin:14px 0}
        th,td{border:1px solid #cbd5e1;padding:9px 11px;font-size:14px;text-align:left;vertical-align:top}
        th{background:#f1f5f9;width:140px}
        .total{font-size:18px;font-weight:bold;text-align:right;margin-top:10px}
        .photos{margin-top:14px;display:flex;flex-wrap:wrap}
      </style></head><body>
      <h1>${escapeHtml(currentCompany.name)}</h1>
      <div class="sub">Servis Formu • ${formatDateTR(dateStrOf(c.completedAt || s.createdAt))}</div>
      <table>
        <tr><th>Müşteri</th><td>${escapeHtml(s.customerName)}</td></tr>
        <tr><th>Telefon</th><td>${escapeHtml(s.customerPhone)}</td></tr>
        <tr><th>Adres</th><td>${escapeHtml(s.address) || "-"}</td></tr>
        <tr><th>Arıza / Talep</th><td>${escapeHtml(s.problem)}</td></tr>
        <tr><th>Yapılan İşlem</th><td>${escapeHtml(c.description) || "-"}</td></tr>
        <tr><th>Usta</th><td>${escapeHtml(s.assignedName) || "-"}</td></tr>
      </table>
      <div class="total">TUTAR: ${formatMoney(c.amount)}</div>
      ${photos ? `<div class="photos">${photos}</div>` : ""}
      </body></html>`);
    win.document.close();
    win.focus();
    setTimeout(() => win.print(), 350);
  }

  /* ======================================================
     ÇALIŞANLAR (sadece patron)
     ====================================================== */
  function initEmployees() {
    $("#add-employee-btn").addEventListener("click", () => {
      $("#employee-form").reset();
      $("#emp-new-fields").classList.add("hidden");
      $("#emp-submit").textContent = "Ekle";
      $("#employee-error").textContent = "";
      showModal("employee-modal");
      $("#emp-email").focus();
    });

    $("#employee-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      const err = $("#employee-error"); err.textContent = "";
      const email = $("#emp-email").value.trim().toLowerCase();
      if (!email) { err.textContent = "E-posta gerekli."; return; }
      const newFields = $("#emp-new-fields");

      const btn = e.submitter; if (btn) btn.classList.add("is-loading");
      try {
        let user = await DB.getUserByEmail(email);

        // Kullanıcı yoksa: yeni usta hesabı oluşturma alanlarını göster / işle
        if (!user) {
          if (newFields.classList.contains("hidden")) {
            newFields.classList.remove("hidden");
            $("#emp-submit").textContent = "Hesabı Oluştur ve Ekle";
            err.textContent = "Bu e-posta bulunamadı. Yeni usta hesabı oluşturmak için bilgileri doldurun.";
            return;
          }
          const name = $("#emp-name").value.trim();
          const phone = $("#emp-phone").value.trim();
          const password = $("#emp-password").value;
          if (!name || !password) { err.textContent = "Ad soyad ve şifre gerekli."; return; }
          if (password.length < 6) { err.textContent = "Şifre en az 6 karakter olmalı."; return; }
          await Auth.createWorkerAccount({ email, password, displayName: name, phone, username: email.split("@")[0] });
          // Trigger profili oluşturur; oluşana kadar kısa bekleme/yeniden deneme
          for (let i = 0; i < 5 && !user; i++) {
            user = await DB.getUserByEmail(email);
            if (!user) await new Promise((r) => setTimeout(r, 400));
          }
          if (!user) { err.textContent = "Hesap oluşturuldu ama profil okunamadı, tekrar deneyin."; return; }
        }

        // Zaten üye mi?
        if (await DB.getMembership(currentCompany.id, user.id)) {
          err.textContent = "Bu kişi zaten şirkette."; return;
        }
        await DB.addMember({
          companyId: currentCompany.id, userId: user.id, role: "usta",
          username: user.username, displayName: user.displayName, phone: user.phone,
        });
        hideModal("employee-modal");
        toast(`${user.displayName || user.username} eklendi.`);
        renderEmployees();
      } catch (ex) { console.error(ex); err.textContent = "Eklenemedi: " + (ex.message || ""); }
      finally { if (btn) btn.classList.remove("is-loading"); }
    });
  }

  async function renderEmployees() {
    const members = await DB.getMembersByCompany(currentCompany.id);
    members.sort((a, b) => (a.role === "owner" ? -1 : 1) - (b.role === "owner" ? -1 : 1));
    const list = $("#employee-list");
    list.innerHTML = "";
    members.forEach((m) => {
      const card = document.createElement("div");
      card.className = "member-card";
      const isOwner = m.role === "owner";
      const canRemove = currentRole === "owner" && !isOwner;
      card.innerHTML = `
        <div class="company-badge sm">${escapeHtml((m.displayName || m.username).charAt(0).toUpperCase())}</div>
        <div class="member-info">
          <div class="member-name">${escapeHtml(m.displayName || m.username)}
            <span class="role-badge ${m.role}">${isOwner ? "Patron" : "Usta"}</span></div>
          <div class="member-meta">@${escapeHtml(m.username)}${m.phone ? " • " + escapeHtml(m.phone) : ""}</div>
        </div>
        ${m.phone ? `<button class="icon-btn wa" title="WhatsApp">🟢</button>` : ""}
        ${canRemove ? `<button class="icon-btn del" title="Çıkar">🗑</button>` : ""}
      `;
      const wa = card.querySelector(".wa");
      if (wa) wa.addEventListener("click", () => openWa(m.phone, `Merhaba ${m.displayName || m.username}`));
      const del = card.querySelector(".del");
      if (del) del.addEventListener("click", async () => {
        const ok = await confirmDialog("Çalışanı çıkar", `${m.displayName || m.username} şirketten çıkarılsın mı?`, "Çıkar");
        if (!ok) return;
        await DB.deleteMember(m.id);
        toast("Çalışan çıkarıldı.");
        renderEmployees();
      });
      list.appendChild(card);
    });
  }

  /* ======================================================
     RAPORLAR (kapanan servisler)
     ====================================================== */
  async function renderReports() {
    const all = await getVisibleServices();
    const closed = all.filter((s) => s.status === "closed")
      .sort((a, b) => b.closedAt - a.closedAt);
    const total = closed.reduce((sum, s) => sum + Number(s.payment?.amount || 0), 0);
    $("#rep-count").textContent = closed.length;
    $("#rep-total").textContent = formatMoney(total);

    const list = $("#reports-list");
    list.innerHTML = "";
    $("#reports-empty").classList.toggle("hidden", closed.length > 0);

    closed.forEach((s) => {
      const card = document.createElement("div");
      card.className = "report-card";
      card.innerHTML = `
        <div class="report-head">
          <div>
            <div class="report-date">${escapeHtml(s.customerName)}</div>
            <div class="report-meta">${formatDateTR(dateStrOf(s.closedAt))} • ${escapeHtml(s.assignedName) || "-"}</div>
          </div>
          <div class="report-total">${formatMoney(s.payment?.amount)}</div>
        </div>
        <div class="report-actions">
          <button class="btn btn-ghost btn-sm r-detail">Detay</button>
          <button class="btn btn-ghost btn-sm r-print">🖨 Form</button>
        </div>`;
      card.querySelector(".r-detail").addEventListener("click", () => openDetail(s.id));
      card.querySelector(".r-print").addEventListener("click", () => printServiceForm(s));
      list.appendChild(card);
    });
  }

  /* ======================================================
     LIGHTBOX
     ====================================================== */
  function openLightbox(src) {
    $("#lightbox-img").src = src;
    $("#lightbox").classList.remove("hidden");
  }
  function initLightbox() {
    const lb = $("#lightbox");
    $("#lightbox-close").addEventListener("click", () => lb.classList.add("hidden"));
    lb.addEventListener("click", (e) => { if (e.target === lb) lb.classList.add("hidden"); });
  }

  /* ======================================================
     BAŞLATMA
     ====================================================== */
  async function init() {
    initAuth();
    initWorkspace();
    initNav();
    initServices();
    initEmployees();
    initLightbox();

    try {
      const profile = await Auth.currentUser();
      if (profile) { currentUser = profile; $("#auth-screen").classList.add("hidden"); return routeAfterLogin(); }
    } catch (ex) { console.error(ex); }
    $("#auth-screen").classList.remove("hidden");
  }

  document.addEventListener("DOMContentLoaded", init);
})();
