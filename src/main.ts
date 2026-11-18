import { readFileSync, readdirSync } from "fs";
import { join } from "path";
import fs from "node:fs";
import path from "node:path";
import { IUpdateInfo, updateElectronApp } from "update-electron-app";

import { BrowserWindow, Notification, app, shell } from "electron";
import started from "electron-squirrel-startup";

import { initAutoLaunch } from "./native/autoLaunch";
import { config } from "./native/config";
import {
  findDeepLink,
  initDeepLinks,
  openDeepLink,
  registerProtocol,
} from "./native/deepLink";
import { initDiscordRpc } from "./native/discordRpc";
import { initTray } from "./native/tray";
import { destroyVirtualMic, initVirtualMic } from "./native/virtualMic";
import { BUILD_URL, createMainWindow, mainWindow } from "./native/window";

// In Flatpak, we have to update the temp dir to a shared directory across host and sandbox;
// otherwise, the icon will not show up in the tray when using app indicators.
if (process.platform === "linux" && process.env.FLATPAK_ID) {
  const runtimeDir = process.env.XDG_RUNTIME_DIR;
  if (runtimeDir) {
    try {
      const sharedTmpDir = path.join(runtimeDir, "app", process.env.FLATPAK_ID);
      fs.mkdirSync(sharedTmpDir, { recursive: true });
      process.env.TMPDIR = sharedTmpDir;
    } catch (error) {
      console.error("Failed to set up host-visible TMPDIR:", error);
    }
  }
}

// Squirrel-specific logic
// create/remove shortcuts on Windows when installing / uninstalling
// we just need to close out of the app immediately
if (started) {
  app.quit();
}

// Linux screen share (Wayland + PipeWire / xdg-desktop-portal):
// Without WebRTCPipeWireCapturer, desktopCapturer only sees this process.
// Must run before app ready. Prefer native Wayland so capture is not XWayland.
if (process.platform === "linux") {
  app.commandLine.appendSwitch(
    "enable-features",
    [
      "WebRTCPipeWireCapturer",
      // Keep encode path healthy on Linux; avoids muddy/low-bitrate shares.
      "VaapiVideoEncoder",
      "VaapiVideoDecoder",
    ].join(","),
  );
  // Electron/Chromium Wayland + Vulkan is incompatible and can break capture.
  app.commandLine.appendSwitch("disable-features", "Vulkan");
  app.commandLine.appendSwitch("enable-usermedia-screen-capturing");

  const nvidiaOffload =
    process.env.__NV_PRIME_RENDER_OFFLOAD === "1" ||
    process.env.__GLX_VENDOR_LIBRARY_NAME === "nvidia";

  const onWayland =
    process.env.XDG_SESSION_TYPE === "wayland" || !!process.env.WAYLAND_DISPLAY;
  // Check argv, not app.commandLine: Electron injects --ozone-platform itself.
  const userPickedOzone = process.argv.some((a) =>
    a.startsWith("--ozone-platform"),
  );

  // Under PRIME offload, native Wayland renders on the NVIDIA GPU but the
  // compositor (on the iGPU) never presents those buffers: transparent,
  // empty window. XWayland handles the cross-GPU copy, so use X11 there.
  // The ozone platform is fixed before main.js runs (appendSwitch is too
  // late), so relaunch once with the switch on the real command line.
  if (onWayland && nvidiaOffload && !userPickedOzone) {
    app.relaunch({
      args: [...process.argv.slice(1), "--ozone-platform=x11"],
    });
    app.exit(0);
  } else if (onWayland && !userPickedOzone) {
    app.commandLine.appendSwitch("ozone-platform-hint", "auto");
  }

  // Hybrid Intel+NVIDIA: pin the GPU process to the render node that matches
  // the GL driver actually in use. On Wayland, Chromium otherwise defaults to
  // the compositor's node (the iGPU here).
  //  - Normal launch: compositor's primary device (WLR/AQ_DRM_DEVICES), so
  //    PipeWire DMA-BUFs from iGPU outputs import correctly.
  //  - NVIDIA PRIME offload (prime-run): EGL is forced to the NVIDIA driver;
  //    leaving the Intel node makes every SkSurface fail and the GPU process
  //    crash-loops until Chromium aborts (blank window). Use the NVIDIA node.
  if (!app.commandLine.hasSwitch("render-node-override")) {
    const renderNodeOf = (card: string) =>
      readdirSync(join("/sys/class/drm", card, "device", "drm")).find((n) =>
        n.startsWith("renderD"),
      );

    try {
      let card: string | undefined;
      if (nvidiaOffload) {
        card = readdirSync("/sys/class/drm")
          .filter((n) => /^card\d+$/.test(n))
          .find((n) => {
            try {
              return (
                readFileSync(
                  join("/sys/class/drm", n, "device", "vendor"),
                  "utf8",
                ).trim() === "0x10de"
              );
            } catch {
              return false;
            }
          });
      } else {
        card = (process.env.WLR_DRM_DEVICES || process.env.AQ_DRM_DEVICES || "")
          .split(":")
          .map((p) => p.trim())
          .find((p) => p.length > 0)
          ?.split("/")
          .pop(); // /dev/dri/card1 -> card1
      }

      const render = card && renderNodeOf(card);
      if (render) {
        app.commandLine.appendSwitch(
          "render-node-override",
          `/dev/dri/${render}`,
        );
      }
    } catch {
      // Best-effort; sysfs/compositor env may be unavailable.
    }
  }
}

