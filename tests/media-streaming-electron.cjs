const { app, BrowserWindow } = require("electron");
const http = require("http");
const fs = require("fs");
const path = require("path");

const media = fs.readFileSync(
  path.join(__dirname, "fixtures", "seekable.webm")
);

let bytesSent = 0;
const ranges = [];

function parseRange(value) {
  const match = /^bytes=(\d*)-(\d*)$/.exec(value);
  if (!match) return null;

  let start = match[1] ? Number(match[1]) : 0;
  let end = match[2] ? Number(match[2]) : media.length - 1;

  if (
    !Number.isFinite(start) ||
    !Number.isFinite(end) ||
    start >= media.length ||
    end < start
  ) {
    return null;
  }

  end = Math.min(end, media.length - 1);
  return { start, end };
}

function sendSlow(res, body) {
  let offset = 0;

  function pump() {
    if (res.destroyed || res.writableEnded) return;

    const end = Math.min(
      offset + 64 * 1024,
      body.length
    );

    res.write(body.subarray(offset, end));
    bytesSent += end - offset;
    offset = end;

    if (offset >= body.length) {
      res.end();
    } else {
      setTimeout(pump, 100);
    }
  }

  pump();
}

const server = http.createServer((req, res) => {
  if (req.url === "/") {
    res.setHeader(
      "Content-Type",
      "text/html; charset=utf-8"
    );

    res.end(`
      <video
        id="player"
        muted
        autoplay
        preload="metadata"
        src="/media.webm">
      </video>
    `);

    return;
  }

  if (req.url !== "/media.webm") {
    res.statusCode = 404;
    res.end();
    return;
  }

  res.setHeader("Accept-Ranges", "bytes");
  res.setHeader("Content-Type", "video/webm");

  const rawRange = req.headers.range;

  if (!rawRange) {
    res.statusCode = 200;
    res.setHeader("Content-Length", media.length);
    sendSlow(res, media);
    return;
  }

  ranges.push(rawRange);

  const range = parseRange(rawRange);

  if (!range) {
    res.statusCode = 416;
    res.setHeader(
      "Content-Range",
      `bytes */${media.length}`
    );
    res.end();
    return;
  }

  const body = media.subarray(
    range.start,
    range.end + 1
  );

  res.statusCode = 206;
  res.setHeader(
    "Content-Range",
    `bytes ${range.start}-${range.end}/${media.length}`
  );
  res.setHeader("Content-Length", body.length);

  sendSlow(res, body);
});

async function fail(message) {
  console.error("FAIL:", message);
  await app.quit();
  process.exitCode = 1;
}

app.commandLine.appendSwitch(
  "autoplay-policy",
  "no-user-gesture-required"
);

app.whenReady().then(async () => {
  await new Promise((resolve) =>
    server.listen(0, "127.0.0.1", resolve)
  );

  const { port } = server.address();

  const win = new BrowserWindow({
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  await win.loadURL(
    `http://127.0.0.1:${port}/`
  );

  try {
    const started = await win.webContents
      .executeJavaScript(`
        new Promise((resolve, reject) => {
          const video =
            document.getElementById("player");

          const timeout = setTimeout(
            () => reject(
              new Error("playback timeout")
            ),
            15000
          );

          const check = () => {
            if (video.currentTime > 0.1) {
              clearTimeout(timeout);
              resolve({
                time: video.currentTime,
                duration: video.duration
              });
              return;
            }

            requestAnimationFrame(check);
          };

          video.play()
            .then(check)
            .catch(reject);
        });
      `);

    console.log("Playback started:", started);
    console.log(
      "Bytes at playback:",
      bytesSent,
      "/",
      media.length
    );

    if (
      bytesSent <= 0 ||
      bytesSent >= media.length
    ) {
      throw new Error(
        "video required the full file before playback"
      );
    }

    await win.webContents.executeJavaScript(`
      new Promise((resolve, reject) => {
        const video =
          document.getElementById("player");

        const timeout = setTimeout(
          () => reject(
            new Error("seek timeout")
          ),
          10000
        );

        video.addEventListener(
          "seeked",
          () => {
            clearTimeout(timeout);
            resolve();
          },
          { once: true }
        );

        video.currentTime = 6;
      });
    `);

    const position =
      await win.webContents.executeJavaScript(
        'document.getElementById("player").currentTime'
      );

    console.log("Seek position:", position);
    console.log("Ranges:", ranges);

    if (position < 5 || position > 7.5) {
      throw new Error("seek position invalid");
    }

    if (
      !ranges.some((r) =>
        r.startsWith("bytes=")
      )
    ) {
      throw new Error(
        "no HTTP Range request observed"
      );
    }

    console.log("PASS: Electron media streaming");
    console.log("PASS: playback before full download");
    console.log("PASS: seek");
    console.log("PASS: HTTP Range");
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  } finally {
    win.destroy();

    await new Promise((resolve) =>
      server.close(resolve)
    );

    app.quit();
  }
});
