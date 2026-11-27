import { MakerDeb } from "@electron-forge/maker-deb";
import { MakerFlatpak } from "@electron-forge/maker-flatpak";
import { MakerFlatpakOptionsConfig } from "@electron-forge/maker-flatpak/dist/Config";
import { MakerRpm } from "@electron-forge/maker-rpm";
import { MakerSquirrel } from "@electron-forge/maker-squirrel";
import { MakerZIP } from "@electron-forge/maker-zip";
import { FusesPlugin } from "@electron-forge/plugin-fuses";
import { VitePlugin } from "@electron-forge/plugin-vite";
import { PublisherGithub } from "@electron-forge/publisher-github";
import type { ForgeConfig } from "@electron-forge/shared-types";
import { FuseV1Options, FuseVersion } from "@electron/fuses";
import fs from "node:fs";
import path from "node:path";

// import { globSync } from "node:fs";

const STRINGS = {
  author: "Revolt Platforms LTD",
  name: "StoatHomelab",
  execName: "stoat-homelab",
  description: "Open source user-first chat platform.",
  homepage: "https://github.com/yPerfectBR/for-desktop",
};

const ASSET_DIR = "assets/desktop";

// Shared by the .deb and .rpm packages
const LINUX_PACKAGE_OPTIONS = {
  name: STRINGS.execName,
  productName: "Stoat Homelab",
  genericName: "Chat",
  description: STRINGS.description,
  productDescription: "Stoat client for our self-hosted homelab server.",
  bin: STRINGS.execName,
  icon: `${ASSET_DIR}/hicolor/512x512.png`,
  categories: ["Network" as const],
  mimeType: ["x-scheme-handler/stoat"],
  homepage: STRINGS.homepage,
};

/**
 * Build targets for the desktop app
 */
const makers: ForgeConfig["makers"] = [
  new MakerSquirrel({
    name: STRINGS.name,
    authors: STRINGS.author,
    // todo: hoist this
    iconUrl: `https://stoat.chat/app/assets/icon-DUSNE-Pb.ico`,
    // todo: loadingGif
    setupIcon: `${ASSET_DIR}/icon.ico`,
    description: STRINGS.description,
    exe: `${STRINGS.execName}.exe`,
    setupExe: `${STRINGS.execName}-setup.exe`,
    copyright: "Copyright (C) 2025 Revolt Platforms LTD",
  }),
  new MakerZIP({}),
  new MakerDeb({
    options: {
      ...LINUX_PACKAGE_OPTIONS,
      section: "net",
      maintainer: "yPerfectBR",
      depends: ["libpipewire-0.3-0 | libpipewire-0.3-0t64"],
    },
  }),
  new MakerRpm({
    options: {
      ...LINUX_PACKAGE_OPTIONS,
      license: "AGPL-3.0",
    },
  }),
  new MakerFlatpak({
    options: {
      id: "io.github.yperfectbr.StoatHomelab",
      description: STRINGS.description,
      productName: STRINGS.name,
      productDescription: STRINGS.description,
      runtimeVersion: "25.08",
      base: "org.electronjs.Electron2.BaseApp",
      baseVersion: "25.08",
      icon: {
        "16x16": `${ASSET_DIR}/hicolor/16x16.png`,
        "32x32": `${ASSET_DIR}/hicolor/32x32.png`,
        "64x64": `${ASSET_DIR}/hicolor/64x64.png`,
        "128x128": `${ASSET_DIR}/hicolor/128x128.png`,
        "256x256": `${ASSET_DIR}/hicolor/256x256.png`,
        "512x512": `${ASSET_DIR}/hicolor/512x512.png`,
      } as unknown,
      categories: ["Network"],
      // open stoat:// links
      mimeType: ["x-scheme-handler/stoat"],
      modules: [
        // use the latest zypak -- Electron sandboxing for Flatpak
        {
          name: "zypak",
          sources: [
            {
              type: "git",
              url: "https://github.com/refi64/zypak",
              tag: "v2025.09",
            },
          ],
        },
      ],
      finishArgs: [
        // default arguments found by running
        // DEBUG=electron-installer-flatpak* pnpm make
        "--socket=fallback-x11",
        "--socket=wayland",
        "--share=ipc",
        "--share=network",
        "--device=dri",
        "--device=all",
        "--socket=pulseaudio",
        "--filesystem=xdg-run/pipewire-0",
        "--filesystem=xdg-videos:ro",
        "--filesystem=xdg-pictures:ro",
        "--filesystem=xdg-download",
        "--filesystem=xdg-run/speech-dispatcher",
        "--talk-name=org.freedesktop.ScreenSaver",
        "--talk-name=org.freedesktop.Notifications",
        "--talk-name=org.freedesktop.portal.Desktop",
        "--talk-name=org.kde.StatusNotifierWatcher",
        "--talk-name=com.canonical.AppMenu.Registrar",
        "--talk-name=com.canonical.indicator.application",
        "--talk-name=com.canonical.Unity",
        // self-updater: `flatpak-spawn --host flatpak install --bundle ...`
        "--talk-name=org.freedesktop.Flatpak",
        "--env=XCURSOR_PATH=/run/host/user-share/icons:/run/host/share/icons",
        "--env=ELECTRON_TRASH=gio",
        "--env=ELECTRON_OZONE_PLATFORM_HINT=auto",
      ],
      files: [],
    } as MakerFlatpakOptionsConfig,
  }),
];

