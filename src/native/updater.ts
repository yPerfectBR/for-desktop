import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as WebReadableStream } from "node:stream/web";

import {
  MenuItemConstructorOptions,
  Notification,
  app,
  autoUpdater,
  net,
  shell,
} from "electron";

import { showPrompt } from "./prompt";
import { updateTrayMenu } from "./tray";
import { mainWindow, quitApp } from "./window";

/**
 * Homelab self-updater.
 *
 * Watches the latest GitHub release of our fork and offers a one-click
 * update. How the update is applied depends on how the app was installed:
 *
 *  - Windows (Squirrel installer): Electron autoUpdater fed from the release
 *  - AppImage: download the new AppImage and swap the file in place
 *  - Flatpak (bundle): `flatpak install --bundle` on the host
 *  - .deb / .rpm / Arch package: install through the package manager (pkexec)
 *  - tar.gz (e.g. /opt): extract and swap the install directory
 *  - anything else (Windows zip, macOS, dev): open the release page
 */

const REPO = "yPerfectBR/for-desktop";
const RELEASES_API = `https://api.github.com/repos/${REPO}/releases/latest`;
const RELEASES_PAGE = `https://github.com/${REPO}/releases/latest`;
const FIRST_CHECK_DELAY_MS = 15_000;
const CHECK_INTERVAL_MS = 30 * 60 * 1000;
const PRODUCT = "Stoat Homelab";

type InstallKind =
  | "squirrel"
  | "appimage"
  | "flatpak"
  | "deb"
  | "rpm"
  | "pacman"
  | "tarball"
  | "manual";

interface ReleaseAsset {
  name: string;
  browser_download_url: string;
  size: number;
}

interface Release {
  tag_name: string;
  html_url: string;
  body?: string;
  assets: ReleaseAsset[];
}

type Status =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "available"; release: Release; version: string }
  | { kind: "downloading"; version: string; progress: number }
  | { kind: "installing"; version: string }
  | { kind: "error"; message: string };

let status: Status = { kind: "idle" };
let promptedVersion: string | undefined;
let installKind: InstallKind | undefined;

function setStatus(next: Status) {
  status = next;
  try {
    updateTrayMenu();
  } catch {
    // tray not ready yet
  }
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.setProgressBar(
      next.kind === "downloading"
        ? Math.max(0.01, next.progress)
        : next.kind === "installing"
          ? 2 // indeterminate
          : -1,
    );
  }
}

/**
 * "homelab-v1.2.3" / "v1.2.3" / "1.2.3-preview.1" -> [1, 2, 3]
 */
function parseVersion(tag: string): number[] {
  const core = tag.replace(/^[^0-9]*/, "").split(/[-+]/)[0];
  return core.split(".").map((n) => parseInt(n, 10) || 0);
}

export function isNewer(candidate: string, current: string) {
  const a = parseVersion(candidate);
  const b = parseVersion(current);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0);
    if (diff !== 0) return diff > 0;
  }
  return false;
}

function commandSucceeds(cmd: string, args: string[]) {
  try {
    return (
      spawnSync(cmd, args, { stdio: "ignore", timeout: 10_000 }).status === 0
    );
  } catch {
    return false;
  }
}

function detectInstallKind(): InstallKind {
  if (!app.isPackaged) return "manual";

  if (process.platform === "win32") {
    const updateExe = path.resolve(
      path.dirname(process.execPath),
      "..",
      "Update.exe",
    );
    return fs.existsSync(updateExe) ? "squirrel" : "manual";
  }

  if (process.platform !== "linux") return "manual";
  if (process.env.APPIMAGE) return "appimage";
  if (process.env.FLATPAK_ID) return "flatpak";

  const exe = process.execPath;
  if (commandSucceeds("pacman", ["-Qqo", exe])) return "pacman";
  if (commandSucceeds("dpkg", ["-S", exe])) return "deb";
  if (commandSucceeds("rpm", ["-qf", exe])) return "rpm";
  return "tarball";
}

function getInstallKind() {
  installKind ??= detectInstallKind();
  return installKind;
}

