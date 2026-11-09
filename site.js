const translations = {
  skip: "Skip to main content",
  brand: "Melody Launcher",
  "nav.launcher": "Launcher",
  "nav.features": "Features",
  "nav.download": "Download",
  "nav.guide": "Guide",
  "nav.get": "Get the launcher <span aria-hidden=\"true\">↗</span>",
  "hero.kicker": "Minecraft launcher · Windows / macOS / Linux",
  "hero.title": "Melody Launcher",
  "hero.subtitle": "Your block world starts here.",
  "hero.description": "A desert lake greets you on launch. Manage accounts, install versions, adjust Java and memory, then start your game.",
  "hero.download": "Download launcher",
  "hero.release": "Choose a build here and download over HTTPS",
  "intro.title": "Your familiar accounts,<br>all in one place.",
  "intro.body": "Manage offline and LittleSkin accounts at the bottom left. Switch installed versions and open launch settings on the right, or change your wallpaper in settings.",
  "fact.accounts": "account types",
  "fact.threads": "download threads",
  "fact.platforms": "desktop platforms",
  "features.title": "Fewer steps between install and play.",
  "features.lead": "The things you use often stay close. Download and installation progress stay visible.",
  "feature.download.title": "Downloads that keep moving",
  "feature.download.body": "Official and mirror sources are tested automatically. Large files download in parts, and slow or failed routes can be switched.",
  "feature.accounts.title": "Switch accounts when you need to",
  "feature.accounts.body": "Use offline or LittleSkin sign-in. Your avatar updates with the current account.",
  "feature.loaders.title": "Set up mods in one place",
  "feature.loaders.body": "Install Fabric, Forge, NeoForge, or Quilt for the version you choose, or import Modrinth and CurseForge modpacks.",
  "feature.java.title": "Java handled for you",
  "feature.java.body": "Save your Java paths and launch with a compatible version. If the required runtime is missing, download it in settings.",
  "guide.title": "Three steps to your first game.",
  "guide.lead": "Download and open the launcher, then follow these steps to get ready.",
  "guide.account.title": "Add a game account",
  "guide.account.body": "Click the account panel at the bottom left to add an offline or LittleSkin account.",
  "guide.version.title": "Install a game version",
  "guide.version.body": "Open Switch version and choose a Minecraft version. Select a matching loader if you want mods. Once the download finishes, the game appears in the home screen list.",
  "guide.play.title": "Select your game and launch",
  "guide.play.body": "Choose an installed game from the home screen list and click Launch game. If Java is missing, download the required version in Launch settings and try again.",
  "guide.faq.title": "Common questions",
  "guide.java.question": "How do I switch Java versions?",
  "guide.java.answer": "Add Java executable paths in Launch settings and save them to switch from the list. Java 8, 16, 17, 21, and 25 are available to download. Launching prefers your selected path when compatible, then tries other saved, system, or downloaded runtimes.",
  "guide.import.question": "How do I import mods and modpacks?",
  "guide.import.answer": "Select a game, then drop .jar files into the launcher window to import mods, including multiple files at once. Drop one .zip or .mrpack separately and confirm the detected modpack before installation. Mods must match the game and loader; some CurseForge files may not be available for direct download.",
  "guide.data.question": "Where are my game files?",
  "guide.data.answer": "Games use the .minecraft folder next to the launcher by default. Select a game and click Open directory to access its data. Instance isolation is enabled by default, keeping mods, saves, and configuration separate. Back up the original game folder before moving the launcher or changing directories.",
  "guide.scene.question": "Where do I change backgrounds and download sources?",
  "guide.scene.answer": "Choose and save a Background scene in Launch settings; scenes do not rotate automatically. Game download sources are also in settings. If this website's launcher download fails, try the GitHub or cloud download links below.",
  "scene.text": "Your world is waiting.<br>Let's go.",
  "download.title": "Your next adventure starts here.",
  "download.body": "Choose your system and architecture to get the latest build.",
  "download.github": "GitHub repository ↗",
  "download.license": "GNU GPL-3.0 license",
  "download.latest": "Latest release",
  "download.changelog": "Latest update",
  "download.changelogLoading": "Loading release notes…",
  "download.changelogAll": "View all releases ↗",
  "download.platform": "Choose system",
  "download.button": "Download launcher",
  "download.browser": "View download progress in your browser's downloads list.",
  "download.alternative": "GitHub original download",
  "download.cloud": "Cloud downloads",
  "download.baidu": "Baidu Netdisk ↗",
  "download.lanzou": "Lanzou Cloud ↗",
  "download.code": "Access code: ",
  "download.password": "Password: ",
  "download.note": "This is an unofficial launcher and is not affiliated with Mojang Studios or Microsoft. Back up your Minecraft data before testing. Download from this site or GitHub Releases to avoid third-party modified builds.",
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
const downloadButton = document.querySelector("#download-button");
const downloadAlternative = document.querySelector("#download-alternative");
const downloadStatus = document.querySelector("#download-status");
const changelogDetails = document.querySelector("#changelog-details");
const changelogList = document.querySelector("#changelog-list");
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

function selectedDownloadAsset() {
  const target = downloadPlatform.value;
  const extension = target.startsWith("Windows") ? ".exe" : target.startsWith("macOS") ? ".zip" : ".AppImage";
  if (!/^v\d+\.\d+\.\d+$/.test(latestRelease?.tag_name ?? "")
    || latestRelease.draft === true || latestRelease.prerelease === true
    || !Array.isArray(latestRelease.assets)) return null;
  return latestRelease.assets.find((item) =>
    item?.name === `The-Melody-of-Oblivion-Remake-${target}${extension}`
  );
}

function downloadTarget(asset) {
  if (!asset) return null;
  const githubUrl = `https://github.com/leiming2333/The-Melody-of-Oblivion-Remake/releases/download/${encodeURIComponent(latestRelease.tag_name)}/${encodeURIComponent(asset.name)}`;
  const verifiedMetadata = Number.isSafeInteger(asset.size) && asset.size > 0
    && /^sha256:[a-f\d]{64}$/i.test(asset.digest ?? "");
  if (verifiedMetadata) {
    const objectStorageUrl = `https://downloads.melodyoblivion.xyz/releases/${encodeURIComponent(latestRelease.tag_name)}/${encodeURIComponent(asset.name)}`;
    if (asset.object_storage_verified === true && asset.object_storage_download_url === objectStorageUrl) {
      return { url: objectStorageUrl, githubUrl, objectStorage: true };
    }
    try {
      const url = new URL(asset.browser_download_url);
      if (url.protocol === "https:" && url.hostname.endsWith(".public.blob.vercel-storage.com")
        && !url.username && !url.password && !url.port && !url.search && !url.hash) {
        return { url: url.href, githubUrl, objectStorage: true };
      }
    } catch {}
  }
  return { url: githubUrl, githubUrl, objectStorage: false };
}

function updateDownloadLink() {
  const english = document.documentElement.lang === "en";
  document.querySelector("#latest-version").textContent = latestRelease?.tag_name ?? "—";
  const asset = selectedDownloadAsset();
  const target = downloadTarget(asset);
  downloadButton.querySelector("#download-button-label").textContent = target && !target.objectStorage
    ? (english ? "Download from GitHub" : "从 GitHub 下载")
    : (english ? "Download launcher" : "下载启动器");
  downloadButton.setAttribute("aria-disabled", String(!target));
  if (target) {
    downloadButton.href = target.url;
    downloadButton.download = asset.name;
    downloadButton.removeAttribute("tabindex");
    downloadAlternative.href = target.githubUrl;
    downloadAlternative.download = asset.name;
  } else {
    downloadButton.removeAttribute("href");
    downloadButton.removeAttribute("download");
    downloadButton.setAttribute("tabindex", "-1");
    downloadAlternative.removeAttribute("href");
    downloadAlternative.removeAttribute("download");
  }
  downloadAlternative.hidden = !target?.objectStorage;
  const size = Number.isSafeInteger(asset?.size) && asset.size > 0
    ? ` · ${(asset.size / 1048576).toFixed(1)} MB` : "";
  downloadStatus.textContent = target
    ? `${latestRelease.tag_name}${size} · ${target.objectStorage ? (english ? "Object storage" : "对象存储") : "GitHub"} · HTTPS${target.objectStorage ? "" : (english ? " · Object storage is not ready" : " · 对象存储尚未就绪")}`
    : releaseLoadFailed
      ? (english ? "Could not load the download list. Use GitHub Releases or the cloud links below." : "暂时无法读取安装包列表，请使用 GitHub Releases 或下方网盘下载。")
      : latestRelease
        ? (english ? "No build for this platform in the latest release." : "最新版本暂无该平台的安装包。")
        : (english ? "Checking the latest release…" : "正在查询最新版本…");
}

async function loadLatestRelease() {
  try {
    const response = await fetch(releaseApiUrl, { headers: { Accept: "application/vnd.github+json" } });
    if (!response.ok) throw new Error(`GitHub API: ${response.status}`);
    const release = await response.json();
    if (!/^v\d+\.\d+\.\d+$/.test(release?.tag_name ?? "") || !Array.isArray(release.assets)
      || release.draft === true || release.prerelease === true) throw new Error("Invalid release metadata");
    latestRelease = release;
    releaseLoadFailed = false;
  } catch {
    latestRelease = null;
    releaseLoadFailed = true;
  }
  updateDownloadLink();
}

async function loadChangelog() {
  try {
    const response = await fetch("/api/releases", { headers: { Accept: "application/vnd.github+json" } });
    if (!response.ok) throw new Error(`GitHub API: ${response.status}`);
    const releases = await response.json();
    changelogList.replaceChildren();
    const release = releases.find((item) => item && typeof item.tag_name === "string");
    if (!release) throw new Error("No releases");
    const item = document.createElement("li");
    const heading = document.createElement("h3");
    heading.textContent = release.tag_name;
    item.append(heading);
    const notes = document.createElement("p");
    notes.textContent = typeof release.body === "string" && release.body.trim()
      ? release.body.trim()
      : (document.documentElement.lang === "en" ? "No release notes." : "此版本没有填写更新说明。");
    item.append(notes);
    changelogList.replaceChildren(item);
  } catch {
    changelogList.replaceChildren();
    const item = document.createElement("li");
    item.textContent = document.documentElement.lang === "en"
      ? "Release notes are temporarily unavailable. Open GitHub Releases to see them."
      : "暂时无法读取更新日志，请前往 GitHub Releases 查看。";
    changelogList.append(item);
  }
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

changelogDetails.addEventListener("toggle", () => {
  if (changelogDetails.open && !changelogDetails.dataset.loaded) {
    changelogDetails.dataset.loaded = "true";
    loadChangelog();
  }
});
if (changelogDetails.open) {
  changelogDetails.dataset.loaded = "true";
  loadChangelog();
}
let savedLanguage;
try { savedLanguage = localStorage.getItem("melody-site-language"); } catch {}
setLanguage(savedLanguage || (navigator.language?.toLowerCase().startsWith("zh") ? "zh" : "en"));
loadLatestRelease();
