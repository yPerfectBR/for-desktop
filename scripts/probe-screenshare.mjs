/**
 * Probe Linux GPU + PipeWire screen capture for Stoat Homelab.
 * Opens the xdg-desktop-portal picker; pick a full screen (incl. non-NVIDIA).
 * Writes a PNG and reports whether the frame looks black.
 */
import { app, BrowserWindow, desktopCapturer, session } from "electron";
import { writeFileSync } from "fs";
import { join } from "path";
import { fileURLToPath } from "url";

const onWayland =
  process.env.XDG_SESSION_TYPE === "wayland" || !!process.env.WAYLAND_DISPLAY;

app.commandLine.appendSwitch(
  "enable-features",
  "WebRTCPipeWireCapturer,VaapiVideoEncoder,VaapiVideoDecoder",
);
app.commandLine.appendSwitch("enable-usermedia-screen-capturing");
app.commandLine.appendSwitch("ignore-gpu-blocklist");
app.commandLine.appendSwitch("enable-gpu-rasterization");
if (onWayland) {
  app.commandLine.appendSwitch("ozone-platform-hint", "auto");
}

const primaryCard = (process.env.WLR_DRM_DEVICES || process.env.AQ_DRM_DEVICES || "")
  .split(":")
  .map((p) => p.trim())
  .find(Boolean);
if (primaryCard) {
  try {
    const { readdirSync } = await import("fs");
    const cardName = primaryCard.split("/").pop();
    const render = readdirSync(`/sys/class/drm/${cardName}/device/drm`).find(
      (n) => n.startsWith("renderD"),
    );
    if (render) {
      app.commandLine.appendSwitch("render-node-override", `/dev/dri/${render}`);
      console.log("[probe] render-node-override=/dev/dri/" + render);
    }
  } catch (e) {
    console.warn("[probe] render-node lookup failed", e);
  }
}

function isMostlyBlack(pngBuffer) {
  // Cheap heuristic: PNG of a solid black 1080p frame compresses tiny;
  // also sample via NativeImage if available from Electron.
  return pngBuffer.length < 8_000;
}

app.whenReady().then(async () => {
  console.log("[probe] platform=", process.platform, "wayland=", onWayland);
  console.log("[probe] ozone switches:", app.commandLine.getSwitchValue("ozone-platform-hint"));
  console.log("[probe] gpuFeatureStatus will follow after window...");

  session.defaultSession.setDisplayMediaRequestHandler(async (request, callback) => {
    try {
      const sources = await desktopCapturer.getSources({
        types: ["screen", "window"],
        thumbnailSize: { width: 1920, height: 1080 },
      });
      console.log(
        "[probe] portal returned",
        sources.length,
        "source(s):",
        sources.map((s) => `${s.id} | ${s.name}`),
      );
      if (!sources.length) {
        callback({});
        return;
      }
      const source = sources[0];
      const thumb = source.thumbnail;
      const size = thumb.getSize();
      const png = thumb.toPNG();
      const out = join(process.cwd(), "screenshare-probe.png");
      writeFileSync(out, png);
      const avg = (() => {
        const bitmap = thumb.toBitmap();
        // BGRA
        let sum = 0;
        const step = 16 * 4;
        let n = 0;
        for (let i = 0; i + 2 < bitmap.length; i += step) {
          sum += bitmap[i] + bitmap[i + 1] + bitmap[i + 2];
          n += 3;
        }
        return n ? sum / n : 0;
      })();
      const black = avg < 3 || isMostlyBlack(png);
      console.log(
        `[probe] thumbnail ${size.width}x${size.height} png=${png.length}B avgChannel=${avg.toFixed(2)} black=${black}`,
      );
      console.log("[probe] wrote", out);
      if (request.audioRequested) {
        callback({ video: source, audio: "loopback" });
      } else {
        callback({ video: source });
      }
    } catch (err) {
      console.error("[probe] capturer failed", err);
      callback({});
    }
  });

  const win = new BrowserWindow({
    width: 960,
    height: 640,
    webPreferences: { nodeIntegration: false, contextIsolation: true },
  });

  const gpuInfo = await app.getGPUInfo("complete");
  console.log(
    "[probe] GPU devices:",
    JSON.stringify(
      (gpuInfo.gpuDevice || []).map((d) => ({
        vendorId: d.vendorId,
        deviceId: d.deviceId,
        driver: d.driverVendor,
      })),
      null,
      2,
    ),
  );

  await win.loadFile(join(fileURLToPath(new URL(".", import.meta.url)), "probe.html"));

  console.log("[probe] window ready — auto-triggering portal via getSources()");

  // Main-process path used by Stoat's setDisplayMediaRequestHandler on Wayland.
  try {
    const sources = await desktopCapturer.getSources({
      types: ["screen", "window"],
      thumbnailSize: { width: 1280, height: 800 },
    });
    console.log(
      "[probe] getSources count=",
      sources.length,
      sources.map((s) => `${s.id} :: ${s.name}`),
    );
    for (const [i, s] of sources.entries()) {
      const png = s.thumbnail.toPNG();
      const bitmap = s.thumbnail.toBitmap();
      let sum = 0;
      let n = 0;
      for (let p = 0; p + 2 < bitmap.length; p += 64) {
        sum += bitmap[p] + bitmap[p + 1] + bitmap[p + 2];
        n += 3;
      }
      const avg = n ? sum / n : 0;
      const out = join(process.cwd(), `screenshare-probe-${i}.png`);
      writeFileSync(out, png);
      console.log(
        `[probe] source[${i}] ${s.id} "${s.name}" png=${png.length}B avg=${avg.toFixed(2)} black=${avg < 3} -> ${out}`,
      );
    }
  } catch (err) {
    console.error("[probe] getSources failed", err);
  }
});
