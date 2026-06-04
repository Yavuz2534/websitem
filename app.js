/* ============================================================
   app.js — İş Takip Sistemi ana mantığı
   ============================================================ */
(function () {
  "use strict";

  const SESSION_KEY = "isTakip_session";
  let currentAccount = null;

  /* ---------------- Yardımcılar ---------------- */
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => Array.from(document.querySelectorAll(sel));
  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

  function todayStr() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  }

  function formatDateTR(dateStr) {
    const [y, m, d] = dateStr.split("-");
    const aylar = ["Ocak","Şubat","Mart","Nisan","Mayıs","Haziran","Temmuz","Ağustos","Eylül","Ekim","Kasım","Aralık"];
    const gunler = ["Pazar","Pazartesi","Salı","Çarşamba","Perşembe","Cuma","Cumartesi"];
    const dt = new Date(Number(y), Number(m) - 1, Number(d));
    return `${Number(d)} ${aylar[Number(m) - 1]} ${y}, ${gunler[dt.getDay()]}`;
  }

  function formatMoney(n) {
    return new Intl.NumberFormat("tr-TR", { maximumFractionDigits: 2 }).format(n || 0) + " ₺";
  }

  async function sha256(text) {
    const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
    return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
  }

  function toast(msg) {
    const t = $("#toast");
    t.textContent = msg;
    t.classList.remove("hidden");
    clearTimeout(t._timer);
    t._timer = setTimeout(() => t.classList.add("hidden"), 2600);
  }

  /** Fotoğrafı küçültüp JPEG base64'e çevirir (depolama tasarrufu). */
  function compressImage(file, maxSize = 1280, quality = 0.7) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const img = new Image();
        img.onload = () => {
          let { width, height } = img;
          if (width > height && width > maxSize) {
            height = Math.round((height * maxSize) / width);
            width = maxSize;
          } else if (height > maxSize) {
            width = Math.round((width * maxSize) / height);
            height = maxSize;
          }
          const canvas = document.createElement("canvas");
          canvas.width = width;
          canvas.height = height;
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

  /* ---------------- Onay modalı ---------------- */
  function confirmDialog(title, text, confirmLabel = "Evet") {
    return new Promise((resolve) => {
      $("#confirm-title").textContent = title;
      $("#confirm-text").textContent = text;
      $("#confirm-yes").textContent = confirmLabel;
      const modal = $("#confirm-modal");
      modal.classList.remove("hidden");

      const cleanup = (val) => {
        modal.classList.add("hidden");
        $("#confirm-yes").onclick = null;
        $("#confirm-no").onclick = null;
        resolve(val);
      };
      $("#confirm-yes").onclick = () => cleanup(true);
      $("#confirm-no").onclick = () => cleanup(false);
    });
  }

  /* ======================================================
     KİMLİK DOĞRULAMA
     ====================================================== */
  function initAuth() {
    // Sekme geçişi
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

    // Kayıt
    $("#register-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      const err = $("#register-error");
      err.textContent = "";
      const company = $("#reg-company").value.trim();
      const owner = $("#reg-owner").value.trim();
      const username = $("#reg-username").value.trim().toLowerCase();
      const password = $("#reg-password").value;

      if (!company || !username || !password) {
        err.textContent = "Lütfen zorunlu alanları doldurun.";
        return;
      }
      try {
        const existing = await DB.getAccountByUsername(username);
        if (existing) {
          err.textContent = "Bu kullanıcı adı zaten alınmış.";
          return;
        }
        const account = {
          id: uid(),
          companyName: company,
          ownerName: owner,
          username,
          passwordHash: await sha256(password),
          createdAt: Date.now(),
        };
        await DB.addAccount(account);
        startSession(account);
        toast("Şirket hesabınız oluşturuldu 🎉");
      } catch (ex) {
        console.error(ex);
        err.textContent = "Hesap oluşturulamadı. Tekrar deneyin.";
      }
    });

    // Giriş
    $("#login-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      const err = $("#login-error");
      err.textContent = "";
      const username = $("#login-username").value.trim().toLowerCase();
      const password = $("#login-password").value;
      try {
        const account = await DB.getAccountByUsername(username);
        if (!account || account.passwordHash !== (await sha256(password))) {
          err.textContent = "Kullanıcı adı veya şifre hatalı.";
          return;
        }
        startSession(account);
      } catch (ex) {
        console.error(ex);
        err.textContent = "Giriş yapılamadı. Tekrar deneyin.";
      }
    });

    $("#logout-btn").addEventListener("click", () => {
      localStorage.removeItem(SESSION_KEY);
      currentAccount = null;
      $("#app-screen").classList.add("hidden");
      $("#auth-screen").classList.remove("hidden");
      $("#login-form").reset();
    });
  }

  function startSession(account) {
    currentAccount = account;
    localStorage.setItem(SESSION_KEY, account.id);
    $("#auth-screen").classList.add("hidden");
    $("#app-screen").classList.remove("hidden");
    renderHeader();
    switchView("today");
  }

  function renderHeader() {
    $("#company-name").textContent = currentAccount.companyName;
    $("#company-owner").textContent = currentAccount.ownerName || "";
    $("#company-initial").textContent = currentAccount.companyName.trim().charAt(0).toUpperCase();
  }

  /* ======================================================
     GÖRÜNÜM YÖNETİMİ
     ====================================================== */
  function initNav() {
    $$(".nav-btn").forEach((btn) => {
      btn.addEventListener("click", () => switchView(btn.dataset.view));
    });
  }

  function switchView(view) {
    $$(".nav-btn").forEach((b) => b.classList.toggle("active", b.dataset.view === view));
    $("#view-today").classList.toggle("hidden", view !== "today");
    $("#view-reports").classList.toggle("hidden", view !== "reports");
    if (view === "today") renderToday();
    if (view === "reports") renderReports();
  }

  /* ======================================================
     BUGÜN GÖRÜNÜMÜ
     ====================================================== */
  async function renderToday() {
    const date = todayStr();
    $("#today-date").textContent = formatDateTR(date);

    const jobs = (await DB.getJobsByDate(currentAccount.id, date))
      .sort((a, b) => b.createdAt - a.createdAt);
    const report = await DB.getReportByDate(currentAccount.id, date);

    const total = jobs.reduce((s, j) => s + Number(j.amount || 0), 0);
    $("#today-count").textContent = jobs.length;
    $("#today-total").textContent = formatMoney(total);

    const list = $("#today-jobs");
    list.innerHTML = "";
    $("#today-empty").classList.toggle("hidden", jobs.length > 0);

    jobs.forEach((job) => list.appendChild(jobCard(job, !!report)));

    // Gün kapatıldıysa buton durumunu güncelle
    const endBtn = $("#end-day-btn");
    if (report) {
      endBtn.textContent = "Gün Kapatıldı ✓";
      endBtn.disabled = true;
      endBtn.classList.add("done");
    } else {
      endBtn.textContent = "Gün Sonu Yap";
      endBtn.disabled = jobs.length === 0;
      endBtn.classList.remove("done");
    }
  }

  function jobCard(job, locked) {
    const card = document.createElement("div");
    card.className = "job-card";

    const photosHtml = (job.photos || [])
      .map((p, i) => `<img src="${p}" class="job-thumb" data-photo="${i}" alt="iş fotoğrafı" />`)
      .join("");

    const time = new Date(job.createdAt).toLocaleTimeString("tr-TR", { hour: "2-digit", minute: "2-digit" });

    card.innerHTML = `
      <div class="job-card-main">
        <div class="job-card-head">
          <h4>${escapeHtml(job.description)}</h4>
          <span class="job-amount">${formatMoney(job.amount)}</span>
        </div>
        ${job.location ? `<p class="job-loc">📍 ${escapeHtml(job.location)}</p>` : ""}
        <p class="job-time">🕒 ${time}</p>
        ${photosHtml ? `<div class="job-photos">${photosHtml}</div>` : ""}
      </div>
      ${locked ? "" : `<button class="job-del" title="Sil">🗑</button>`}
    `;

    // Fotoğraf büyütme
    card.querySelectorAll(".job-thumb").forEach((img) => {
      img.addEventListener("click", () => openLightbox(img.src));
    });

    // Silme
    const del = card.querySelector(".job-del");
    if (del) {
      del.addEventListener("click", async () => {
        const ok = await confirmDialog("İşi sil", `“${job.description}” işini silmek istiyor musunuz?`, "Sil");
        if (ok) {
          await DB.deleteJob(job.id);
          toast("İş silindi.");
          renderToday();
        }
      });
    }
    return card;
  }

  /* ======================================================
     İŞ EKLEME MODALI
     ====================================================== */
  let pendingPhotos = []; // base64 listesi

  function initJobModal() {
    const modal = $("#job-modal");
    const open = () => {
      $("#job-form").reset();
      pendingPhotos = [];
      $("#photo-preview").innerHTML = "";
      $("#job-error").textContent = "";
      modal.classList.remove("hidden");
      $("#job-desc").focus();
    };
    const close = () => modal.classList.add("hidden");

    $("#add-job-btn").addEventListener("click", async () => {
      const report = await DB.getReportByDate(currentAccount.id, todayStr());
      if (report) {
        toast("Bugünün günü kapatıldı. Yeni iş eklenemez.");
        return;
      }
      open();
    });
    $("#job-modal-close").addEventListener("click", close);
    $("#job-cancel").addEventListener("click", close);

    // Fotoğraf seçimi
    $("#job-photos").addEventListener("change", async (e) => {
      const files = Array.from(e.target.files);
      for (const file of files) {
        try {
          const b64 = await compressImage(file);
          pendingPhotos.push(b64);
        } catch (ex) {
          console.error("Fotoğraf işlenemedi", ex);
        }
      }
      renderPhotoPreview();
      e.target.value = ""; // aynı dosya tekrar seçilebilsin
    });

    // Kaydet
    $("#job-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      const err = $("#job-error");
      err.textContent = "";
      const desc = $("#job-desc").value.trim();
      const amount = parseFloat($("#job-amount").value);
      if (!desc) { err.textContent = "İş açıklaması gerekli."; return; }
      if (isNaN(amount) || amount < 0) { err.textContent = "Geçerli bir ücret girin."; return; }

      const job = {
        id: uid(),
        accountId: currentAccount.id,
        date: todayStr(),
        description: desc,
        location: $("#job-location").value.trim(),
        amount,
        photos: pendingPhotos.slice(),
        createdAt: Date.now(),
      };
      try {
        await DB.addJob(job);
        close();
        toast("İş kaydedildi.");
        renderToday();
      } catch (ex) {
        console.error(ex);
        err.textContent = "Kaydedilemedi (fotoğraflar çok büyük olabilir).";
      }
    });
  }

  function renderPhotoPreview() {
    const wrap = $("#photo-preview");
    wrap.innerHTML = "";
    pendingPhotos.forEach((p, i) => {
      const item = document.createElement("div");
      item.className = "preview-item";
      item.innerHTML = `<img src="${p}" alt="önizleme" /><button type="button" class="preview-del" data-i="${i}">&times;</button>`;
      item.querySelector(".preview-del").addEventListener("click", () => {
        pendingPhotos.splice(i, 1);
        renderPhotoPreview();
      });
      wrap.appendChild(item);
    });
  }

  /* ======================================================
     GÜN SONU
     ====================================================== */
  function initEndDay() {
    $("#end-day-btn").addEventListener("click", async () => {
      const date = todayStr();
      const jobs = await DB.getJobsByDate(currentAccount.id, date);
      if (jobs.length === 0) { toast("Bugün hiç iş yok."); return; }

      const total = jobs.reduce((s, j) => s + Number(j.amount || 0), 0);
      const ok = await confirmDialog(
        "Gün Sonu",
        `${jobs.length} iş, toplam ${formatMoney(total)}. Günü kapatıp rapor oluşturulsun mu?`,
        "Gün Sonu Yap"
      );
      if (!ok) return;

      const report = {
        id: `${currentAccount.id}_${date}`,
        accountId: currentAccount.id,
        date,
        jobCount: jobs.length,
        totalAmount: total,
        jobs: jobs.sort((a, b) => a.createdAt - b.createdAt).map((j) => ({
          description: j.description,
          location: j.location,
          amount: j.amount,
          photos: j.photos || [],
          createdAt: j.createdAt,
        })),
        closedAt: Date.now(),
      };
      await DB.addReport(report);
      toast("Gün sonu raporu oluşturuldu ✓");
      renderToday();
      switchView("reports");
    });
  }

  /* ======================================================
     RAPORLAR
     ====================================================== */
  async function renderReports() {
    const reports = (await DB.getReports(currentAccount.id))
      .sort((a, b) => b.date.localeCompare(a.date));
    const list = $("#reports-list");
    list.innerHTML = "";
    $("#reports-empty").classList.toggle("hidden", reports.length > 0);

    reports.forEach((rep) => {
      const card = document.createElement("div");
      card.className = "report-card";
      card.innerHTML = `
        <div class="report-head">
          <div>
            <div class="report-date">${formatDateTR(rep.date)}</div>
            <div class="report-meta">${rep.jobCount} iş</div>
          </div>
          <div class="report-total">${formatMoney(rep.totalAmount)}</div>
        </div>
        <div class="report-actions">
          <button class="btn btn-ghost btn-sm report-toggle">Detay</button>
          <button class="btn btn-ghost btn-sm report-print">🖨 Yazdır</button>
        </div>
        <div class="report-detail hidden"></div>
      `;

      const detail = card.querySelector(".report-detail");
      card.querySelector(".report-toggle").addEventListener("click", () => {
        if (detail.classList.contains("hidden")) {
          detail.innerHTML = rep.jobs.map((j, i) => `
            <div class="report-job">
              <div class="report-job-head">
                <span>${i + 1}. ${escapeHtml(j.description)}</span>
                <strong>${formatMoney(j.amount)}</strong>
              </div>
              ${j.location ? `<div class="report-job-loc">📍 ${escapeHtml(j.location)}</div>` : ""}
              ${(j.photos || []).length ? `<div class="report-job-photos">${j.photos.map((p) => `<img src="${p}" class="job-thumb" alt="foto" />`).join("")}</div>` : ""}
            </div>
          `).join("");
          detail.querySelectorAll(".job-thumb").forEach((img) =>
            img.addEventListener("click", () => openLightbox(img.src))
          );
          detail.classList.remove("hidden");
          card.querySelector(".report-toggle").textContent = "Gizle";
        } else {
          detail.classList.add("hidden");
          card.querySelector(".report-toggle").textContent = "Detay";
        }
      });

      card.querySelector(".report-print").addEventListener("click", () => printReport(rep));
      list.appendChild(card);
    });
  }

  function printReport(rep) {
    const win = window.open("", "_blank");
    const rows = rep.jobs.map((j, i) => `
      <tr>
        <td>${i + 1}</td>
        <td>${escapeHtml(j.description)}${j.location ? `<br><small>${escapeHtml(j.location)}</small>` : ""}</td>
        <td style="text-align:right">${formatMoney(j.amount)}</td>
      </tr>`).join("");

    win.document.write(`
      <html lang="tr"><head><meta charset="utf-8"><title>Günlük Rapor - ${rep.date}</title>
      <style>
        body{font-family:Arial,sans-serif;padding:30px;color:#1e293b}
        h1{font-size:20px;margin:0 0 4px}
        .sub{color:#64748b;margin-bottom:24px}
        table{width:100%;border-collapse:collapse;margin-top:12px}
        th,td{border:1px solid #cbd5e1;padding:8px 10px;font-size:14px;text-align:left}
        th{background:#f1f5f9}
        tfoot td{font-weight:bold;background:#f8fafc}
      </style></head><body>
      <h1>${escapeHtml(currentAccount.companyName)} — Günlük Rapor</h1>
      <div class="sub">${formatDateTR(rep.date)} &nbsp;•&nbsp; ${rep.jobCount} iş</div>
      <table>
        <thead><tr><th>#</th><th>İş</th><th style="text-align:right">Ücret</th></tr></thead>
        <tbody>${rows}</tbody>
        <tfoot><tr><td colspan="2">TOPLAM</td><td style="text-align:right">${formatMoney(rep.totalAmount)}</td></tr></tfoot>
      </table>
      </body></html>`);
    win.document.close();
    win.focus();
    setTimeout(() => win.print(), 300);
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

  /* ---------------- Güvenlik: HTML kaçışı ---------------- */
  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  /* ======================================================
     BAŞLATMA
     ====================================================== */
  async function init() {
    initAuth();
    initNav();
    initJobModal();
    initEndDay();
    initLightbox();

    // Oturum varsa otomatik giriş
    const savedId = localStorage.getItem(SESSION_KEY);
    if (savedId) {
      try {
        const acc = await DB.getAccount(savedId);
        if (acc) { startSession(acc); return; }
      } catch (ex) { console.error(ex); }
    }
    $("#auth-screen").classList.remove("hidden");
  }

  document.addEventListener("DOMContentLoaded", init);
})();
