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
  "download.button": "Verify and download",
  "download.browser": "Downloads use 1 MiB parts and four parallel requests, then verify SHA-256 before saving. Keep this page open.",
  "download.verification": "Complete Cloudflare human verification to start the download.",
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
const downloadButton = document.querySelector("#download-button");
const downloadAlternative = document.querySelector("#download-alternative");
const downloadTurnstile = document.querySelector("#download-turnstile");
const downloadStatus = document.querySelector("#download-status");
const downloadProgressPanel = document.querySelector("#download-progress-panel");
const downloadProgress = document.querySelector("#download-progress");
const downloadProgressText = document.querySelector("#download-progress-text");
const downloadCancel = document.querySelector("#download-cancel");
const changelogDetails = document.querySelector("#changelog-details");
const changelogList = document.querySelector("#changelog-list");
const releaseApiUrl = "/api/latest-release";
let latestRelease = null;
let releaseLoadFailed = false;
let downloadAvailability = "checking";
let downloadController = null;
let downloadState = null;
let downloadBaseUrl = null;
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
      return { url: objectStorageUrl, githubUrl, objectStorage: true, verifiedMetadata };
    }
    try {
      const url = new URL(asset.browser_download_url);
      if (url.protocol === "https:" && url.hostname.endsWith(".public.blob.vercel-storage.com")
        && !url.username && !url.password && !url.port && !url.search && !url.hash) {
        return { url: url.href, githubUrl, objectStorage: true, verifiedMetadata };
      }
    } catch {}
  }
  return { url: githubUrl, githubUrl, objectStorage: false, verifiedMetadata };
}

function updateDownloadLink() {
  const english = document.documentElement.lang === "en";
  document.querySelector("#latest-version").textContent = latestRelease?.tag_name ?? "—";
  const asset = selectedDownloadAsset();
  const target = downloadTarget(asset);
  const busy = Boolean(downloadController);
  const configured = downloadAvailability === "available" && Boolean(downloadBaseUrl);
  const enabled = Boolean(target?.verifiedMetadata && configured && !busy);
  downloadPlatform.disabled = busy;
  downloadButton.disabled = !enabled;
  downloadButton.setAttribute("aria-disabled", String(!enabled));
  downloadButton.querySelector("#download-button-label").textContent = busy
    ? downloadState?.phase === "authorizing"
      ? (english ? "Verifying…" : "正在验证…")
      : (english ? "Download in progress…" : "正在下载…")
    : !configured
      ? (english ? "Download temporarily unavailable" : "下载暂不可用")
      : (english ? "Verify and download" : "验证并下载");
  downloadTurnstile.hidden = !busy || downloadState?.phase !== "authorizing";
  if (target) {
    downloadAlternative.href = target.githubUrl;
    downloadAlternative.download = asset.name;
  } else {
    downloadAlternative.removeAttribute("href");
    downloadAlternative.removeAttribute("download");
  }
  // Public alternatives remain available even while the verification gateway
  // is unconfigured or an R2 asset has not been synchronized.
  downloadAlternative.hidden = !target;
  const size = Number.isSafeInteger(asset?.size) && asset.size > 0
    ? ` · ${(asset.size / 1048576).toFixed(1)} MB` : "";
  const baseStatus = downloadAvailability === "unavailable"
    ? (english ? "Human verification is unavailable. Use GitHub or the cloud links below." : "真人验证暂不可用，请使用 GitHub 或下方网盘下载。")
    : target && !target.verifiedMetadata
      ? (english ? "Trusted file size or SHA-256 is missing. Use GitHub Releases below." : "缺少可信的文件大小或 SHA-256，请使用下方 GitHub 下载。")
      : target
        ? `${latestRelease.tag_name}${size} · ${target.objectStorage ? (english ? "Object storage" : "对象存储") : (english ? "GitHub fallback" : "GitHub 回退")} · ${english ? "4 parallel parts + SHA-256" : "4 路分段 + SHA-256"}`
        : releaseLoadFailed
          ? (english ? "Could not load the download list. Use GitHub Releases or the cloud links below." : "暂时无法读取安装包列表，请使用 GitHub Releases 或下方网盘下载。")
          : latestRelease
            ? (english ? "No build for this platform in the latest release." : "最新版本暂无该平台的安装包。")
            : (english ? "Checking the latest release…" : "正在查询最新版本…");
  downloadStatus.textContent = baseStatus;
  renderWebsiteDownload();
}

