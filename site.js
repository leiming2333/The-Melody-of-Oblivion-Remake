const page = document.documentElement;
const body = document.body;
const header = document.querySelector("#site-header");
const navigation = document.querySelector("#site-nav");
const menuButton = document.querySelector("#menu-button");
const languageButton = document.querySelector("#language-button");
const downloadButton = document.querySelector("#download-button");
const sponsorCard = document.querySelector("#sponsor-card");
const sponsorClose = document.querySelector("#sponsor-close");
const toast = document.querySelector("#toast");
const slides = [...document.querySelectorAll(".backdrop-slide")];
const launcherSceneSlides = [...document.querySelectorAll(".launcher-scene-slide")];
const launcherSceneIndicators = [...document.querySelectorAll(".mock-scene-switcher i")];
const sceneButtons = [...document.querySelectorAll("[data-scene-target]")];
const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
const sceneRotationInterval = 6000;

const translations = {
  en: {
    "meta.title": "Melody Launcher",
    "meta.description":
      "Melody Launcher — a lightweight, fast, and modern Minecraft launcher rebuilt from the ground up.",
    "a11y.skip": "Skip to main content",
    "brand.name": "Melody Launcher",
    "nav.vision": "Why rebuild",
    "nav.features": "Capabilities",
    "nav.roadmap": "Roadmap",
    "nav.download": "Get the launcher",
    "header.preview": "Preview in development",
    "hero.eyebrow": "Retuning the way into the block world",
    "hero.title": "Leave the waiting to the launcher.<br />Keep the adventure for yourself.",
    "hero.lead":
      "Melody is a Minecraft launcher rebuilt from zero. Faster downloads, clearer version management, and safer accounts all live inside one quiet, compact window.",
    "hero.primary": "Get for Windows",
    "hero.primarySub": "0.1.0 Preview · Coming soon",
    "hero.secondary": "See what it can do",
    "hero.meta1": "download threads",
    "hero.meta2": "loader families",
    "hero.meta3": "account modes",
    "mock.account": "Game account",
    "mock.accountEmpty": "No account added",
    "mock.manage": "Manage",
    "mock.selected": "Selected 1.21.5",
    "mock.launch": "Launch game",
    "mock.launchHint": "Ready for the block world",
    "mock.switchVersion": "Switch version",
    "mock.versionCount": "16 versions",
    "mock.settings": "Launch settings",
    "mock.gameList": "Game list",
    "mock.openFolder": "Open folder",
    "chip.speed": "Live download speed",
    "chip.java": "Runtime",
    "scene.label": "Scene",
    "sponsor.tag": "Advertisement · Partner promotion",
    "sponsor.title": "Want a server to play with friends?",
    "sponsor.body":
      "Godlike high-performance Minecraft hosting — one-click modpack deployment, free DDoS protection, and 24/7 uptime.",
    "sponsor.cta": "⚡ Explore game server hosting",
    "vision.title": "Not a refresh. A new beginning.",
    "vision.lead":
      "We kept the familiar name, but none of the old baggage. Downloads, accounts, versions, Java, and modpacks are redesigned around today's expectations.",
    "vision.item1Title": "Less interruption",
    "vision.item1Body": "No unrelated entry points. Launching the game always stays in focus.",
    "vision.item2Title": "More certainty",
    "vision.item2Body": "Downloads, version checks, and Java matching always expose clear status.",
    "vision.item3Title": "Complexity stays inside",
    "vision.item3Body": "Choose a version; the launch core handles everything that follows.",
    "features.title": "Every capability gets you into the game sooner.",
    "features.subtitle": "No decorative feature list — only the problems a launcher genuinely needs to solve.",
    "features.speedTitle": "Multi-source parallel downloads",
    "features.speedBody":
      "Official and mirror sources are benchmarked automatically. Large files are segmented, and sustained slowdowns trigger source failover.",
    "features.versionTitle": "Only installed games",
    "features.versionBody":
      "The launch list shows only complete local versions, so switching stays direct and remote catalog noise stays out of the way.",
    "features.accountTitle": "Account and skin sync",
    "features.accountBody":
      "Offline and Microsoft accounts live side by side. Avatars follow the active skin while tokens remain in secure system storage.",
    "features.loaderTitle": "One-stop loader setup",
    "features.loaderBody":
      "Fabric, Forge, and NeoForge share the same version picker and progress flow — no separate installers to hunt down.",
    "features.packTitle": "Drop in a modpack",
    "features.packBody":
      "Modrinth and CurseForge packs are recognized automatically and installed into clean, isolated instances.",
    "features.javaTitle": "Automatic Java matching",
    "features.javaBody":
      "Your manually selected runtime is tried first. If it does not match, the launcher prepares the verified environment the game needs.",
    "performance.title": "Visible speed, built on invisible details.",
    "performance.body":
      "From source probing and cancellable tasks to SHA-1 integrity checks, every download step can be understood, stopped, and verified.",
    "performance.point1": "HTTP Range segmentation for large files",
    "performance.point2": "Automatic fallback from failing routes",
    "performance.point3": "Incomplete installs never enter the game list",
    "performance.downloadTitle": "Download game version",
    "performance.versionLabel": "Game version",
    "performance.sourceLabel": "Download route",
    "performance.sourceValue": "Auto benchmark · 32 threads",
    "performance.taskLabel": "Downloading Minecraft 1.21.5",
    "performance.fileLabel": "Current file",
    "performance.etaLabel": "Time remaining",
    "performance.etaValue": "About 12 seconds",
    "performance.cancel": "Cancel download",
    "performance.background": "Run in background",
    "roadmap.title": "The rebuild is happening now.",
    "roadmap.subtitle": "Stabilize the foundation first, then make every launch feel lighter.",
    "roadmap.phase1Title": "Launch core",
    "roadmap.phase1Body": "Version inheritance, arguments, native extraction, and process status.",
    "roadmap.phase2Title": "Accounts and downloads",
    "roadmap.phase2Body": "Microsoft sign-in, multi-source downloads, integrity checks, and background tasks.",
    "roadmap.phase3Title": "Modpacks and experience polish",
    "roadmap.phase3Body": "Improving Modrinth and CurseForge instances, plus clearer failure states.",
    "roadmap.phase4Title": "First public preview",
    "roadmap.phase4Body": "Package the Windows installer and open public downloads.",
    "roadmap.complete": "Complete",
    "roadmap.active": "In progress",
    "roadmap.planned": "Planned",
    "download.title": "The next melody starts soon.",
    "download.body":
      "The first public Windows preview is still being polished. Once the installer is ready, this will be the only official download entry.",
    "download.system": "System",
    "download.arch": "Architecture",
    "download.version": "Version",
    "download.button": "Installer in production",
    "download.buttonSub": "Downloads will open here",
    "download.note": "Unofficial project. Not affiliated with Mojang Studios or Microsoft.",
    "footer.slogan": "Hear the way back into the block world again.",
    "footer.backTop": "Back to top ↑",
    "toast.preview": "The preview installer is not published yet. It will be available here when ready.",
    "menu.open": "Open navigation menu",
    "menu.close": "Close navigation menu",
  },
};

