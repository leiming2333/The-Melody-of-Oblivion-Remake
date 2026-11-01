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
  "guide.scene.answer": "Choose and save a Background scene in Launch settings; scenes do not rotate automatically. Game download sources are also in settings. If the launcher download fails, switch the source in this website's download section and try again.",
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
  "download.source": "Download source (switch if a download fails)",
  "download.auto": "Choose automatically (recommended)",
  "download.blob": "Vercel Blob (Hong Kong)",
  "download.official": "GitHub official",
  "download.button": "View releases",
  "download.alternative": "GitHub original download",
  "download.progress": "Download progress",
  "download.cancel": "Cancel download",
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
const downloadSource = document.querySelector("#download-source");
const downloadButton = document.querySelector("#download-button");
const downloadAlternative = document.querySelector("#download-alternative");
const downloadStatus = document.querySelector("#download-status");
const downloadProgressPanel = document.querySelector("#download-progress-panel");
const downloadProgress = document.querySelector("#download-progress");
const downloadProgressText = document.querySelector("#download-progress-text");
const downloadCancel = document.querySelector("#download-cancel");
const changelogDetails = document.querySelector("#changelog-details");
const changelogList = document.querySelector("#changelog-list");
const releasesUrl = "https://github.com/leiming2333/The-Melody-of-Oblivion-Remake/releases";
const releaseApiUrl = "/api/latest-release";
let latestRelease = null;
let releaseLoadFailed = false;
let websiteDownloadController = null;
let websiteDownloadState = null;
const websiteMirrors = [
  { id: "ghproxy", label: "ghproxy.net", prefix: "https://ghproxy.net/" },
  { id: "ghfast", label: "ghfast.top", prefix: "https://ghfast.top/" },
  { id: "gh-proxy", label: "gh-proxy.com", prefix: "https://gh-proxy.com/" }
];
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

function isBlobDownloadUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname.endsWith(".public.blob.vercel-storage.com");
  } catch {
    return false;
  }
}

function selectedDownloadAsset() {
  const target = downloadPlatform.value;
  const extension = target.startsWith("Windows") ? ".exe" : target.startsWith("macOS") ? ".zip" : ".AppImage";
  return latestRelease?.assets?.find((item) =>
    typeof item.name === "string" && item.name.endsWith(`-${target}${extension}`)
    && /^(?:https:\/\/github\.com\/|https:\/\/.+\.public\.blob\.vercel-storage\.com\/)/.test(item.browser_download_url ?? "")
  );
}

function officialDownloadUrl(asset) {
  return `https://github.com/leiming2333/The-Melody-of-Oblivion-Remake/releases/download/${encodeURIComponent(latestRelease.tag_name)}/${encodeURIComponent(asset.name)}`;
}

function websiteDownloadSources(asset) {
  const githubUrl = officialDownloadUrl(asset);
  const sources = websiteMirrors.map(({ id, label, prefix }) => ({ id, label, url: `${prefix}${githubUrl}` }));
  if (isBlobDownloadUrl(asset.browser_download_url)) {
    sources.unshift({ id: "blob", label: "Vercel Blob", url: asset.browser_download_url });
  }
  const selected = sources.find((source) => source.id === downloadSource.value);
  return selected ? [selected, ...sources.filter((source) => source !== selected)] : sources;
}