// Prefer GPU rendering; still honour the config toggle that disables it.
if (config.hardwareAcceleration) {
  app.commandLine.appendSwitch("ignore-gpu-blocklist");
  app.commandLine.appendSwitch("enable-gpu-rasterization");
  // NOTE: do NOT enable-zero-copy on Linux hybrid GPUs — DMA-BUF zero-copy
  // across Intel/NVIDIA is a common cause of solid-black screen shares.
  if (process.platform !== "linux") {
    app.commandLine.appendSwitch("enable-zero-copy");
  }
} else {
  app.disableHardwareAcceleration();
}

// ensure only one copy of the application can run
const acquiredLock = app.requestSingleInstanceLock();

const onNotifyUser = (_info: IUpdateInfo) => {
  const notification = new Notification({
    title: "Update Available",
    body: "Restart the app to install the update.",
    silent: true,
  });

  notification.show();
};

if (acquiredLock) {
  // start auto update logic
  // Only use the official updater when targeting the official Stoat host.
  if (BUILD_URL.hostname === "stoat.chat") updateElectronApp({ onNotifyUser });

  // facilitate stoat:// links
  registerProtocol();

  // necessary macOS glue
  let pendingDeepLink = findDeepLink(process.argv);
  app.on("open-url", (event, url) => {
    event.preventDefault();
    // openDeepLink recreates the window if macOS closed it
    if (app.isReady()) {
      openDeepLink(url);
    } else {
      pendingDeepLink = url;
    }
  });

  // create and configure the app when electron is ready
  app.on("ready", () => {
    // create window and application contexts
    initDeepLinks();
    createMainWindow();

    // save first launch state
    if (config.firstLaunch) {
      // Doesn't do anything right now. Used to enable auto start, but that behaviour was removed.
      // Left in case it gets used in the future.
      config.firstLaunch = false;
    }

    initTray();
    initDiscordRpc();
    initVirtualMic();
    initAutoLaunch();

    // follow the link the app was started with; after the tray exists, as
    // showing the window updates the tray menu
    if (pendingDeepLink) {
      openDeepLink(pendingDeepLink);
      pendingDeepLink = undefined;
    }

    // Windows specific fix for notifications
    if (process.platform === "win32") {
      app.setAppUserModelId("io.github.yperfectbr.StoatHomelab");
    }
  });

  // Focus the window if we try to launch again, following any stoat:// link
  // it was launched with (Windows and Linux)
  app.on("second-instance", (_event, argv) => {
    const link = findDeepLink(argv);
    if (link) {
      openDeepLink(link);
      return;
    }

    mainWindow.show();
    mainWindow.restore();
    mainWindow.focus();
  });

  // macOS specific behaviour to keep app active in dock:
  // (irrespective of the minimise-to-tray option)

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") {
      app.quit();
    }
  });

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow();
    } else {
      mainWindow.show();
      mainWindow.focus();
    }
  });

  // ensure URLs launch in external context
  app.on("web-contents-created", (_, contents) => {
    // prevent navigation out of build URL origin
    contents.on("will-navigate", (event, navigationUrl) => {
      if (new URL(navigationUrl).origin !== BUILD_URL.origin) {
        event.preventDefault();
      }
    });

    // handle links externally
    contents.setWindowOpenHandler(({ url }) => {
      if (
        url.startsWith("http:") ||
        url.startsWith("https:") ||
        url.startsWith("mailto:")
      ) {
        setImmediate(() => {
          shell.openExternal(url);
        });
      }

      return { action: "deny" };
    });
  });

  let readyToQuit = false;
  app.on("will-quit", (e) => {
    if (readyToQuit) return;
    e.preventDefault();
    destroyVirtualMic().finally(() => {
      readyToQuit = true;
      app.quit();
    });
  });
} else {
  app.quit();
}
