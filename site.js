const slides = Array.from(document.querySelectorAll(".background-slide"));
const dots = Array.from(document.querySelectorAll(".wallpaper-dot"));

let activeIndex = 0;
let rotateTimer = null;

function showSlide(index) {
  activeIndex = index;
  slides.forEach((slide, i) => slide.classList.toggle("is-active", i === index));
  dots.forEach((dot, i) => {
    dot.classList.toggle("is-active", i === index);
    dot.setAttribute("aria-pressed", String(i === index));
  });
}

function startRotation() {
  clearInterval(rotateTimer);
  rotateTimer = setInterval(() => {
    showSlide((activeIndex + 1) % slides.length);
  }, 9000);
}

dots.forEach((dot) => {
  dot.addEventListener("click", () => {
    showSlide(Number(dot.dataset.wallpaperIndex));
    startRotation();
  });
});

startRotation();

const translations = {
  en: {
    "meta.title": "The-Melody-of-Oblivion-Remake",
    "meta.description":
      "Official website of The-Melody-of-Oblivion-Remake — a modern Minecraft launcher rebuilt from the ground up.",
    "brand.name": "The Melody of Oblivion",
    "nav.remake": "Remake",
    "nav.features": "Features",
    "nav.tech": "Tech",
    "nav.download": "Download",
    "hero.title": "A remake of The Melody of Oblivion launcher",
    "hero.lead":
      "We tore the old launcher down and rebuilt it — a faster download engine, a cleaner interface, smarter version management. All for one thing: getting you back to the block world sooner.",
    "hero.cta": "Get the Launcher",
    "hero.ghost": "About the remake",
    "stats.downloads": "concurrent downloads",
    "stats.loaders": "loaders supported",
    "stats.accounts": "account types",
    "stats.java": "system Java required",
    "remake.title": "Why a remake",
    "remake.card1.title": "The old regret",
    "remake.card1.body":
      "The Melody of Oblivion was the first launcher for many veteran players. Sadly its author stopped updating it, it slowly vanished as versions moved on, and players lost a handy companion.",
    "remake.card2.title": "Remake principles",
    "remake.card2.body":
      "Rebuilt from scratch with Electron. A compact window, scene-based backgrounds, and every button in service of launching the game.",
    "remake.card3.title": "Honoring a classic",
    "remake.card3.body":
      "Reviving this name is a tribute to that era — bringing back the simple joy of one-click entry into the block world, with today's technology.",
    "features.title": "Core features",
    "features.card1.title": "Version management",
    "features.card1.body":
      "Connects to BMCLAPI and Mojang's official manifest, automatically picks the faster source, and shows local versions instantly.",
    "features.card2.title": "High-speed downloads",
    "features.card2.body":
      "Up to 32 concurrent connections, automatic chunked parallel downloads for large files, SHA-1 integrity checks, and automatic source failover.",
    "features.card3.title": "Multiple loaders",
    "features.card3.body":
      "Vanilla, Fabric, Forge, and NeoForge installed in one place — pick a version and let the launcher handle the rest.",
    "features.card4.title": "Modpack install",
    "features.card4.body":
      "Drop Modrinth .mrpack or CurseForge .zip files straight into the window to install them, with fully isolated instance directories.",
    "features.card5.title": "Account management",
    "features.card5.body":
      "Offline accounts and Microsoft login side by side, tokens encrypted at the system level, and automatic refresh before launch.",
    "features.card6.title": "Managed Java",
    "features.card6.body":
      "Strictly matches the Java version each game requires, downloading a verified Temurin JRE when missing — without touching your system.",
    "tech.title": "Under the hood",
    "tech.item1.title": "Electron",
    "tech.item1.body":
      "Three-layer isolation across main process / preload bridge / renderer — tokens never reach the page",
    "tech.item2.title": "Launch core",
    "tech.item2.body":
      "Version inheritance, rule filtering, native library extraction, exit-status reporting and temp file cleanup",
    "tech.item3.title": "Downloader",
    "tech.item3.body":
      "Dual-source parallel probing, HTTP Range chunking, cancellable tasks and temp segment cleanup",
    "tech.item4.title": "Account system",
    "tech.item4.body":
      "Full device-code authorization chain: Microsoft → Xbox → XSTS → Minecraft Services",
    "download.title": "Ready to return to the melody?",
    "download.lead":
      "The remake is currently in development. Downloads will be available here once the official release ships.",
    "download.cta": "Coming soon",
    "download.ctaSub": "Launcher 0.1.0 · In development",
    "footer.disclaimer": "Unofficial project, not affiliated with Mojang / Microsoft",
    "footer.scene": "Scene",
  },
};

const zhTexts = {};
document.querySelectorAll("[data-i18n]").forEach((el) => {
  const key = el.dataset.i18n;
  if (!(key in zhTexts)) zhTexts[key] = el.textContent;
});
zhTexts["meta.title"] = document.title;
zhTexts["meta.description"] = document
  .querySelector('meta[name="description"]')
  .getAttribute("content");

const langToggle = document.getElementById("lang-toggle");

// localStorage throws in sandboxed iframes (e.g. masked domain forwarding), so guard every access
function readStoredLang() {
  try {
    return localStorage.getItem("site-lang");
  } catch {
    return null;
  }
}

function storeLang(lang) {
  try {
    localStorage.setItem("site-lang", lang);
  } catch {}
}

let currentLang = "zh";

function applyLanguage(lang) {
  currentLang = lang;
  const dict = lang === "en" ? translations.en : zhTexts;
  document.querySelectorAll("[data-i18n]").forEach((el) => {
    const text = dict[el.dataset.i18n];
    if (text != null) el.textContent = text;
  });
  document.documentElement.lang = lang === "en" ? "en" : "zh-CN";
  document.title = dict["meta.title"];
  document
    .querySelector('meta[name="description"]')
    .setAttribute("content", dict["meta.description"]);
  langToggle.textContent = lang === "en" ? "中文" : "EN";
  storeLang(lang);
}

langToggle.addEventListener("click", () => {
  applyLanguage(currentLang === "en" ? "zh" : "en");
});

const savedLang =
  readStoredLang() ||
  (navigator.language && navigator.language.toLowerCase().startsWith("zh") ? "zh" : "en");
applyLanguage(savedLang);
