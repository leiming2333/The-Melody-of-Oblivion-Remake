<div align="center">
  <img src="assets/app-icon.png" width="96" alt="Melody of Oblivion Launcher icon">

# Melody of Oblivion Launcher

**A modern, independent remake of the classic Chinese Minecraft: Java Edition launcher “忘却的旋律”.**

[English](README.en.md) · [简体中文](README.md)

[![License: AGPL v3](https://img.shields.io/badge/License-AGPL_v3-blue.svg)](https://www.gnu.org/licenses/agpl-3.0)
[![Node.js](https://img.shields.io/badge/Node.js-22+-green.svg)](https://nodejs.org/)
[![Electron](https://img.shields.io/badge/Electron-43+-9feaf9.svg)](https://www.electronjs.org/)
[![Minecraft](https://img.shields.io/badge/Minecraft-Java_Edition-62b74a.svg)](https://www.minecraft.net/)
[![Platform](https://img.shields.io/badge/Platform-Windows%20%7C%20macOS%20%7C%20Linux-lightgrey.svg)](#current-limitations)
[![Source](https://img.shields.io/badge/Source-v1.6.6-red.svg)](https://github.com/leiming2333/The-Melody-of-Oblivion-Remake)
</div>

> [!IMPORTANT]
> The current source version is `1.6.6`, with Microsoft, offline, and LittleSkin sign-in and Desert Lake as the default wallpaper. Published downloads are available through the [website](https://the-melody-of-o-r.ccwu.cc/#download) and GitHub Releases; see the Release page for available versions. Local source changes require a new build, and website changes require deployment, to affect published content. Back up your Minecraft data before testing.

## About this project

Melody of Oblivion Launcher is an Electron-based Minecraft: Java Edition launcher built from scratch. It keeps the quiet, compact character associated with the old launcher while replacing its internals with a modern download, account, Java-runtime, mod-loader, and launch pipeline.

This is an independent tribute. It is **not** an official update, a continuation of the original source code, or a project endorsed by the original developer, Mojang Studios, or Microsoft.

## The name and its history

“忘却的旋律” is remembered as one of the early third-party Minecraft launchers widely used in the Chinese community. Public accounts commonly describe it as an Easy Language application that became popular around 2012 for its small size, simple interface, background customization, and convenient game setup. Version `5.31` is widely reported as its final release, with maintenance ending in 2014.

The surviving public record is incomplete and sometimes contradictory—for example, the same encyclopedia entry mentions both 2009 and 2012 as origin dates. This README therefore treats “around 2012”, version `5.31`, and 2014 as community-reported history rather than verified primary-source facts.

The current repository starts a new implementation; its version numbers and code lineage are unrelated to the historical launcher.

## What is implemented

- **Game versions** — browse Mojang's version manifest, detect local installations, download Vanilla versions, verify required files, and move removable profiles to the recycle bin.
- **Mod loaders** — discover and install Fabric, Forge, NeoForge, and Quilt through a shared workflow.
- **Resilient downloads** — choose between Mojang-hosted endpoints and BMCLAPI, probe sources in automatic mode, use configurable task concurrency, split large files with HTTP Range requests, verify SHA-1 metadata, cancel active work, and retry alternate sources.
- **Accounts** — create offline profiles, sign in with a Microsoft device code, or use LittleSkin Yggdrasil; sync skin avatars, refresh online credentials before launch, and keep tokens out of the renderer process.
- **Java management** — match the Java major version required by the selected game; scan system installations and managed runtimes. Download Java 8, 16, 17, 21, or 25 from the button next to the Java path setting, with progress and cancellation. Downloads prefer Azul JRE and fall back to Adoptium, use parallel transfers, and verify SHA-256. Launching without the required Java opens settings instead of starting a download.
- **Launch core** — resolve inherited version metadata, apply platform rules, assemble arguments and classpaths, extract native libraries safely, launch the Java process, and report its status. LittleSkin accounts automatically provision a SHA-256-verified authlib-injector.
- **Modpacks** — inspect and install Modrinth `.mrpack` and CurseForge `.zip` archives into separate instance directories, including overrides and supported loaders.
- **Launcher updates** — checks GitHub Releases on startup with a three-level policy (auto-download / notify only / never); system notifications announce new versions and ready updates; release notes are shown in settings; update downloads fall back across GitHub mirrors with slow-speed detection and are SHA-256 verified before install. Legacy boolean update settings migrate automatically.
- **Desktop UI** — a compact fixed-size frameless Electron window with version, account, download, launch, and settings flows.

The automated test suite covers accounts, authentication, downloads, Java selection, launching, loaders, modpacks, settings, local version management, and launcher updates.

## Actual interface

These screenshots were captured from the current `1.6.5` Electron source, with no accounts added or games installed.

![Actual launcher home screen with the default Desert Lake wallpaper](assets/launcher-screenshot.png)

![Actual account management screen with Microsoft, offline, and LittleSkin sign-in](assets/launcher-accounts.png)

The website shows the actual home and account screens and uses the same Desert Lake scene. Its download section offers system, architecture, and source selection. A separate release-notes section opens by default and shows only the latest version. The website does not display installer SHA-256 values; launcher updates still verify them before installation.

## Current limitations

- Public multi-architecture builds are available for Windows, macOS, and Linux. Platform-specific behavior may still vary.
- Update behavior differs per platform: Linux AppImages replace themselves and restart; Windows stages same-name updates, replaces the EXE after exit, and keeps an `.old` backup (legacy versioned EXEs still update side by side); macOS downloads a zip that must be extracted and replaced manually.
- Microsoft sign-in depends on the launcher's Azure application registration being accepted by Minecraft Services. Provider-side policy or registration changes can make login unavailable.
- LittleSkin Yggdrasil works only when both client and server are configured for the same authentication service. It does not replace a premium account or grant access to premium-only servers. See the [LittleSkin manual](https://manual.littlesk.in/yggdrasil/).
- CurseForge installation depends on downloadable file metadata from CurseTools or, when configured, `CURSEFORGE_API_KEY`. Packs containing restricted or unavailable files may fail.
- Quilt modpacks are supported; compatibility depends on the game version and mods.
- Modpack handling and user-facing failure recovery are still being refined.

## Requirements

- Windows 10/11, macOS, or Linux, with a download matching the device architecture
- Node.js 22 or later
- npm compatible with the committed lockfile
- An internet connection for metadata, game files, authentication, and managed Java downloads
- A legally owned Minecraft: Java Edition account for authenticated online play

## Run from source

The Windows single-file portable EXE requires no installation. Artifact names omit the version; application metadata and release tags retain it. The first run extracts into a content-fingerprinted directory under `Melody/runtime/` beside the EXE and subsequent runs reuse it. A shared mutex coordinates extraction, launch leases and cleanup. After the window is ready, background cleanup keeps the current runtime, one recent previous runtime, and any active runtimes; it removes other unused builds and extraction residue older than one day. Unwritable adjacent directories fall back to `%LOCALAPPDATA%/MelodyOfOblivion/runtime`. Accounts and settings remain in the existing user data location. Legacy `启动器运行文件` directories are not migrated or deleted automatically; remove them manually after all older launchers are closed. Published builds do not require Node.js.

```powershell
npm ci
npm run dev
```

Microsoft sign-in uses a bundled public Azure application ID. To use your own application registration, set `MELODY_MICROSOFT_CLIENT_ID` before starting the launcher or building it.

System directory mode uses the operating system's Minecraft application-data directory (`%APPDATA%\.minecraft` on Windows). Local mode uses `.minecraft` beside the portable EXE or source checkout; runtime cache locations do not change it. Modpack instances are created below the selected `.minecraft/melody-instances`.

Java probe results are persisted in `java-cache.json` in the launcher user-data directory and invalidated when runtime files change; manual redetection bypasses the cache. Background initialization starts after the home screen paints. Missing Java produces a nonmodal hint. `logs/startup-latest.json` records the most recent startup stages from main-process entry onwards; portable EXE extraction before Electron starts is not measured.

Download, loader, modpack, Java download and game-launch services initialize on first use and are reused within the current game directory. Switching directories creates fresh services. Home-screen version scans and Java detection use lightweight readers. Extracted native libraries are cached by archive content and exclusion rules under `.minecraft/launcher-cache/native-archives`, with file verification on reuse and regeneration after changes or corruption. Each game uses separate copies; exiting a game removes its copies while preserving shared cache generations, which can be manually cleared after games close.

## Development commands

| Command | Purpose |
| --- | --- |
| `npm run dev` | Start the Electron app in development mode |
| `npm run check` | Syntax-check the main, preload, and renderer JavaScript |
| `npm test` | Run the Node.js test suite |
| `npm run smoke` | Load the Electron window with temporary user data and exit |
| `npm run build:win` | Build Windows portable EXE with a persistent runtime |
| `npm run build:linux` | Build Linux AppImage |
| `npm run build:mac` | Build macOS zip packages |

See [CI and release validation](docs/ci-release-validation.md) (in Chinese) for checks, release gates, and platform startup coverage.

## Repository layout

```text
src/
├── main/                 Electron main process
│   ├── accounts/         Offline, Microsoft, and LittleSkin accounts
│   ├── minecraft/        Downloads, Java, loaders, launch, and modpacks
│   └── settings/         Persistent launcher settings
├── preload/              Sandboxed renderer bridge
└── renderer/             Launcher interface
test/                     Node.js tests
assets/                   Shared artwork
index.html                Project landing page
site.js                   Landing-page translations and behavior
styles.css                Landing-page styles
```

The repository root contains the website, while `src/renderer` contains the Electron launcher. The website displays actual launcher captures from `assets/launcher-screenshot.png` and `assets/launcher-accounts.png`; recapture them when the launcher interface changes.

## Security notes

- Electron runs the renderer with context isolation, sandboxing, and Node.js integration disabled.
- Microsoft and LittleSkin access, refresh, and client tokens are removed from renderer-facing account objects.
- Online-account tokens are encrypted at rest with Electron's `safeStorage`. Unavailable secure storage or an unprotected Linux backend such as `basic_text` blocks saving and reading online credentials. Offline accounts remain usable.
- Only one launcher can run per user-data directory; opening it again focuses the existing window. Account and settings changes also share a queue across store objects targeting the same file.
- Microsoft sign-in uses a public OAuth application ID; `MELODY_MICROSOFT_CLIENT_ID` can override it when building. The repository contains no client secret, and public Electron builds cannot keep an embedded Client ID confidential.
- Download destinations, modpack paths, archive extraction, and remote mod URLs are validated to reduce path-traversal and unsafe-URL risks.
- SHA-1 checks detect accidental corruption when upstream metadata provides a hash; SHA-1 should not be treated as a modern authenticity guarantee.

Security-sensitive reports should not include account files, access tokens, refresh tokens, device codes, or personal Minecraft data.

## Diagnostics and installation retries

Java stdout and stderr are saved under `launcher-cache/game-logs` in the game root. Each log is limited to 2 MiB, with five recent logs retained by default; logs for running games remain available. Known account tokens and common credential fields are redacted, and full launch commands are not recorded. Crash messages include the log path. Check usernames, server addresses, and other personal details before sharing a log.

Modpack previews read only the manifest. SHA-1-verified downloads are cached under `launcher-cache/modpack-files` in the game root and survive failed or cancelled installations. Every reuse verifies the file again; files without a valid hash are not cached. To reclaim space, remove this cache directory after closing games and stopping installations.

## Next steps

- Finish modpack compatibility and recovery paths.
- Improve error messages and cancellation behavior across the UI.
- Improve repeatable multi-platform builds and release artifacts.
- Polish per-platform update installation (Windows old-file cleanup and automatic macOS replacement).

## Historical references

- [Baidu Baike: 忘却的旋律 (Minecraft Java Edition launcher)](https://baike.baidu.com/item/%E5%BF%98%E5%8D%B4%E7%9A%84%E6%97%8B%E5%BE%8B/16496487) — a secondary community-edited summary; consulted for the commonly reported 2012/2014 timeline and final version.
- [Minecraft: Java Edition is moving house](https://www.minecraft.net/en-us/article/java-edition-moving-house) — Mojang's announcement of the move from Mojang accounts to Microsoft accounts.

These links document historical context; they do not imply endorsement of this remake. Avoid downloading old launcher binaries from unverified mirrors.

## License and trademarks

The project is distributed under the [GNU Affero General Public License v3.0](LICENSE). Third-party names, trademarks, and assets remain subject to their respective owners' terms.

Minecraft is a trademark of Microsoft. This project is unofficial and is not affiliated with or endorsed by Microsoft or Mojang Studios. The “忘却的旋律” name is used here as a reference and tribute to the historical launcher; no ownership of the original project is claimed.