const ASSET_MATCHERS: Partial<Record<InstallKind, (name: string) => boolean>> =
  {
    appimage: (n) => n.endsWith(".AppImage"),
    flatpak: (n) => n.endsWith(".flatpak"),
    deb: (n) => n.endsWith(".deb"),
    rpm: (n) => n.endsWith(".rpm"),
    pacman: (n) => n.endsWith(".pkg.tar.zst"),
    tarball: (n) => /linux-x64\.tar\.gz$/.test(n),
  };

function findAsset(release: Release, kind: InstallKind) {
  const match = ASSET_MATCHERS[kind];
  return match ? release.assets.find((a) => match(a.name)) : undefined;
}

function canSelfUpdate(release: Release) {
  const kind = getInstallKind();
  if (kind === "manual") return false;
  if (kind === "squirrel") {
    return release.assets.some((a) => a.name === "RELEASES");
  }
  return !!findAsset(release, kind);
}

async function fetchLatestRelease(): Promise<Release> {
  const res = await net.fetch(RELEASES_API, {
    headers: {
      Accept: "application/vnd.github+json",
      "User-Agent": "StoatHomelab-Desktop-Updater",
    },
    cache: "no-store",
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`GitHub API respondeu ${res.status}`);
  return (await res.json()) as Release;
}

/**
 * Check GitHub for a newer release.
 * @param interactive user asked for it: report "up to date" / errors too
 */
export async function checkForUpdates(interactive = false) {
  if (
    status.kind === "checking" ||
    status.kind === "downloading" ||
    status.kind === "installing"
  ) {
    return;
  }

  const previous = status;
  setStatus({ kind: "checking" });

  let release: Release;
  try {
    release = await fetchLatestRelease();
  } catch (err) {
    console.warn("[updater] check failed:", err);
    setStatus(previous.kind === "available" ? previous : { kind: "idle" });
    if (interactive) {
      void showBox({
        type: "error",
        title: PRODUCT,
        message: "Não foi possível procurar atualizações.",
        detail: String(err),
      });
    }
    return;
  }

  const latest = release.tag_name.replace(/^[^0-9]*/, "");
  const current = app.getVersion();
  console.info(
    `[updater] installed v${current}, latest ${release.tag_name} (${getInstallKind()})`,
  );

  if (!isNewer(latest, current)) {
    setStatus({ kind: "idle" });
    if (interactive) {
      void showBox({
        type: "info",
        title: PRODUCT,
        message: "Você já está na versão mais recente.",
        detail: `Versão instalada: v${current}`,
      });
    }
    return;
  }

  setStatus({ kind: "available", release, version: latest });

  if (interactive || promptedVersion !== latest) {
    promptedVersion = latest;
    try {
      notifyAvailable(latest);
    } catch (err) {
      console.warn("[updater] notification failed:", err);
    }
    promptUpdate().catch((err) =>
      console.error("[updater] prompt failed:", err),
    );
  }
}

function notifyAvailable(version: string) {
  if (!Notification.isSupported()) return;
  const notification = new Notification({
    title: "Atualização disponível",
    body: `${PRODUCT} v${version} está disponível. Clique para atualizar.`,
  });
  notification.on("click", () => {
    mainWindow?.show();
    void promptUpdate();
  });
  notification.show();
}

/**
 * Updater message box (see prompt.ts for why it isn't a native dialog).
 */
async function showBox(options: {
  type: "info" | "error";
  title: string;
  message: string;
  detail?: string;
  buttons?: string[];
  cancelId?: number;
}) {
  const buttons = options.buttons ?? ["OK"];
  const response = await showPrompt({
    ...options,
    buttons,
    cancelId: options.cancelId ?? buttons.length - 1,
  });
  return { response };
}

let prompting = false;

/**
 * Ask the user whether to update now.
 */
export async function promptUpdate() {
  if (status.kind !== "available" || prompting) return;
  const { release, version } = status;
  const selfUpdate = canSelfUpdate(release);

  const notes = (release.body ?? "").trim();
  const shortNotes =
    notes.length > 900 ? `${notes.slice(0, 900).trimEnd()}…` : notes;

  const buttons = selfUpdate
    ? ["Atualizar agora", "Depois", "Ver novidades"]
    : ["Baixar atualização", "Depois"];

  prompting = true;
  const { response } = await showBox({
    type: "info",
    title: `${PRODUCT} — atualização`,
    message: `Nova versão disponível: v${version}`,
    detail:
      `Você está na v${app.getVersion()}.` +
      (selfUpdate
        ? " O app vai baixar, instalar e reiniciar sozinho."
        : " Esta instalação não pode se atualizar sozinha; a página de download será aberta.") +
      (shortNotes ? `\n\nNovidades:\n${shortNotes}` : ""),
    buttons,
    cancelId: 1,
  }).finally(() => (prompting = false));

  if (response === 0) {
    if (selfUpdate) {
      void installUpdate();
    } else {
      void shell.openExternal(release.html_url || RELEASES_PAGE);
    }
  } else if (response === 2) {
    void shell.openExternal(release.html_url || RELEASES_PAGE);
  }
}

async function download(asset: ReleaseAsset, dest: string, version: string) {
  const res = await net.fetch(asset.browser_download_url, {
    headers: { "User-Agent": "StoatHomelab-Desktop-Updater" },
  });
  if (!res.ok || !res.body) {
    throw new Error(`Download falhou (${res.status}) — ${asset.name}`);
  }

  const total = Number(res.headers.get("content-length")) || asset.size || 0;
  let received = 0;
  let lastReport = 0;

  const body = Readable.fromWeb(res.body as unknown as WebReadableStream);
  body.on("data", (chunk: Buffer) => {
    received += chunk.length;
    const now = Date.now();
    if (total && now - lastReport > 250) {
      lastReport = now;
      setStatus({ kind: "downloading", version, progress: received / total });
    }
  });

  await pipeline(body, fs.createWriteStream(dest));
}

function run(cmd: string, args: string[]) {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr?.on("data", (d) => (stderr += d.toString()));
    child.on("error", reject);
    child.on("exit", (code) =>
      code === 0
        ? resolve()
        : reject(
            new Error(
              `${cmd} terminou com código ${code}${stderr ? `:\n${stderr.trim().slice(-800)}` : ""}`,
            ),
          ),
    );
  });
}