const chinese = {};
document.querySelectorAll("[data-i18n]").forEach((element) => {
  const key = element.dataset.i18n;
  if (!(key in chinese)) chinese[key] = element.innerHTML;
});
chinese["meta.title"] = document.title;
chinese["meta.description"] = document.querySelector('meta[name="description"]').content;
chinese["toast.preview"] = "预览版安装包暂未发布，完成后会在这里提供下载。";
chinese["menu.open"] = "打开导航菜单";
chinese["menu.close"] = "关闭导航菜单";

let currentLanguage = "zh";
let currentScene = 0;
let sceneTimer;
let toastTimer;

function readStoredLanguage() {
  try {
    return window.localStorage.getItem("melody-site-language");
  } catch {
    return null;
  }
}

function storeLanguage(language) {
  try {
    window.localStorage.setItem("melody-site-language", language);
  } catch {}
}

function sponsorDismissed() {
  try {
    return window.sessionStorage.getItem("melody-sponsor-dismissed") === "1";
  } catch {
    return false;
  }
}

function languageDictionary(language = currentLanguage) {
  return language === "en" ? translations.en : chinese;
}

function applyLanguage(language) {
  currentLanguage = language === "en" ? "en" : "zh";
  const dictionary = languageDictionary();

  document.querySelectorAll("[data-i18n]").forEach((element) => {
    const translation = dictionary[element.dataset.i18n];
    if (translation != null) element.innerHTML = translation;
  });

  page.lang = currentLanguage === "en" ? "en" : "zh-CN";
  document.title = dictionary["meta.title"];
  document.querySelector('meta[name="description"]').content = dictionary["meta.description"];
  languageButton.textContent = currentLanguage === "en" ? "中文" : "EN";
  languageButton.setAttribute(
    "aria-label",
    currentLanguage === "en" ? "切换为中文" : "Switch language",
  );
  updateMenuLabel();
  storeLanguage(currentLanguage);
}

function updateMenuLabel() {
  const isOpen = body.classList.contains("menu-open");
  const dictionary = languageDictionary();
  menuButton.setAttribute("aria-expanded", String(isOpen));
  menuButton.setAttribute("aria-label", dictionary[isOpen ? "menu.close" : "menu.open"]);
}

function closeMenu() {
  body.classList.remove("menu-open");
  updateMenuLabel();
}

function toggleMenu() {
  body.classList.toggle("menu-open");
  updateMenuLabel();
}

function availableSceneIndices() {
  return slides
    .map((slide, index) => (slide.dataset.sceneState === "ready" ? index : -1))
    .filter((index) => index >= 0);
}

