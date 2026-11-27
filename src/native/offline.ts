import { BrowserWindow, ipcMain, net } from "electron";

/**
 * "Can't reach the homelab" screen.
 *
 * The web frontend lives on the homelab server, which is only reachable
 * through the homelab VPN (Tailscale). Without it, Chromium just fails the
 * main-frame load and the window stays an empty dark rectangle. Instead,
 * show a local page telling the user to check the VPN, and keep retrying in
 * the background so the app recovers on its own once the VPN is back.
 */

const PROBE_TIMEOUT_MS = 8_000;
const RETRY_INTERVAL_MS = 10_000;

let retryTimer: NodeJS.Timeout | undefined;
let probing = false;
let offlineWindow: BrowserWindow | undefined;
let reconnect: (() => void) | undefined;
let currentServerUrl: URL | undefined;

// "Tentar novamente" button on the offline page (exposed through preload)
ipcMain.on("retryConnection", () => {
  if (currentServerUrl) void probe(currentServerUrl, true);
});

/**
 * Whether the server answers at all (any HTTP status counts as reachable).
 */
export async function isServerReachable(url: URL): Promise<boolean> {
  try {
    await net.fetch(url.toString(), {
      method: "HEAD",
      cache: "no-store",
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    return true;
  } catch {
    return false;
  }
}

export function isShowingOfflinePage() {
  return offlineWindow !== undefined;
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

function renderPage(serverUrl: URL, reason: string) {
  const host = escapeHtml(serverUrl.host);
  const detail = escapeHtml(reason);

  return `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<title>Stoat Homelab — sem conexão</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0; min-height: 100vh; display: grid; place-items: center;
    background: #191919; color: #e8e8e8;
    font: 15px/1.5 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    -webkit-app-region: drag; user-select: none;
  }
  main {
    width: min(520px, calc(100vw - 32px)); padding: 32px;
    background: #222; border: 1px solid #333; border-radius: 16px;
  }
  .icon { font-size: 40px; line-height: 1; }
  h1 { font-size: 20px; margin: 16px 0 8px; }
  p { margin: 0 0 12px; color: #bdbdbd; }
  ol { margin: 0 0 20px; padding-left: 20px; color: #d6d6d6; }
  li { margin: 6px 0; }
  code { background: #2e2e2e; padding: 1px 6px; border-radius: 6px; }
  .row { display: flex; gap: 12px; align-items: center; flex-wrap: wrap; }
  button {
    -webkit-app-region: no-drag; cursor: pointer;
    background: #4f8cff; color: #fff; border: 0; border-radius: 10px;
    padding: 10px 18px; font: inherit; font-weight: 600;
  }
  button:disabled { opacity: .6; cursor: progress; }
  #status { color: #9a9a9a; font-size: 13px; }
  details { margin-top: 20px; color: #8a8a8a; font-size: 12px; -webkit-app-region: no-drag; }
</style>
</head>
<body>
<main>
  <div class="icon">🔌</div>
  <h1>Não foi possível conectar ao Stoat Homelab</h1>
  <p>O servidor <code>${host}</code> não respondeu. O Stoat Homelab só funciona
  quando você está conectado à <strong>VPN do homelab</strong> (Tailscale).</p>
  <ol>
    <li>Confira se o <strong>Tailscale</strong> está instalado e logado na conta do homelab.</li>
    <li>Confira se a VPN está <strong>ligada</strong> (status <em>Connected</em>).</li>
    <li>Depois clique em <strong>Tentar novamente</strong>.</li>
  </ol>
  <div class="row">
    <button id="retry">Tentar novamente</button>
    <span id="status">Tentando de novo automaticamente a cada ${RETRY_INTERVAL_MS / 1000}s…</span>
  </div>
  <details><summary>Detalhes técnicos</summary>${detail}</details>
</main>
<script>
  const btn = document.getElementById("retry");
  const status = document.getElementById("status");
  window.setOfflineStatus = (text, busy) => {
    status.textContent = text;
    btn.disabled = !!busy;
  };
  btn.addEventListener("click", () => {
    window.setOfflineStatus("Conectando…", true);
    window.native?.retryConnection?.();
  });
</script>
</body>
</html>`;
}

function setStatus(text: string, busy: boolean) {
  offlineWindow?.webContents
    .executeJavaScript(
      `window.setOfflineStatus?.(${JSON.stringify(text)}, ${busy})`,
    )
    .catch(() => {});
}

async function probe(serverUrl: URL, manual = false) {
  if (probing || !offlineWindow) return;
  probing = true;
  if (manual) setStatus("Conectando…", true);

  const ok = await isServerReachable(serverUrl);
  probing = false;
  if (!offlineWindow) return;

  if (ok) {
    stopRetrying();
    reconnect?.();
  } else {
    const time = new Date().toLocaleTimeString("pt-BR");
    setStatus(
      `Ainda sem conexão (última tentativa ${time}). Tentando de novo a cada ${RETRY_INTERVAL_MS / 1000}s…`,
      false,
    );
  }
}

function stopRetrying() {
  if (retryTimer) clearInterval(retryTimer);
  retryTimer = undefined;
  offlineWindow = undefined;
}

/**
 * Replace the window contents with the offline page and poll the server
 * until it is reachable again, then call `onReconnect`.
 */
export function showOfflinePage(
  window: BrowserWindow,
  serverUrl: URL,
  reason: string,
  onReconnect: () => void,
) {
  if (window.isDestroyed()) return;

  stopRetrying();
  offlineWindow = window;
  reconnect = onReconnect;
  currentServerUrl = serverUrl;

  void window.loadURL(
    "data:text/html;charset=utf-8," +
      encodeURIComponent(renderPage(serverUrl, reason)),
  );

  retryTimer = setInterval(() => void probe(serverUrl), RETRY_INTERVAL_MS);

  window.once("closed", stopRetrying);
}

/**
 * Called once the real frontend loaded fine.
 */
export function clearOfflineState() {
  stopRetrying();
}
