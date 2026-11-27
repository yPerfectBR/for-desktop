import { BrowserWindow, nativeImage } from "electron";

import windowIconAsset from "../../assets/desktop/icon.png?asset";

import { mainWindow } from "./window";

/**
 * Small HTML message box.
 *
 * Electron's native dialog.showMessageBox (GTK) silently fails to appear on
 * some Wayland compositors, so updater prompts use a tiny window of our own,
 * which renders the same on Windows and every Linux desktop.
 */

export interface PromptOptions {
  title: string;
  message: string;
  detail?: string;
  buttons: string[];
  /** button index used when the window is closed */
  cancelId: number;
  type?: "info" | "error";
}

function escapeHtml(text: string) {
  return text.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );
}

function render(options: PromptOptions) {
  const buttons = options.buttons
    .map(
      (label, idx) =>
        `<button class="${idx === 0 ? "primary" : ""}" data-idx="${idx}">${escapeHtml(label)}</button>`,
    )
    .join("");

  return `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<title>${escapeHtml(options.title)}</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  html, body { height: 100%; }
  body {
    margin: 0; display: flex; flex-direction: column;
    background: #1f1f1f; color: #e8e8e8;
    font: 14px/1.5 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  }
  header { display: flex; gap: 12px; align-items: center; padding: 20px 22px 8px; }
  .icon { font-size: 26px; }
  h1 { font-size: 17px; margin: 0; }
  .detail {
    flex: 1; overflow: auto; margin: 0 22px; padding: 4px 0 12px;
    white-space: pre-wrap; color: #c4c4c4;
  }
  footer {
    display: flex; gap: 10px; justify-content: flex-end; flex-wrap: wrap;
    padding: 14px 22px; border-top: 1px solid #2e2e2e; background: #1a1a1a;
  }
  button {
    cursor: pointer; border-radius: 9px; padding: 8px 16px; font: inherit;
    border: 1px solid #3a3a3a; background: #2a2a2a; color: #e8e8e8;
  }
  button.primary { background: #4f8cff; border-color: #4f8cff; color: #fff; font-weight: 600; }
  button:focus-visible { outline: 2px solid #9bbcff; outline-offset: 2px; }
</style>
</head>
<body>
  <header>
    <div class="icon">${options.type === "error" ? "⚠️" : "⬆️"}</div>
    <h1>${escapeHtml(options.message)}</h1>
  </header>
  <div class="detail">${escapeHtml(options.detail ?? "")}</div>
  <footer>${buttons}</footer>
<script>
  for (const b of document.querySelectorAll("button")) {
    b.addEventListener("click", () => { document.title = "choice:" + b.dataset.idx; });
  }
  document.querySelector("button.primary")?.focus();
  addEventListener("keydown", (e) => {
    if (e.key === "Escape") document.title = "choice:${options.cancelId}";
  });
</script>
</body>
</html>`;
}

/**
 * Show the prompt and resolve with the index of the clicked button.
 */
export function showPrompt(options: PromptOptions): Promise<number> {
  return new Promise((resolve) => {
    const parent =
      mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible()
        ? mainWindow
        : undefined;

    const win = new BrowserWindow({
      width: 480,
      height: options.detail && options.detail.length > 200 ? 460 : 260,
      minWidth: 360,
      minHeight: 200,
      title: options.title,
      parent,
      modal: false,
      show: false,
      resizable: true,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      autoHideMenuBar: true,
      backgroundColor: "#1f1f1f",
      icon: nativeImage.createFromDataURL(windowIconAsset),
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    win.setMenu(null);

    let settled = false;
    const finish = (idx: number) => {
      if (settled) return;
      settled = true;
      resolve(idx);
      if (!win.isDestroyed()) win.close();
    };

    win.webContents.on("page-title-updated", (event, title) => {
      const match = /^choice:(\d+)$/.exec(title);
      if (match) {
        event.preventDefault();
        finish(Number(match[1]));
      }
    });
    // links / navigation are not expected in the prompt
    win.webContents.on("will-navigate", (event) => event.preventDefault());
    win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));

    win.on("closed", () => finish(options.cancelId));
    win.once("ready-to-show", () => {
      win.show();
      win.focus();
    });

    void win.loadURL(
      "data:text/html;charset=utf-8," + encodeURIComponent(render(options)),
    );
  });
}