const config: ForgeConfig = {
  packagerConfig: {
    asar: true,
    name: STRINGS.name,
    executableName: STRINGS.execName,
    // open stoat:// links (on mac)
    protocols: [{ name: STRINGS.name, schemes: ["stoat"] }],
    icon:
      process.platform === "darwin"
        ? `${ASSET_DIR}/icon.icon`
        : `${ASSET_DIR}/icon`,
    // extraResource: [
    //   // include all the asset files
    //   ...globSync(ASSET_DIR + "/**/*"),
    // ],
  },
  rebuildConfig: {},
  makers,
  hooks: {
    // Copy the node-pipewire dist to the app on linux
    packageAfterCopy: async (_config, buildPath, _version, platform) => {
      if (platform === "linux") {
        // Copy only the files we need to run the code, which is dist, LICENSE, and package.json
        fs.cpSync(
          "node_modules/node-pipewire/dist",
          path.join(buildPath, "node_modules/node-pipewire/dist"),
          { recursive: true },
        );
        fs.cpSync(
          "node_modules/node-pipewire/LICENSE",
          path.join(buildPath, "node_modules/node-pipewire/LICENSE"),
          { recursive: true },
        );
        fs.cpSync(
          "node_modules/node-pipewire/package.json",
          path.join(buildPath, "node_modules/node-pipewire/package.json"),
          { recursive: true },
        );
      }
    },
  },
  plugins: [
    {
      name: "@electron-forge/plugin-auto-unpack-natives",
      config: {},
    },
    new VitePlugin({
      // `build` can specify multiple entry builds, which can be Main process, Preload scripts, Worker process, etc.
      // If you are familiar with Vite configuration, it will look really familiar.
      build: [
        {
          // `entry` is just an alias for `build.lib.entry` in the corresponding file of `config`.
          entry: "src/main.ts",
          config: "vite.main.config.ts",
          target: "main",
        },
        {
          entry: "src/preload.ts",
          config: "vite.preload.config.ts",
          target: "preload",
        },
      ],
      renderer: [],
    }),
    // Fuses are used to enable/disable various Electron functionality
    // at package time, before code signing the application
    new FusesPlugin({
      version: FuseVersion.V1,
      [FuseV1Options.RunAsNode]: false,
      [FuseV1Options.EnableCookieEncryption]: true,
      [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
      [FuseV1Options.EnableNodeCliInspectArguments]: false,
      [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
      [FuseV1Options.OnlyLoadAppFromAsar]: true,
    }),
  ],
  publishers: [
    new PublisherGithub({
      repository: {
        owner: "yPerfectBR",
        name: "for-desktop",
      },
    }),
  ],
};

export default config;
