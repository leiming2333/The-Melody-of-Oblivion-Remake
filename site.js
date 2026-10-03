const translations = {
  skip: "Skip to main content",
  brand: "Melody Launcher",
  "nav.launcher": "Launcher",
  "nav.features": "Features",
  "nav.download": "Download",
  "nav.get": "Get the launcher <span aria-hidden=\"true\">↗</span>",
  "hero.kicker": "Minecraft launcher · Windows / macOS / Linux",
  "hero.title": "Melody Launcher",
  "hero.subtitle": "Open the game. Pick up where you left off.",
  "hero.description": "Versions, accounts, and mod loaders live in one place. Choose the world you want to play; the launcher handles the setup.",
  "hero.download": "Download launcher",
  "hero.preview": "See the launcher",
  "hero.release": "Choose a build here and download over HTTPS",
  "intro.title": "Find the version you want<br>at a glance.",
  "intro.body": "The launch screen shows games you've actually installed. Switch versions or accounts and open settings without digging through a download catalog.",
  "fact.accounts": "account types",
  "fact.threads": "download threads",
  "fact.platforms": "desktop platforms",
  "intro.caption": "Actual launcher interface",
  "features.title": "Fewer steps between install and play.",
  "features.lead": "The things you use often stay close. Download and installation progress stay visible.",
  "feature.download.title": "Downloads that keep moving",
  "feature.download.body": "Official and mirror sources are tested automatically. Large files download in parts, and slow or failed routes can be switched.",
  "feature.accounts.title": "Switch accounts when you need to",
  "feature.accounts.body": "Use offline or LittleSkin sign-in. Your avatar updates with the current account.",
  "feature.loaders.title": "Set up mods in one place",
  "feature.loaders.body": "Install Fabric, Forge, and NeoForge for the version you choose, or import Modrinth and CurseForge modpacks.",
  "feature.java.title": "Java handled for you",
  "feature.java.body": "The launcher checks your selected Java first. If it doesn't fit, it prepares a verified runtime.",
  "scene.text": "Your world is waiting.<br>Let's go.",
  "download.title": "Your next adventure starts here.",
  "download.body": "Choose your system and architecture to get the latest build.",
  "download.platform": "Choose system",
  "download.source": "Download source (switch if a download fails)",
  "download.official": "GitHub official",
  "download.button": "View releases",
  "download.note": "Unofficial project. Not affiliated with Mojang Studios or Microsoft.",
  "partner.tag": "Advertisement · Partner promotion",
  "partner.title": "Want a server for your friends?",
  "partner.body": "Godlike high-performance Minecraft hosting — one-click modpack deployment, free DDoS protection, and 24/7 uptime.",
  "partner.cta": "⚡ Explore game server hosting",
  "footer.top": "Back to top ↑"
};

const languageButton = document.querySelector("#language-button");
const menuButton = document.querySelector("#menu-button");
const navigation = document.querySelector("#site-nav");
const partnerWindow = document.querySelector("#partner-window");
const downloadPlatform = document.querySelector("#download-platform");
const downloadSource = document.querySelector("#download-source");
const downloadButton = document.querySelector("#download-button");
const downloadStatus = document.querySelector("#download-status");
const releasesUrl = "https://github.com/leiming2333/The-Melody-of-Oblivion-Remake/releases";
const releaseApiUrl = "/api/latest-release";
let latestRelease = null;
let releaseLoadFailed = false;
const originalCopy = Object.fromEntries(
  [...document.querySelectorAll("[data-i18n]")].map((element) => [element.dataset.i18n, element.innerHTML])
);

function setLanguage(language) {
  const english = language === "en";
  document.documentElement.lang = english ? "en" : "zh-CN";
  document.title = english ? "Melody Launcher" : "忘却的旋律启动器";
  document.querySelector('meta[name="description"]').content = english
    ? "Melody Launcher brings Minecraft versions, accounts, mod loaders, and modpacks together."
    : "忘却的旋律是一款 Minecraft 启动器。管理游戏版本、账户、加载器和整合包，准备好就直接开玩。";
  document.querySelectorAll("[data-i18n]").forEach((element) => {
    element.innerHTML = (english ? translations : originalCopy)[element.dataset.i18n] ?? element.innerHTML;
  });
  languageButton.textContent = english ? "中文" : "EN";
  languageButton.setAttribute("aria-label", english ? "切换为中文" : "Switch language");
  document.querySelector(".launcher-figure img").alt = english
    ? "Screenshot of the Melody Launcher interface"
    : "忘却的旋律启动器界面截图";
  updateDownloadLink();
  try { localStorage.setItem("melody-site-language", language); } catch {}
}