function isWritable(dir: string) {
  try {
    fs.accessSync(dir, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/** Run a shell script, as root through polkit when `elevate` is set. */
function runScript(script: string, args: string[], elevate: boolean) {
  return elevate
    ? run("pkexec", ["/bin/sh", "-c", script, "sh", ...args])
    : run("/bin/sh", ["-c", script, "sh", ...args]);
}

function relaunchAndQuit(execPath?: string) {
  app.relaunch(
    execPath ? { execPath, args: process.argv.slice(1) } : undefined,
  );
  quitApp();
  // quitApp only closes the window; make sure we actually exit
  setTimeout(() => app.quit(), 500);
}

function installSquirrel(release: Release) {
  return new Promise<void>((resolve, reject) => {
    const feed = `https://github.com/${REPO}/releases/download/${release.tag_name}`;
    autoUpdater.removeAllListeners("update-downloaded");
    autoUpdater.removeAllListeners("error");
    autoUpdater.once("update-downloaded", () => {
      resolve();
      autoUpdater.quitAndInstall();
    });
    autoUpdater.once("error", (err) => reject(err));
    autoUpdater.setFeedURL({ url: feed });
    autoUpdater.checkForUpdates();
  });
}

/**
 * Download and apply the pending update, then restart.
 */
export async function installUpdate() {
  if (status.kind !== "available") return;
  const { release, version } = status;
  const kind = getInstallKind();

  try {
    if (kind === "squirrel") {
      // Squirrel downloads on its own; no byte progress available
      setStatus({ kind: "installing", version });
      await installSquirrel(release);
      return;
    }

    const asset = findAsset(release, kind);
    if (!asset) throw new Error("Nenhum arquivo compatível nesta release.");

    // Flatpak: TMPDIR points at a host-visible dir (see main.ts)
    const workDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "stoat-homelab-update-"),
    );
    const file = path.join(workDir, asset.name);

    setStatus({ kind: "downloading", version, progress: 0 });
    await download(asset, file, version);
    setStatus({ kind: "installing", version });

    switch (kind) {
      case "appimage": {
        const target = process.env.APPIMAGE!;
        fs.chmodSync(file, 0o755);
        await runScript(
          'cp -f "$1" "$2.new" && chmod 755 "$2.new" && mv -f "$2.new" "$2"',
          [file, target],
          !isWritable(path.dirname(target)),
        );
        relaunchAndQuit(target);
        break;
      }

      case "flatpak": {
        const id = process.env.FLATPAK_ID!;
        const scope = commandSucceeds("flatpak-spawn", [
          "--host",
          "flatpak",
          "info",
          "--user",
          id,
        ])
          ? "--user"
          : "--system";
        await run("flatpak-spawn", [
          "--host",
          "flatpak",
          "install",
          scope,
          "-y",
          "--noninteractive",
          "--reinstall",
          "--bundle",
          file,
        ]);
        // relaunch the new deployment from the host once we've exited
        spawn(
          "flatpak-spawn",
          ["--host", "sh", "-c", `sleep 3; flatpak run ${id}`],
          { detached: true, stdio: "ignore" },
        ).unref();
        quitApp();
        setTimeout(() => app.quit(), 500);
        break;
      }

      case "deb":
        await runScript(
          'apt-get install -y --allow-downgrades "$1" || dpkg -i "$1"',
          [file],
          true,
        );
        relaunchAndQuit();
        break;

      case "rpm":
        await runScript(
          'if command -v dnf >/dev/null; then dnf install -y "$1"; ' +
            'elif command -v zypper >/dev/null; then zypper --non-interactive install --allow-unsigned-rpm "$1"; ' +
            'else rpm -Uvh --replacepkgs "$1"; fi',
          [file],
          true,
        );
        relaunchAndQuit();
        break;

      case "pacman":
        await run("pkexec", ["pacman", "-U", "--noconfirm", file]);
        relaunchAndQuit();
        break;

      case "tarball": {
        const installDir = path.dirname(process.execPath);
        const extractDir = path.join(workDir, "extract");
        fs.mkdirSync(extractDir);
        await run("tar", ["-xzf", file, "-C", extractDir]);
        const [top] = fs.readdirSync(extractDir);
        const newDir = path.join(extractDir, top);
        if (
          !fs.existsSync(path.join(newDir, path.basename(process.execPath)))
        ) {
          throw new Error("Arquivo .tar.gz da release em formato inesperado.");
        }
        await runScript(
          'set -e; rm -rf "$2.new" "$2.old"; cp -a "$1" "$2.new"; ' +
            'chown -R --reference="$2" "$2.new" 2>/dev/null || true; ' +
            'chmod -R a+rX "$2.new"; mv "$2" "$2.old"; mv "$2.new" "$2"; rm -rf "$2.old"',
          [newDir, installDir],
          !isWritable(path.dirname(installDir)),
        );
        relaunchAndQuit();
        break;
      }

      default:
        throw new Error("Tipo de instalação sem suporte a atualização.");
    }
  } catch (err) {
    console.error("Update failed", err);
    setStatus({ kind: "available", release, version });
    const { response } = await showBox({
      type: "error",
      title: `${PRODUCT} — atualização`,
      message: "Não foi possível instalar a atualização.",
      detail: `${String(err)}\n\nVocê pode baixar e instalar manualmente pela página da release.`,
      buttons: ["Abrir página de download", "Fechar"],
      cancelId: 1,
    });
    if (response === 0) void shell.openExternal(release.html_url);
  }
}

/**
 * Tray entries describing the updater state.
 */
export function updaterMenuItems(): MenuItemConstructorOptions[] {
  switch (status.kind) {
    case "available":
      return [
        {
          label: `Atualizar para v${status.version}`,
          click: () => void promptUpdate(),
        },
      ];
    case "downloading":
      return [
        {
          label: `Baixando v${status.version}… ${Math.round(status.progress * 100)}%`,
          enabled: false,
        },
      ];
    case "installing":
      return [{ label: `Instalando v${status.version}…`, enabled: false }];
    case "checking":
      return [{ label: "Procurando atualizações…", enabled: false }];
    default:
      return [
        {
          label: "Procurar atualizações",
          click: () => void checkForUpdates(true),
        },
      ];
  }
}

/**
 * Start watching for new releases.
 */
export function initUpdater() {
  if (!app.isPackaged) return;
  setTimeout(() => void checkForUpdates(), FIRST_CHECK_DELAY_MS);
  setInterval(() => void checkForUpdates(), CHECK_INTERVAL_MS);
}
