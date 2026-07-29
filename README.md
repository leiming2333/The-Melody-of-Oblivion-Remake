<div align="center">
  <img src="assets/app-icon.png" width="96" alt="Melody of Oblivion Launcher icon">

# Melody of Oblivion Launcher

**A modern, independent remake of the classic Chinese Minecraft: Java Edition launcher “忘却的旋律”.**

English · [简体中文](README.zh-CN.md)
</div>

> [!IMPORTANT]
> This repository is a **development preview** at version `0.1.0`. There is no public installer or stable release yet. Build it from source only if you are comfortable testing unfinished software, and back up your Minecraft data first.

## About this project

Melody of Oblivion Launcher is an Electron-based Minecraft: Java Edition launcher built from scratch. It keeps the quiet, compact character associated with the old launcher while replacing its internals with a modern download, account, Java-runtime, mod-loader, and launch pipeline.

This is an independent tribute. It is **not** an official update, a continuation of the original source code, or a project endorsed by the original developer, Mojang Studios, or Microsoft.

## The name and its history

“忘却的旋律” is remembered as one of the early third-party Minecraft launchers widely used in the Chinese community. Public accounts commonly describe it as an Easy Language application that became popular around 2012 for its small size, simple interface, background customization, and convenient game setup. Version `5.31` is widely reported as its final release, with maintenance ending in 2014.

The surviving public record is incomplete and sometimes contradictory—for example, the same encyclopedia entry mentions both 2009 and 2012 as origin dates. This README therefore treats “around 2012”, version `5.31`, and 2014 as community-reported history rather than verified primary-source facts.

The current repository starts a new implementation at version `0.1.0`; its version numbers and code lineage are unrelated to the historical launcher.

## What is implemented

- **Game versions** — browse Mojang's version manifest, detect local installations, download Vanilla versions, verify required files, and move removable profiles to the recycle bin.
- **Mod loaders** — discover and install Fabric, Forge, and NeoForge through a shared workflow.
- **Resilient downloads** — choose between Mojang-hosted endpoints and BMCLAPI, probe sources in automatic mode, use configurable task concurrency, split large files with HTTP Range requests, verify SHA-1 metadata, cancel active work, and retry alternate sources.
- **Accounts** — create offline profiles or sign in with a Microsoft device code; refresh Microsoft credentials before launch and keep tokens out of the renderer process.
- **Java management** — match the Java major version required by the selected game, prefer an explicit compatible runtime, and otherwise provision an Eclipse Temurin JRE through the Adoptium API.
- **Launch core** — resolve inherited version metadata, apply platform rules, assemble arguments and classpaths, extract native libraries safely, launch the Java process, and report its status.
- **Modpacks** — inspect and install Modrinth `.mrpack` and CurseForge `.zip` archives into separate instance directories, including overrides and supported loaders.
- **Desktop UI** — a compact frameless Electron window with version, account, download, launch, and settings flows.

The automated test suite currently covers 54 cases across accounts, authentication, downloads, Java selection, launching, loaders, modpacks, settings, and local version management.

## Current limitations

- Windows 10/11 is the current development and release target. Some internals contain macOS and Linux handling, but those platforms are not yet supported releases.
- No packaged executable, installer, updater, or public download is available.
- Microsoft sign-in depends on the launcher's Azure application registration being accepted by Minecraft Services. Provider-side policy or registration changes can make the preview login unavailable.
- CurseForge installation depends on downloadable file metadata from CurseTools or, when configured, `CURSEFORGE_API_KEY`. Packs containing restricted or unavailable files may fail.
- Quilt modpacks are not supported.
- Modpack handling and user-facing failure recovery are still being refined.

## Requirements

- Windows 10 or Windows 11
- Node.js 22 or later
- npm compatible with the committed lockfile
- An internet connection for metadata, game files, authentication, and managed Java downloads
- A legally owned Minecraft: Java Edition account for authenticated online play

## Run from source

```powershell
npm ci
npm run dev
```

The preview uses the operating system's Minecraft application-data directory (`%APPDATA%\.minecraft` on Windows). Modpack instances are created below `.minecraft\melody-instances`. Back up an existing installation before testing.

## Development commands

| Command | Purpose |
| --- | --- |
| `npm run dev` | Start the Electron app in development mode |
| `npm run check` | Syntax-check the main, preload, and renderer JavaScript |
| `npm test` | Run the Node.js test suite |
| `npm run smoke` | Load the Electron window with temporary user data and exit |

## Repository layout

```text
src/
├── main/                 Electron main process
│   ├── accounts/         Offline and Microsoft accounts
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

The landing page in the repository root and the Electron renderer under `src/renderer` are separate interfaces.

## Security notes

- Electron runs the renderer with context isolation, sandboxing, and Node.js integration disabled.
- Microsoft access and refresh tokens are removed from renderer-facing account objects.
- Tokens are encrypted at rest when Electron's `safeStorage` is available. The current preview falls back to plain text if the operating system cannot provide secure storage, so do not use Microsoft sign-in on a shared or untrusted machine.
- Download destinations, modpack paths, archive extraction, and remote mod URLs are validated to reduce path-traversal and unsafe-URL risks.
- SHA-1 checks detect accidental corruption when upstream metadata provides a hash; SHA-1 should not be treated as a modern authenticity guarantee.

Security-sensitive reports should not include account files, access tokens, refresh tokens, device codes, or personal Minecraft data.

## Road to the first preview

- Finish modpack compatibility and recovery paths.
- Improve error messages and cancellation behavior across the UI.
- Add repeatable Windows packaging and release artifacts.
- Document release verification, upgrade behavior, and known issues.

## Historical references

- [Baidu Baike: 忘却的旋律 (Minecraft Java Edition launcher)](https://baike.baidu.com/item/%E5%BF%98%E5%8D%B4%E7%9A%84%E6%97%8B%E5%BE%8B/16496487) — a secondary community-edited summary; consulted for the commonly reported 2012/2014 timeline and final version.
- [Minecraft: Java Edition is moving house](https://www.minecraft.net/en-us/article/java-edition-moving-house) — Mojang's announcement of the move from Mojang accounts to Microsoft accounts.

These links document historical context; they do not imply endorsement of this remake. Avoid downloading old launcher binaries from unverified mirrors.

## License and trademarks

No project license has been added yet. Until one is published, normal copyright restrictions apply to the repository's original code and assets.

Minecraft is a trademark of Microsoft. This project is unofficial and is not affiliated with or endorsed by Microsoft or Mojang Studios. The “忘却的旋律” name is used here as a reference and tribute to the historical launcher; no ownership of the original project is claimed.