function detectPlatform() {
  const platform = (navigator.userAgentData?.platform || navigator.platform || "").toLowerCase();
  if (platform.includes("win")) return "Windows-x64";
  if (platform.includes("mac")) return "macOS-arm64";
  if (platform.includes("linux")) return "Linux-x64";
  return "Windows-x64";
}

function updateDownloadLink() {
  const english = document.documentElement.lang === "en";
  const target = downloadPlatform.value;
  const extension = target.startsWith("Windows") ? ".exe" : target.startsWith("macOS") ? ".zip" : ".AppImage";
  const asset = latestRelease?.assets?.find((item) =>
    item.name.endsWith(`-${target}${extension}`) && item.browser_download_url?.startsWith("https://github.com/")
  );

  downloadButton.href = asset
    ? `/api/download?tag=${encodeURIComponent(latestRelease.tag_name)}&asset=${encodeURIComponent(asset.name)}&source=${encodeURIComponent(downloadSource.value)}`
    : releasesUrl;
  downloadButton.querySelector("#download-button-label").textContent = asset
    ? (english ? "Download installer" : "下载安装包")
    : (english ? "View releases" : "查看发行版本");
  downloadStatus.textContent = asset
    ? `${latestRelease.tag_name} · ${(asset.size / 1048576).toFixed(1)} MB · HTTPS`
    : releaseLoadFailed
      ? (english ? "Could not load the download list. Open Releases to choose a file." : "暂时无法读取安装包列表，可前往发行页面选择。")
      : latestRelease
        ? (english ? "No build for this platform in the latest release." : "最新版本暂无该平台的安装包。")
        : (english ? "Checking the latest release…" : "正在查询最新版本…");
}

async function loadLatestRelease() {
  try {
    const response = await fetch(releaseApiUrl, { headers: { Accept: "application/vnd.github+json" } });
    if (!response.ok) throw new Error(`GitHub API: ${response.status}`);
    latestRelease = await response.json();
  } catch {
    releaseLoadFailed = true;
  }
  updateDownloadLink();
}

function closeMenu() {
  document.body.classList.remove("menu-open");
  menuButton.setAttribute("aria-expanded", "false");
  menuButton.setAttribute("aria-label", document.documentElement.lang === "en" ? "Open navigation menu" : "打开导航菜单");
}

languageButton.addEventListener("click", () => setLanguage(document.documentElement.lang === "en" ? "zh" : "en"));
menuButton.addEventListener("click", () => {
  const open = document.body.classList.toggle("menu-open");
  menuButton.setAttribute("aria-expanded", String(open));
  menuButton.setAttribute("aria-label", document.documentElement.lang === "en"
    ? (open ? "Close navigation menu" : "Open navigation menu")
    : (open ? "关闭导航菜单" : "打开导航菜单"));
});
navigation.querySelectorAll("a").forEach((link) => link.addEventListener("click", closeMenu));
window.addEventListener("resize", () => { if (window.innerWidth > 700) closeMenu(); });
document.addEventListener("keydown", (event) => { if (event.key === "Escape") closeMenu(); });

try {
  if (sessionStorage.getItem("melody-partner-window-dismissed") === "1") partnerWindow.classList.add("is-hidden");
} catch {}
document.querySelector("#partner-window-close").addEventListener("click", () => {
  partnerWindow.classList.add("is-hidden");
  try { sessionStorage.setItem("melody-partner-window-dismissed", "1"); } catch {}
});

document.querySelector("#current-year").textContent = String(new Date().getFullYear());
downloadPlatform.value = detectPlatform();
downloadPlatform.addEventListener("change", updateDownloadLink);
downloadSource.addEventListener("change", updateDownloadLink);
let savedLanguage;
try { savedLanguage = localStorage.getItem("melody-site-language"); } catch {}
setLanguage(savedLanguage || (navigator.language?.toLowerCase().startsWith("zh") ? "zh" : "en"));
loadLatestRelease();