function loadWebsiteAuthorization() {
  return import("./website-download-auth.mjs?v=20261111-segmented");
}

function loadWebsiteDownloader() {
  return import("./website-downloader.mjs?v=20261111-segmented");
}

function renderWebsiteDownload() {
  const state = downloadState;
  const busy = Boolean(downloadController);
  const english = document.documentElement.lang === "en";
  downloadProgressPanel.hidden = !state;
  downloadProgressPanel.setAttribute("aria-busy", String(busy));
  downloadCancel.hidden = !busy;
  downloadCancel.disabled = Boolean(downloadController?.signal.aborted);
  downloadTurnstile.hidden = !busy || state?.phase !== "authorizing";
  if (!state) return;
  const percent = state.total > 0 ? Math.min(100, Math.max(0, state.loaded / state.total * 100)) : 0;
  if (busy && ["authorizing", "testing", "switching"].includes(state.phase)) downloadProgress.removeAttribute("value");
  else downloadProgress.value = percent;
  const source = state.source ? ` · ${state.source}` : "";
  const messages = {
    authorizing: english ? "Complete human verification below to start downloading…" : "请在下方完成真人验证，验证后开始下载…",
    testing: english ? "Testing the download connection…" : "正在测试下载线路…",
    switching: english ? "Switching download source…" : "正在切换下载线路…",
    verifying: english ? "Checking the complete file's SHA-256…" : "正在检查完整文件的 SHA-256…",
    cancelling: english ? "Cancelling download…" : "正在取消下载…",
    cancelled: english ? "Download cancelled. Verify again to retry." : "下载已取消，可重新验证后重试。",
    complete: english ? "File verified and handed to your browser to save." : "文件已校验，已交给浏览器保存。",
    expired: english ? "Verification or download authorization expired. Verify again to retry." : "验证或下载授权已过期，请重新验证后重试。",
    invalid: english ? "File information or downloaded bytes could not be verified. No file was saved." : "文件信息或下载内容校验失败，未保存文件。",
    error: english ? "Download did not finish. Verify again to retry, or use GitHub below." : "下载未完成，请重新验证后重试，或使用下方 GitHub 下载。"
  };
  if (state.phase === "downloading") {
    const unit = state.speed >= 1048576 ? "MB" : "KB";
    const rate = state.speed > 0 ? `${(state.speed / (unit === "MB" ? 1048576 : 1024)).toFixed(1)} ${unit}/s`
      : (english ? "measuring speed…" : "正在计算速度…");
    downloadProgressText.textContent = `${english ? "Downloading" : "正在下载"}${source} · ${percent.toFixed(1)}% · ${rate}`;
  } else downloadProgressText.textContent = `${messages[state.phase] ?? messages.error}${source}`;
}

function updateWebsiteDownloadProgress(progress, controller) {
  if (downloadController !== controller || controller.signal.aborted) return;
  const now = Date.now();
  const loaded = Math.max(0, Number(progress.loaded) || 0);
  const previous = downloadState;
  const continuing = progress.phase === "downloading" && previous?.phase === "downloading"
    && previous.source === progress.source && loaded >= previous.loaded;
  const startedAt = continuing ? previous.startedAt : now;
  const startedBytes = continuing ? previous.startedBytes : loaded;
  downloadState = { ...progress, loaded, total: Number(progress.total) || 0, startedAt, startedBytes,
    speed: now > startedAt ? (loaded - startedBytes) * 1000 / (now - startedAt) : 0 };
  updateDownloadLink();
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
  if (!(result?.blob instanceof Blob) || result.blob.size !== asset.size || result.filename !== asset.name) {
    throw Object.assign(new Error("Invalid downloaded file"), { code: "SIZE_MISMATCH" });
  }
  const objectUrl = URL.createObjectURL(result.blob);
  const link = document.createElement("a");
  try {
    link.href = objectUrl;
    link.download = result.filename;
    link.rel = "noreferrer";
    link.hidden = true;
    document.body.append(link);
    link.click();
  } catch (error) {
    URL.revokeObjectURL(objectUrl);
    throw error;
  } finally { link.remove(); }
  setTimeout(() => URL.revokeObjectURL(objectUrl), 60000);
}