function resolveAvailableScene(index) {
  if (slides.length === 0) return -1;
  const normalizedIndex = (index + slides.length) % slides.length;
  for (let offset = 0; offset < slides.length; offset += 1) {
    const candidate = (normalizedIndex + offset) % slides.length;
    if (slides[candidate].dataset.sceneState === "ready") return candidate;
  }
  return -1;
}

function showScene(index) {
  const nextScene = resolveAvailableScene(index);
  if (nextScene < 0) return;
  currentScene = nextScene;
  slides.forEach((slide, slideIndex) => {
    slide.classList.toggle("is-active", slideIndex === currentScene);
  });
  launcherSceneSlides.forEach((slide, slideIndex) => {
    slide.classList.toggle("is-active", slideIndex === currentScene);
  });
  launcherSceneIndicators.forEach((indicator, indicatorIndex) => {
    indicator.classList.toggle("is-active", indicatorIndex === currentScene);
  });
  sceneButtons.forEach((button, buttonIndex) => {
    const isActive = buttonIndex === currentScene;
    button.classList.toggle("is-active", isActive);
    button.setAttribute("aria-pressed", String(isActive));
  });
}

function startSceneRotation() {
  window.clearInterval(sceneTimer);
  if (document.hidden || availableSceneIndices().length < 2) return;
  sceneTimer = window.setInterval(() => showScene(currentScene + 1), sceneRotationInterval);
}

function updateSceneState(slide, index) {
  const isReady = slide.complete && slide.naturalWidth > 0;
  slide.dataset.sceneState = isReady ? "ready" : "error";
  slide.classList.toggle("is-unavailable", !isReady);

  const button = sceneButtons[index];
  if (button) {
    button.disabled = !isReady;
    button.setAttribute("aria-disabled", String(!isReady));
  }

  if (isReady) {
    showScene(slides[currentScene]?.dataset.sceneState === "ready" ? currentScene : index);
  } else if (slide.classList.contains("is-active")) {
    slide.classList.remove("is-active");
    showScene(index + 1);
  }
  startSceneRotation();
}

function initializeScenes() {
  slides.forEach((slide, index) => {
    slide.dataset.sceneState = "loading";
    slide.addEventListener("load", () => updateSceneState(slide, index));
    slide.addEventListener("error", () => updateSceneState(slide, index));
    if (slide.complete) updateSceneState(slide, index);
  });
}

function showToast(message) {
  window.clearTimeout(toastTimer);
  toast.textContent = message;
  toast.classList.add("is-visible");
  toastTimer = window.setTimeout(() => toast.classList.remove("is-visible"), 3600);
}

function updateHeader() {
  header.classList.toggle("is-scrolled", window.scrollY > 18);
}

function revealPage() {
  const revealElements = [...document.querySelectorAll(".reveal")];
  if (reducedMotion.matches || !("IntersectionObserver" in window)) {
    revealElements.forEach((element) => element.classList.add("is-visible"));
    return;
  }

  const observer = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        const delay = Number(entry.target.dataset.revealDelay || 0);
        window.setTimeout(() => entry.target.classList.add("is-visible"), delay);
        observer.unobserve(entry.target);
      });
    },
    { threshold: 0.12, rootMargin: "0px 0px -40px" },
  );

  revealElements.forEach((element) => observer.observe(element));
}

menuButton.addEventListener("click", toggleMenu);
navigation.querySelectorAll("a").forEach((link) => link.addEventListener("click", closeMenu));

languageButton.addEventListener("click", () => {
  applyLanguage(currentLanguage === "en" ? "zh" : "en");
});

if (sponsorDismissed()) sponsorCard.classList.add("is-hidden");

sponsorClose.addEventListener("click", () => {
  sponsorCard.classList.add("is-hidden");
  try {
    window.sessionStorage.setItem("melody-sponsor-dismissed", "1");
  } catch {}
});

sceneButtons.forEach((button) => {
  button.addEventListener("click", () => {
    showScene(Number(button.dataset.sceneTarget));
    startSceneRotation();
  });
});

downloadButton.addEventListener("click", () => {
  showToast(languageDictionary()["toast.preview"]);
});

window.addEventListener("scroll", updateHeader, { passive: true });
window.addEventListener("resize", () => {
  if (window.innerWidth > 780) closeMenu();
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") closeMenu();
});
reducedMotion.addEventListener?.("change", startSceneRotation);
document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    window.clearInterval(sceneTimer);
    return;
  }
  showScene(currentScene);
  startSceneRotation();
});

document.querySelector("#current-year").textContent = String(new Date().getFullYear());
initializeScenes();
showScene(0);
startSceneRotation();
updateHeader();
revealPage();

const storedLanguage = readStoredLanguage();
const preferredLanguage = storedLanguage ||
  (navigator.language?.toLowerCase().startsWith("zh") ? "zh" : "en");
applyLanguage(preferredLanguage);