function updateDownloadLink() {
  const english = document.documentElement.lang === "en";
  document.querySelector("#latest-version").textContent = latestRelease?.tag_name ?? "—";
  const target = downloadPlatform.value;
  const asset = selectedDownloadAsset();
  const blobAvailable = Boolean(asset && isBlobDownloadUrl(asset.browser_download_url));
  const blobOption = downloadSource.querySelector('option[value="blob"]');
  blobOption.disabled = Boolean(latestRelease) && !blobAvailable;
  blobOption.textContent = blobOption.disabled
    ? (english ? "Vercel Blob (unavailable for this build)" : "Vercel Blob（此安装包不可用）")
    : (english ? translations["download.blob"] : originalCopy["download.blob"]);
  if (asset && !blobAvailable && downloadSource.value === "blob") downloadSource.value = "auto";
  const automatic = downloadSource.value === "auto";
  const directSource = automatic ? (blobAvailable ? "blob" : "official") : downloadSource.value;
  downloadButton.href = asset
    ? directSource === "blob"
      ? asset.browser_download_url
      : `/api/download?tag=${encodeURIComponent(latestRelease.tag_name)}&asset=${encodeURIComponent(asset.name)}&source=${encodeURIComponent(directSource)}`
    : releasesUrl;
  downloadAlternative.hidden = !asset;
  if (asset) {
    downloadAlternative.href = downloadButton.href;
    downloadAlternative.textContent = english ? "Download directly in your browser (fallback)" : "浏览器直接下载（备用）";
    downloadAlternative.setAttribute("aria-label", downloadAlternative.textContent);
  }
  downloadButton.querySelector("#download-button-label").textContent = asset
    ? automatic
      ? (english ? "Download with automatic source selection" : "自动选择线路下载")
      : downloadSource.value === "official"
      ? (english ? "Download from GitHub in your browser" : "GitHub 官方下载（浏览器）")
      : downloadSource.value === "blob"
        ? (english ? "Download from Vercel Blob" : "Vercel Blob 下载")
        : (english ? `Accelerated download (${downloadSource.selectedOptions[0].textContent})` : `国内加速下载（${downloadSource.selectedOptions[0].textContent}）`)
    : (english ? "View releases" : "查看发行版本");
  downloadStatus.textContent = asset
    ? `${latestRelease.tag_name} · ${(asset.size / 1048576).toFixed(1)} MB · ${downloadSource.selectedOptions[0].textContent} · HTTPS${target.startsWith("Windows") && !blobAvailable
      ? (english ? " · Blob is temporarily unavailable" : " · Blob 线路暂不可用") : ""}`
    : releaseLoadFailed
      ? (english ? "Could not load the download list. Open Releases to choose a file." : "暂时无法读取安装包列表，可前往发行页面选择。")
      : latestRelease
        ? (english ? "No build for this platform in the latest release." : "最新版本暂无该平台的安装包。")
        : (english ? "Checking the latest release…" : "正在查询最新版本…");
  renderWebsiteDownload();
}

function renderWebsiteDownload() {
  const state = websiteDownloadState;
  const busy = Boolean(websiteDownloadController);
  const english = document.documentElement.lang === "en";
  downloadPlatform.disabled = busy;
  downloadSource.disabled = busy;
  downloadButton.setAttribute("aria-disabled", String(busy));
  downloadProgressPanel.hidden = !state;
  downloadProgressPanel.setAttribute("aria-busy", String(busy));
  downloadCancel.hidden = !busy;
  downloadCancel.disabled = Boolean(websiteDownloadController?.signal.aborted);
  if (!state) return;
  const percent = state.total > 0 ? Math.min(100, state.loaded / state.total * 100) : 0;
  if (busy && ["testing", "switching"].includes(state.phase)) downloadProgress.removeAttribute("value");
  else downloadProgress.value = percent;
  const source = state.source ? ` · ${state.source}` : "";
  const messages = {
    testing: english ? "Testing download sources…" : "正在测试下载线路…",
    switching: english ? "Switching download source…" : "正在切换下载线路…",
    verifying: english ? "Checking the downloaded file…" : "正在检查下载文件…",
    cancelling: english ? "Cancelling download…" : "正在取消下载…",
    cancelled: english ? "Download cancelled." : "已取消下载。",
    complete: english ? "File verified and handed to your browser to save." : "文件已校验，已交给浏览器保存。",
    invalid: english ? "Cannot verify this file yet. Use the browser fallback link." : "暂时无法确认此文件，请使用浏览器备用直链。",
    error: english ? "Download incomplete. Try another source or the browser fallback link." : "下载未完成，请换条线路重试，或使用浏览器备用直链。"
  };
  if (state.phase === "downloading") {
    const rate = state.speed > 0
      ? `${(state.speed / (state.speed >= 1048576 ? 1048576 : 1024)).toFixed(1)} ${state.speed >= 1048576 ? "MB" : "KB"}/s`
      : (english ? "measuring speed…" : "正在计算速度…");
    downloadProgressText.textContent = `${english ? "Downloading" : "正在下载"}${source} · ${percent.toFixed(1)}% · ${rate}`;
  } else downloadProgressText.textContent = `${messages[state.phase] ?? messages.error}${source}`;
  if (busy) downloadButton.querySelector("#download-button-label").textContent = english ? "Download in progress…" : "正在下载…";
}