async function loadDownloadConfiguration() {
  try {
    const response = await fetch("/api/download-config", { method: "GET", cache: "no-store", signal: AbortSignal.timeout(10000) });
    const config = await response.json();
    downloadBaseUrl = null;
    downloadAvailability = response.ok && config?.enabled === true
      && typeof config.siteKey === "string" && config.siteKey.length > 0
      && config.action === "download" ? "available" : "unavailable";
    if (downloadAvailability === "available") {
      const { validatedDownloadBaseUrl } = await loadWebsiteAuthorization();
      downloadBaseUrl = validatedDownloadBaseUrl(config.baseUrl);
    }
  } catch { downloadAvailability = "unavailable"; downloadBaseUrl = null; }
  updateDownloadLink();
}

async function handleWebsiteDownload(event) {
  event.preventDefault();
  if (downloadController) return;
  const asset = selectedDownloadAsset();
  const target = downloadTarget(asset);
  if (!asset || !target?.verifiedMetadata || !downloadBaseUrl || downloadAvailability !== "available") return;
  const tag = latestRelease.tag_name;
  const controller = new AbortController();
  downloadController = controller;
  downloadState = { phase: "authorizing", loaded: 0, total: asset.size };
  updateDownloadLink();
  try {
    const { authorizeWebsiteDownload } = await abortableWebsiteDownload(loadWebsiteAuthorization(), controller.signal);
    const authorization = await abortableWebsiteDownload(authorizeWebsiteDownload({
      tag, asset, expectedUrl: `${downloadBaseUrl}/releases/${encodeURIComponent(tag)}/${encodeURIComponent(asset.name)}`,
      container: downloadTurnstile, signal: controller.signal
    }), controller.signal);
    controller.signal.throwIfAborted();
    const { downloadReleaseAsset } = await abortableWebsiteDownload(loadWebsiteDownloader(), controller.signal);
    const result = await abortableWebsiteDownload(downloadReleaseAsset({
      asset, sources: [{ id: "cloudflare", label: "Cloudflare CDN", url: authorization.url }],
      signal: controller.signal, segmentBytes: 1048576, concurrency: 4, autoSelect: true,
      fetchImpl: async (url, options) => {
        if (Date.now() >= Date.parse(authorization.expiresAt)) {
          throw Object.assign(new Error("Download authorization expired"), { code: "AUTHORIZATION_EXPIRED" });
        }
        const response = await fetch(url, { ...options, referrerPolicy: "no-referrer", redirect: "error" });
        if (response.status === 403) {
          try { await response.body?.cancel(); } catch {}
          throw Object.assign(new Error("Download authorization expired"), { code: "AUTHORIZATION_EXPIRED" });
        }
        return response;
      },
      onProgress: progress => updateWebsiteDownloadProgress(progress, controller)
    }), controller.signal);
    controller.signal.throwIfAborted();
    saveWebsiteDownload(result, asset);
    downloadState = { phase: "complete", loaded: asset.size, total: asset.size, source: result.source };
  } catch (error) {
    const cancelled = controller.signal.aborted || error?.name === "AbortError" || error?.code === "ABORT_ERR";
    downloadState = { ...downloadState, phase: cancelled ? "cancelled"
      : ["AUTHORIZATION_EXPIRED", "VERIFICATION_EXPIRED"].includes(error?.code) ? "expired"
      : ["INVALID_ASSET", "SIZE_MISMATCH", "CHECKSUM_MISMATCH", "INVALID_AUTHORIZATION"].includes(error?.code) ? "invalid" : "error" };
  } finally {
    downloadController = null;
    updateDownloadLink();
  }
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
downloadPlatform.addEventListener("change", () => { downloadState = null; updateDownloadLink(); });
downloadButton.addEventListener("click", handleWebsiteDownload);
downloadCancel.addEventListener("click", () => {
  if (!downloadController) return;
  downloadController.abort();
  downloadState = { ...downloadState, phase: "cancelling" };
  updateDownloadLink();
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
loadDownloadConfiguration();
