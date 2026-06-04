/* ============================================================
   db.js — IndexedDB veri katmanı
   Fotoğraflar büyük olabildiği için localStorage yerine
   IndexedDB kullanılıyor.
   ============================================================ */
(function (global) {
  "use strict";

  const DB_NAME = "isTakipDB";
  const DB_VERSION = 1;
  let _db = null;

  /** Veritabanını açar / oluşturur. */
  function open() {
    return new Promise((resolve, reject) => {
      if (_db) return resolve(_db);
      const req = indexedDB.open(DB_NAME, DB_VERSION);

      req.onupgradeneeded = (e) => {
        const db = e.target.result;

        if (!db.objectStoreNames.contains("accounts")) {
          const s = db.createObjectStore("accounts", { keyPath: "id" });
          s.createIndex("username", "username", { unique: true });
        }
        if (!db.objectStoreNames.contains("jobs")) {
          const s = db.createObjectStore("jobs", { keyPath: "id" });
          s.createIndex("accountId", "accountId", { unique: false });
          s.createIndex("acc_date", ["accountId", "date"], { unique: false });
        }
        if (!db.objectStoreNames.contains("reports")) {
          const s = db.createObjectStore("reports", { keyPath: "id" });
          s.createIndex("accountId", "accountId", { unique: false });
          s.createIndex("acc_date", ["accountId", "date"], { unique: false });
        }
      };

      req.onsuccess = (e) => { _db = e.target.result; resolve(_db); };
      req.onerror = () => reject(req.error);
    });
  }

  function tx(store, mode) {
    return open().then((db) => db.transaction(store, mode).objectStore(store));
  }

  function reqToPromise(request) {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  /** Bir indeks üzerinden tüm kayıtları getirir. */
  function getAllByIndex(store, indexName, query) {
    return tx(store, "readonly").then((os) =>
      reqToPromise(os.index(indexName).getAll(query))
    );
  }

  const DB = {
    open,

    // ---- Hesaplar ----
    addAccount(acc) {
      return tx("accounts", "readwrite").then((os) => reqToPromise(os.add(acc)));
    },
    getAccount(id) {
      return tx("accounts", "readonly").then((os) => reqToPromise(os.get(id)));
    },
    getAccountByUsername(username) {
      return tx("accounts", "readonly").then((os) =>
        reqToPromise(os.index("username").get(username))
      );
    },

    // ---- İşler ----
    addJob(job) {
      return tx("jobs", "readwrite").then((os) => reqToPromise(os.add(job)));
    },
    updateJob(job) {
      return tx("jobs", "readwrite").then((os) => reqToPromise(os.put(job)));
    },
    deleteJob(id) {
      return tx("jobs", "readwrite").then((os) => reqToPromise(os.delete(id)));
    },
    getJob(id) {
      return tx("jobs", "readonly").then((os) => reqToPromise(os.get(id)));
    },
    /** Belirli hesabın belirli tarihteki işleri. */
    getJobsByDate(accountId, date) {
      return getAllByIndex("jobs", "acc_date", [accountId, date]);
    },

    // ---- Raporlar ----
    addReport(rep) {
      return tx("reports", "readwrite").then((os) => reqToPromise(os.put(rep)));
    },
    getReportByDate(accountId, date) {
      return getAllByIndex("reports", "acc_date", [accountId, date])
        .then((list) => list[0] || null);
    },
    getReports(accountId) {
      return getAllByIndex("reports", "accountId", accountId);
    },
  };

  global.DB = DB;
})(window);