function updateWebsiteDownloadProgress(progress, controller) {
  if (websiteDownloadController !== controller || controller.signal.aborted) return;
  const now = Date.now();
  const loaded = Math.max(0, Number(progress.loaded) || 0);
  const previous = websiteDownloadState;
  const continuing = progress.phase === "downloading" && previous?.phase === "downloading"
    && previous.source === progress.source && loaded >= previous.loaded;
  const startedAt = continuing ? previous.startedAt : now;
  const startedBytes = continuing ? previous.startedBytes : loaded;
  websiteDownloadState = {
    ...progress, loaded, total: Number(progress.total) || 0, startedAt, startedBytes,
    speed: now > startedAt ? (loaded - startedBytes) * 1000 / (now - startedAt) : 0
  };
  renderWebsiteDownload();
}

function loadWebsiteDownloader() {
  return import("./website-downloader.mjs?v=20261101-download-3");
}

async function abortableWebsiteDownload(task, signal) {
  signal.throwIfAborted();
  let rejectOnAbort;
  const aborted = new Promise((_resolve, reject) => {
    rejectOnAbort = () => reject(signal.reason);
    signal.addEventListener("abort", rejectOnAbort, { once: true });
  });
  try { return await Promise.race([task, aborted]); }
  finally { signal.removeEventListener("abort", rejectOnAbort); }
}

function saveWebsiteDownload(result, asset) {
  if (!(result.blob instanceof Blob) || result.blob.size !== asset.size || result.filename !== asset.name) {
    throw new Error("Invalid downloaded file");
  }
  const objectUrl = URL.createObjectURL(result.blob);
  const link = document.createElement("a");
  try {
    link.href = objectUrl;
    link.download = result.filename;
    document.body.append(link);
    link.click();
  } catch (error) {
    URL.revokeObjectURL(objectUrl);
    throw error;
  } finally {
    link.remove();
  }
  setTimeout(() => URL.revokeObjectURL(objectUrl), 60000);
}

async function handleWebsiteDownload(event) {
  if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
  if (websiteDownloadController) { event.preventDefault(); return; }
  const asset = selectedDownloadAsset();
  if (!asset || downloadSource.value === "official") return;
  event.preventDefault();
  if (!Number.isSafeInteger(asset.size) || asset.size <= 0 || !/^sha256:[a-f\d]{64}$/i.test(asset.digest ?? "")) {
    websiteDownloadState = { phase: "invalid", loaded: 0, total: 0 };
    renderWebsiteDownload();
    return;
  }
  const controller = new AbortController();
  websiteDownloadController = controller;
  websiteDownloadState = { phase: "testing", loaded: 0, total: asset.size };
  renderWebsiteDownload();
  try {
    const { downloadReleaseAsset } = await abortableWebsiteDownload(loadWebsiteDownloader(), controller.signal);
    controller.signal.throwIfAborted();
    const result = await abortableWebsiteDownload(downloadReleaseAsset({
      asset, sources: websiteDownloadSources(asset), signal: controller.signal,
      autoSelect: downloadSource.value === "auto",
      onProgress: (progress) => updateWebsiteDownloadProgress(progress, controller)
    }), controller.signal);
    controller.signal.throwIfAborted();
    saveWebsiteDownload(result, asset);
    websiteDownloadState = {
      phase: "complete", loaded: asset.size, total: asset.size,
      source: typeof result.source === "string" ? result.source : result.source?.label
    };
  } catch (error) {
    const cancelled = controller.signal.aborted || error.name === "AbortError" || error.code === "ABORT_ERR";
    websiteDownloadState = { ...websiteDownloadState,
      phase: cancelled ? "cancelled" : error.code === "INVALID_ASSET" ? "invalid" : "error" };
  } finally {
    websiteDownloadController = null;
    updateDownloadLink();
  }
}

function clearWebsiteDownload() {
  if (websiteDownloadController) return;
  websiteDownloadState = null;
  updateDownloadLink();
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
try {
  const savedSource = localStorage.getItem("melody-site-download-source");
  if ([...downloadSource.options].some((option) => option.value === savedSource)) downloadSource.value = savedSource;
} catch {}
downloadPlatform.addEventListener("change", clearWebsiteDownload);
downloadSource.addEventListener("change", () => {
  clearWebsiteDownload();
  try {
    if ([...downloadSource.options].some((option) => option.value === downloadSource.value)) {
      localStorage.setItem("melody-site-download-source", downloadSource.value);
    }
  } catch {}
});
downloadButton.addEventListener("click", handleWebsiteDownload);
downloadCancel.addEventListener("click", () => {
  if (!websiteDownloadController) return;
  websiteDownloadController.abort();
  websiteDownloadState = { ...websiteDownloadState, phase: "cancelling" };
  renderWebsiteDownload();
});
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
