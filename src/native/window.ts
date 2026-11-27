import { join } from "node:path";

import {
  BrowserWindow,
  Menu,
  MenuItem,
  app,
  autoUpdater,
  desktopCapturer,
  ipcMain,
  nativeImage,
  session,
} from "electron";

import windowIconAsset from "../../assets/desktop/icon.png?asset";

import { config } from "./config";
import {
  clearOfflineState,
  isServerReachable,
  showOfflinePage,
} from "./offline";
import { updateTrayMenu } from "./tray";
import { startVirtualMic } from "./virtualMic";

// global reference to main window
export let mainWindow: BrowserWindow;

// currently in-use build
export const BUILD_URL = new URL(
  app.commandLine.hasSwitch("force-server")
    ? app.commandLine.getSwitchValue("force-server")
    : /*MAIN_WINDOW_VITE_DEV_SERVER_URL ??*/ "https://homelab.tail9c15a4.ts.net:8888",
);

// internal window state
let shouldQuit = false;

// load the window icon
const windowIcon = nativeImage.createFromDataURL(windowIconAsset);

// windowIcon.setTemplateImage(true);

/**
 * Create the main application window
 */
export function createMainWindow() {
  // (CLI arg --hidden or config)
  const startHidden =
    app.commandLine.hasSwitch("hidden") || config.startMinimisedToTray;
  const isMacOS = process.platform === "darwin";

  // create the window
  mainWindow = new BrowserWindow({
    minWidth: 300,
    minHeight: 300,
    width: 1280,
    height: 720,
    backgroundColor: "#191919",
    frame: isMacOS ? true : !config.customFrame,
    titleBarStyle: isMacOS ? "hidden" : "default",
    trafficLightPosition: isMacOS ? { x: 8, y: 8 } : undefined,
    icon: windowIcon,
    show: !startHidden,
    webPreferences: {
      // relative to `.vite/build`
      preload: join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: true,
    },
  });

  // hide the options
  mainWindow.setMenu(null);

  // restore last position if it was moved previously
  if (config.windowState.x > 0 || config.windowState.y > 0) {
    mainWindow.setPosition(
      config.windowState.x ?? 0,
      config.windowState.y ?? 0,
    );
  }

  // restore last size if it was resized previously
  if (config.windowState.width > 0 && config.windowState.height > 0) {
    mainWindow.setSize(
      config.windowState.width ?? 1280,
      config.windowState.height ?? 720,
    );
  }

  // maximise the window if it was maximised before
  if (config.windowState.isMaximised && !startHidden) {
    mainWindow.maximize();
  }

  // The web frontend is hosted independently from the desktop shell and can
  // be updated without a new desktop release. Clear transient Chromium data
  // before navigation so an old Service Worker or cached bundle cannot pin
  // the client to an outdated frontend.
  async function loadEntrypoint() {
    const webSession = mainWindow.webContents.session;

    try {
      await webSession.clearStorageData({
        origin: BUILD_URL.origin,
        storages: ["serviceworkers", "cachestorage"],
      });

      await webSession.clearCache();
      await webSession.clearCodeCaches({});
    } catch (error) {
      console.warn("Failed to clear Stoat web caches", error);
    }

    // Off the homelab VPN the server is unreachable and Chromium would just
    // leave an empty window; explain what to check instead.
    if (!(await isServerReachable(BUILD_URL))) {
      showOffline("O servidor não respondeu a tempo (timeout / sem rota).");
      return;
    }

    try {
      await mainWindow.loadURL(BUILD_URL.toString());
      mainWindow.webContents.reload();
    } catch {
      // did-fail-load already switched to the offline page
    }
  }

  function showOffline(reason: string) {
    showOfflinePage(mainWindow, BUILD_URL, reason, () => void loadEntrypoint());
  }

  // Main frame of the homelab frontend failed (VPN dropped before/while
  // loading, DNS not resolving, TLS failure...).
  mainWindow.webContents.on(
    "did-fail-load",
    (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
      // -3 = ERR_ABORTED (navigation replaced, e.g. by reload)
      if (!isMainFrame || errorCode === -3) return;
      try {
        if (new URL(validatedURL).origin !== BUILD_URL.origin) return;
      } catch {
        return;
      }
      showOffline(`${errorDescription} (${errorCode}) — ${validatedURL}`);
    },
  );

  mainWindow.webContents.on("did-navigate", (_event, url) => {
    if (url.startsWith(BUILD_URL.origin)) clearOfflineState();
  });

  void loadEntrypoint();

  // minimise window to tray
  mainWindow.on("close", (event) => {
    if (!shouldQuit && config.minimiseToTray) {
      event.preventDefault();
      mainWindow.hide();
    }
  });

  // update tray menu when window is shown/hidden
  mainWindow.on("show", updateTrayMenu);
  mainWindow.on("hide", updateTrayMenu);

  // keep track of window state
  function generateState() {
    config.windowState = {
      x: mainWindow.getPosition()[0],
      y: mainWindow.getPosition()[1],
      width: mainWindow.getSize()[0],
      height: mainWindow.getSize()[1],
      isMaximised: mainWindow.isMaximized(),
    };
  }

  mainWindow.on("maximize", generateState);
  mainWindow.on("unmaximize", generateState);
  mainWindow.on("moved", generateState);
  mainWindow.on("resized", generateState);

  // rebind zoom controls to be more sensible
  mainWindow.webContents.on("before-input-event", (event, input) => {
    if (input.control && (input.key === "=" || input.key === "+")) {
      // zoom in (+)
      event.preventDefault();
      mainWindow.webContents.setZoomLevel(
        mainWindow.webContents.getZoomLevel() + 1,
      );
    } else if (input.control && input.key === "-") {
      // zoom out (-)
      event.preventDefault();
      mainWindow.webContents.setZoomLevel(
        mainWindow.webContents.getZoomLevel() - 1,
      );
    } else if (input.control && input.key === "0") {
      // reset zoom to default.
      event.preventDefault();
      mainWindow.webContents.setZoomLevel(0);
    } else if (
      input.key === "F5" ||
      ((input.control || input.meta) && input.key.toLowerCase() === "r")
    ) {
      event.preventDefault();
      mainWindow.webContents.reload();
    }
  });

  // send the config
  mainWindow.webContents.on("did-finish-load", () => config.sync());

  // configure spellchecker context menu
  mainWindow.webContents.on("context-menu", (_, params) => {
    const menu = new Menu();

    // add all suggestions
    for (const suggestion of params.dictionarySuggestions) {
      menu.append(
        new MenuItem({
          label: suggestion,
          click: () => mainWindow.webContents.replaceMisspelling(suggestion),
        }),
      );
    }

    // allow users to add the misspelled word to the dictionary
    if (params.misspelledWord) {
      menu.append(
        new MenuItem({
          label: "Add to dictionary",
          click: () =>
            mainWindow.webContents.session.addWordToSpellCheckerDictionary(
              params.misspelledWord,
            ),
        }),
      );
    }

    // add an option to toggle spellchecker
    menu.append(
      new MenuItem({
        label: "Toggle spellcheck",
        click() {
          config.spellchecker = !config.spellchecker;
        },
      }),
    );

    // show menu if we've generated enough entries
    if (menu.items.length > 0) {
      menu.popup();
    }
  });

  // Screen share / display media
  //
  // Linux Wayland + PipeWire: desktopCapturer.getSources() opens the
  // xdg-desktop-portal picker and resolves with exactly one source (whatever
  // the user picked). Calling getSources without WebRTCPipeWireCapturer only
  // enumerates this app — which is why Stoat alone used to appear.
  //
  // X11 / Windows / macOS: keep the in-app picker with thumbnails.
  session.defaultSession.setDisplayMediaRequestHandler(
    (request, originalCallback) => {
      // Start the virtual mic (upstream) before handing streams back.
      const callback = async (streams: Electron.Streams) => {
        try {
          if (streams.video) await startVirtualMic();
        } catch (e) {
          console.error("Virtual mic setup error", e);
        } finally {
          originalCallback(streams);
        }
      };
      const isWayland =
        process.platform === "linux" &&
        (process.env.XDG_SESSION_TYPE === "wayland" ||
          !!process.env.WAYLAND_DISPLAY);

      const grant = (source: Electron.DesktopCapturerSource) => {
        if (request.audioRequested) {
          callback({ video: source, audio: "loopback" });
        } else {
          callback({ video: source });
        }
      };

      // High thumbnail size keeps portal/in-app previews sharp; PipeWire still
      // delivers the full selected output (incl. non-NVIDIA DRM heads).
      const capturerOpts: Electron.SourcesOptions = {
        types: ["screen", "window"],
        thumbnailSize: { width: 1920, height: 1080 },
      };

      if (isWayland) {
        desktopCapturer
          .getSources(capturerOpts)
          .then((sources) => {
            if (!sources.length) {
              callback({});
              return;
            }
            grant(sources[0]);
          })
          .catch((err) => {
            console.error("Wayland screen share: portal selection failed", err);
            // Portal cancelled: settle without starting the virtual mic.
            originalCallback(null);
          });
        return;
      }

      desktopCapturer
        .getSources({ ...capturerOpts, fetchWindowIcons: true })
        .then((sources) => {
          if (sources.length === 1) {
            grant(sources[0]);
            return;
          }

          ipcMain.once(
            "screenPickerCallback",
            (_, idx: number, audio: boolean) => {
              if (idx < 0 || idx >= sources.length) {
                callback({});
              } else if (audio) {
                callback({
                  video: sources[idx],
                  audio: "loopback",
                });
              } else {
                callback({
                  video: sources[idx],
                });
              }
            },
          );
          mainWindow.webContents.send(
            "screenPicker",
            sources.map((source, idx) => {
              const image = source.appIcon;
              if (image) {
                if (image.getAspectRatio() > 1) {
                  image.resize({ width: 256 });
                } else {
                  image.resize({ height: 256 });
                }
              }
              return {
                idx: idx,
                name: source.name,
                isFullScreen: source.id.startsWith("screen"),
                image: image?.toDataURL(),
              };
            }),
          );
        })
        .catch((err) => {
          console.error("Screen share: failed to list sources", err);
          originalCallback(null);
        });
    },
    // Experimental: native picker on macOS 15+. Harmless elsewhere; Wayland
    // still uses the PipeWire/portal path above when the system picker is N/A.
    { useSystemPicker: true },
  );

  // mainWindow.webContents.openDevTools();

  // let i = 0;
  // setInterval(() => setBadgeCount((++i % 30) + 1), 1000);
}

// Push world events to the window
//
// The window can in theory be recreated, and this is done in practice on macOS,
// so this is registered app-wide
ipcMain.on("minimise", () => mainWindow?.minimize());
ipcMain.on("maximise", () =>
  mainWindow?.isMaximized() ? mainWindow.unmaximize() : mainWindow?.maximize(),
);
ipcMain.on("close", () => mainWindow?.close());

/**
 * Quit the entire app
 */
export function quitApp() {
  shouldQuit = true;
  mainWindow.close();
}

// Ensure global app quit works properly
app.on("before-quit", () => {
  shouldQuit = true;
});

// Squirrel (Windows) closes every window before installing an update; don't
// let minimise-to-tray swallow that close.
autoUpdater.on("before-quit-for-update", () => {
  shouldQuit = true;
});
