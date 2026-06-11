// Web dosyalarını Capacitor'ın kullandığı www/ klasörüne kopyalar.
// Kaynak dosyalar kök dizinde kalır; "npm run sync" çalıştırınca www güncellenir.
const fs = require("fs");
const path = require("path");

const root = __dirname;
const dest = path.join(root, "www");

// APK içine girecek web dosyaları
const files = [
  "index.html",
  "app.js",
  "db.js",
  "style.css",
  "icon.svg",
  "manifest.webmanifest",
];

fs.rmSync(dest, { recursive: true, force: true });
fs.mkdirSync(dest, { recursive: true });

for (const f of files) {
  const src = path.join(root, f);
  if (!fs.existsSync(src)) {
    console.warn("Atlandı (bulunamadı):", f);
    continue;
  }
  fs.copyFileSync(src, path.join(dest, f));
  console.log("Kopyalandı:", f);
}

console.log("www/ klasörü hazır.");
