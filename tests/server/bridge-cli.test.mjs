import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { describe, test } from "node:test";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const root = process.cwd();

describe("Codex Watch bridge CLI", () => {
  test("package exposes start, urls, and doctor commands", () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));

    assert.equal(manifest.bin?.["codex-watch-bridge"], "bridge/codex-watch-bridge-cli.mjs");
    assert.match(manifest.scripts?.bridge || "", /codex-watch-bridge-cli\.mjs start/);
    assert.match(manifest.scripts?.["bridge:doctor"] || "", /codex-watch-bridge-cli\.mjs doctor/);
    assert.match(manifest.scripts?.["bridge:urls"] || "", /codex-watch-bridge-cli\.mjs urls/);
  });

  test("urls prints watch setup URLs and self-check commands", async () => {
    const { stdout } = await execFileAsync(process.execPath, [
      "bridge/codex-watch-bridge-cli.mjs",
      "urls"
    ], { cwd: root });

    assert.match(stdout, /Codex Watch Bridge URLs/);
    assert.match(stdout, /Port: 17843/);
    assert.match(stdout, /Watch app URL:/);
    assert.match(stdout, /State check:/);
    assert.match(stdout, /\/codex-stopwatch\/state/);
    assert.match(stdout, /codex-watch-bridge doctor/);
    assert.doesNotMatch(stdout, /127\.0\.0\.1:17843\s+Use this on Apple Watch/);
  });

  test("doctor appends pairing token from environment for state checks", async () => {
    const seen = [];
    const server = http.createServer((request, response) => {
      const requestURL = new URL(request.url || "/", "http://127.0.0.1");
      seen.push(requestURL);
      if (requestURL.pathname === "/") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ ok: true }));
        return;
      }
      if (requestURL.pathname === "/codex-stopwatch/state" && requestURL.searchParams.get("token") === "secret-token") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ ok: true }));
        return;
      }
      response.writeHead(401, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: false }));
    });

    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    try {
      const { port } = server.address();
      const { stdout } = await execFileAsync(process.execPath, [
        "bridge/codex-watch-bridge-cli.mjs",
        "doctor",
        "--base-url",
        `http://127.0.0.1:${port}`
      ], {
        cwd: root,
        env: {
          ...process.env,
          CODEX_WATCH_PAIRING_TOKEN: "secret-token"
        }
      });

      assert.match(stdout, /Result: OK/);
      assert.equal(seen.some(url => url.pathname === "/codex-stopwatch/state" && url.searchParams.get("token") === "secret-token"), true);
    } finally {
      await new Promise(resolve => server.close(resolve));
    }
  });

  test("start injects token file into the bridge process", async () => {
    const tokenFile = path.join(root, ".tmp-bridge-cli-token");
    fs.writeFileSync(tokenFile, "file-token\n", { mode: 0o600 });
    const child = spawn(process.execPath, [
      "bridge/codex-watch-bridge-cli.mjs",
      "start",
      "--host",
      "127.0.0.1",
      "--port",
      "0",
      "--token-file",
      tokenFile
    ], {
      cwd: root,
      env: {
        ...process.env,
        CODEX_WATCH_PAIRING_TOKEN: ""
      },
      stdio: ["ignore", "pipe", "pipe"]
    });

    try {
      const port = await waitForPort(child);
      const rootResponse = await requestJSON(`http://127.0.0.1:${port}/`);
      assert.equal(rootResponse.tokenRequired, true);
    } finally {
      child.kill();
      fs.rmSync(tokenFile, { force: true });
      await onceExit(child);
    }
  });
});

function waitForPort(child) {
  return new Promise((resolve, reject) => {
    let output = "";
    const timeout = setTimeout(() => reject(new Error(`timed out waiting for bridge port. stdout=${output}`)), 5000);
    child.stdout.on("data", chunk => {
      output += chunk.toString("utf8");
      const match = output.match(/Port: (\d+)/);
      if (match) {
        clearTimeout(timeout);
        resolve(Number(match[1]));
      }
    });
    child.on("error", error => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on("exit", code => {
      clearTimeout(timeout);
      reject(new Error(`bridge exited before printing port: ${code}`));
    });
  });
}

function onceExit(child) {
  return new Promise(resolve => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve();
      return;
    }
    child.once("exit", resolve);
  });
}

function requestJSON(url) {
  return new Promise((resolve, reject) => {
    http.get(url, response => {
      const chunks = [];
      response.on("data", chunk => chunks.push(chunk));
      response.on("end", () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
        } catch (error) {
          reject(error);
        }
      });
    }).on("error", reject);
  });
}
