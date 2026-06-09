#!/usr/bin/env node
import http from "node:http";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { once } from "node:events";
import { startBridge } from "./codex-watch-bridge.mjs";

const DEFAULT_PORT = Number(process.env.CODEX_WATCH_PORT || 17843);
const DEFAULT_HOST = process.env.CODEX_WATCH_HOST || "::";
const DEFAULT_TOKEN_FILE = process.env.CODEX_WATCH_PAIRING_TOKEN_FILE
  || path.join(process.cwd(), ".codex-buddy-watch", "pairing-token");

async function main(argv = process.argv.slice(2)) {
  const { command, options } = parseArgs(argv);

  switch (command) {
    case "start":
      await startCommand(options);
      break;
    case "urls":
      urlsCommand(options);
      break;
    case "pair":
      await pairCommand(options);
      break;
    case "doctor":
      await doctorCommand(options);
      break;
    case "help":
    case "--help":
    case "-h":
      printHelp();
      break;
    default:
      console.error(`Unknown command: ${command}`);
      printHelp();
      process.exitCode = 1;
  }
}

function parseArgs(argv) {
  const [command = "start", ...rest] = argv;
  const options = {};

  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    if (!arg.startsWith("--")) {
      continue;
    }

    const [rawKey, inlineValue] = arg.slice(2).split("=", 2);
    const nextValue = rest[index + 1];
    const hasSeparateValue = inlineValue === undefined
      && typeof nextValue === "string"
      && !nextValue.startsWith("--");
    const value = inlineValue ?? (hasSeparateValue ? nextValue : true);
    if (hasSeparateValue) {
      index += 1;
    }
    options[rawKey] = value;
  }

  return { command, options };
}

async function startCommand(options) {
  const host = stringOption(options.host, DEFAULT_HOST);
  const port = numberOption(options.port, DEFAULT_PORT);
  const token = pairingToken(options);
  if (token) {
    process.env.CODEX_WATCH_PAIRING_TOKEN = token;
  }
  const server = startBridge({ host, port });
  await once(server, "listening");

  printURLGuide({ host, port: boundPort(server), token, title: "Codex Watch Bridge Ready" });
  console.log("");
  console.log("Keep this terminal open while using the Watch app.");
}

function urlsCommand(options) {
  const host = stringOption(options.host, DEFAULT_HOST);
  const port = numberOption(options.port, DEFAULT_PORT);
  const token = pairingToken(options);
  printURLGuide({ host, port, token, title: "Codex Watch Bridge URLs" });
}

async function pairCommand(options) {
  const port = numberOption(options.port, DEFAULT_PORT);
  const mode = stringOption(options.mode, "directBridge");
  const active = stringOption(options.active, "lan");
  const token = pairingToken(options);
  const lanURL = normalizeBaseURL(stringOption(options["lan-url"], watchURLForPort(port)));
  const publicURL = normalizeBaseURL(stringOption(options["public-url"], process.env.CODEX_WATCH_PUBLIC_URL || ""));
  const payload = bridgePairingPayload({
    mode,
    active,
    lanURL,
    publicURL,
    token
  });
  const qrMode = stringOption(options.qr, "terminal");

  console.log("Codex Watch Bridge Pairing");
  console.log(`Mode: ${mode}`);
  console.log(`Active endpoint: ${active}`);
  console.log(`LAN URL: ${lanURL}`);
  if (publicURL) {
    console.log(`Public Tunnel URL: ${publicURL}`);
  }
  console.log(`Token: ${token ? "<pairing-token>" : "not configured"}`);
  console.log("");
  console.log("Pairing QR");
  if (qrMode === "none") {
    console.log("QR output disabled.");
  } else {
    await printTerminalQRCode(payload);
  }
  console.log("");
  console.log("iPhone setup:");
  console.log("  1. Open Codex Buddy on iPhone.");
  console.log("  2. Open Bridge settings.");
  console.log("  3. Scan this QR code or paste the pairing payload.");
  if (options["show-payload"] === "true" || options["show-payload"] === true) {
    console.log("");
    console.log(`Pairing payload: ${payload}`);
  }
}

async function doctorCommand(options) {
  const port = numberOption(options.port, DEFAULT_PORT);
  const baseURL = normalizeBaseURL(stringOption(options["base-url"], `http://127.0.0.1:${port}`));
  const timeoutMs = numberOption(options["timeout-ms"], 15000);
  const token = pairingToken(options);
  const rootResult = await requestJSON(`${baseURL}/`, timeoutMs);
  const stateResult = await requestJSON(withToken(`${baseURL}/codex-stopwatch/state`, token), timeoutMs);
  const healthResult = await requestJSON(withToken(`${baseURL}/health`, token), timeoutMs);

  console.log("Codex Watch Bridge Doctor");
  console.log(`Base URL: ${baseURL}`);
  printCheck("Bridge root", rootResult);
  printCheck("State endpoint", stateResult);
  printCheck("Health endpoint", healthResult);
  printHealthSummary(healthResult.json);
  console.log("");

  if (rootResult.ok && stateResult.ok && healthResult.ok) {
    console.log("Result: OK");
    console.log(`Use this in the Watch app: ${watchURLForPort(port)}${token ? "?token=<pairing-token>" : ""}`);
    return;
  }

  console.log("Result: needs attention");
  console.log("Try:");
  console.log("  1. Start the bridge: codex-watch-bridge start");
  console.log("  2. Check URLs: codex-watch-bridge urls");
  console.log("  3. Make sure the Apple Watch is on the same Wi-Fi as this Mac.");
  console.log("  4. Do not use 127.0.0.1 or localhost on a physical Apple Watch.");
  process.exitCode = 1;
}

function printURLGuide({ host, port, token, title }) {
  const lanURL = watchURLForPort(port);
  const localName = localHostName();
  const localURL = localName ? `http://${localName}.local:${port}` : null;
  const tokenHint = token ? "?token=<pairing-token>" : "";

  console.log(title);
  console.log(`Listening host: ${host}`);
  console.log(`Port: ${port}`);
  console.log("");
  console.log(`Watch app URL: ${lanURL}${tokenHint}`);
  if (localURL) {
    console.log(`Hostname URL: ${localURL}${tokenHint}`);
  }
  console.log(`Simulator URL: http://127.0.0.1:${port}`);
  console.log("");
  console.log(`State check: curl -sS --max-time 3 ${lanURL}/codex-stopwatch/state${tokenHint}`);
  console.log("Self-check: codex-watch-bridge doctor");
  console.log("");
  console.log("Apple Watch setup:");
  console.log("  1. Open Codex Buddy on Apple Watch.");
  console.log("  2. Tap the bridge warning or open System > Bridge.");
  console.log(`  3. Set URL to ${lanURL}${tokenHint}`);
  console.log("  4. Avoid 127.0.0.1 and localhost on a physical Apple Watch.");
  if (token) {
    console.log("  5. Keep the real token private; the CLI prints <pairing-token> as a placeholder.");
  }
}

function printCheck(label, result) {
  if (result.ok) {
    console.log(`PASS ${label}: HTTP ${result.statusCode}`);
    return;
  }
  console.log(`FAIL ${label}: ${result.error || `HTTP ${result.statusCode}`}`);
}

function printHealthSummary(health) {
  if (!health || typeof health !== "object") {
    return;
  }
  if (health.diagnosis?.code) {
    console.log(`Diagnosis: ${health.diagnosis.code}`);
  }
  if (health.diagnosis?.action) {
    console.log(`Action: ${health.diagnosis.action}`);
  }
  if (health.state && typeof health.state.ageSeconds === "number") {
    const stale = health.state.stale ? "stale" : "fresh";
    console.log(`State freshness: ${stale}, ${health.state.ageSeconds}s old`);
  }
  if (health.codex?.appServer && typeof health.codex.appServer.ready === "boolean") {
    console.log(`Codex app-server: ${health.codex.appServer.ready ? "ready" : "not ready"}`);
  }
  if (health.codex?.sessions && typeof health.codex.sessions.readable === "boolean") {
    console.log(`Codex sessions: ${health.codex.sessions.readable ? "readable" : "unreadable"}`);
  }
}

function bridgePairingPayload({ mode, active, lanURL, publicURL, token }) {
  const url = new URL("codex-buddy://bridge/pair");
  url.searchParams.set("v", "1");
  url.searchParams.set("mode", mode);
  url.searchParams.set("active", active);
  if (lanURL) {
    url.searchParams.set("lan", lanURL);
  }
  if (publicURL) {
    url.searchParams.set("public", publicURL);
  }
  if (token) {
    url.searchParams.set("token", token);
  }
  return url.toString();
}

async function printTerminalQRCode(payload) {
  try {
    const qrcode = await import("qrcode-terminal");
    qrcode.default.generate(payload, { small: true }, code => {
      console.log(code);
    });
  } catch (error) {
    console.log("QR generator unavailable.");
    console.log(`Install dependencies with npm install. ${error.message}`);
  }
}

function requestJSON(url, timeoutMs) {
  return new Promise(resolve => {
    const request = http.get(url, { timeout: timeoutMs }, response => {
      const chunks = [];
      response.on("data", chunk => chunks.push(chunk));
      response.on("end", () => {
        let json = null;
        const body = Buffer.concat(chunks).toString("utf8");
        if (body.trim()) {
          try {
            json = JSON.parse(body);
          } catch {}
        }
        resolve({
          ok: response.statusCode >= 200 && response.statusCode < 300,
          statusCode: response.statusCode,
          json
        });
      });
    });
    request.on("timeout", () => {
      request.destroy(new Error(`timeout after ${timeoutMs}ms`));
    });
    request.on("error", error => {
      resolve({ ok: false, error: error.message });
    });
  });
}

function watchURLForPort(port) {
  return `http://${lanAddress()}:${port}`;
}

function lanAddress() {
  const interfaces = os.networkInterfaces();
  for (const entries of Object.values(interfaces)) {
    for (const entry of entries || []) {
      if (entry.family === "IPv4" && !entry.internal) {
        return entry.address;
      }
    }
  }
  return "127.0.0.1";
}

function localHostName() {
  return os.hostname().split(".")[0]?.replace(/[^a-zA-Z0-9-]/g, "") || "";
}

function normalizeBaseURL(value) {
  return value.replace(/\/+$/, "");
}

function withToken(url, token) {
  if (!token) {
    return url;
  }
  const requestURL = new URL(url);
  requestURL.searchParams.set("token", token);
  return requestURL.toString();
}

function pairingToken(options) {
  const explicitToken = stringOption(options.token, "");
  if (explicitToken) {
    return explicitToken;
  }
  const envToken = stringOption(process.env.CODEX_WATCH_PAIRING_TOKEN, "");
  if (envToken) {
    return envToken;
  }
  return readTokenFile(stringOption(options["token-file"], DEFAULT_TOKEN_FILE));
}

function readTokenFile(filePath) {
  try {
    return fs.readFileSync(filePath, "utf8").trim();
  } catch {
    return "";
  }
}

function boundPort(server) {
  const address = server.address();
  return typeof address === "object" && address ? address.port : DEFAULT_PORT;
}

function stringOption(value, fallback) {
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

function numberOption(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function printHelp() {
  console.log(`Codex Watch bridge CLI

Usage:
  codex-watch-bridge start [--host ::] [--port 17843] [--token-file .codex-buddy-watch/pairing-token]
  codex-watch-bridge urls [--host ::] [--port 17843] [--token-file .codex-buddy-watch/pairing-token]
  codex-watch-bridge pair [--port 17843] [--lan-url http://mac-ip:17843] [--public-url https://example.ts.net] [--token-file .codex-buddy-watch/pairing-token]
  codex-watch-bridge doctor [--base-url http://127.0.0.1:17843] [--timeout-ms 15000] [--token-file .codex-buddy-watch/pairing-token]

Commands:
  start   Start the bridge and print Watch connection instructions.
  urls    Print LAN, hostname, simulator, and self-check URLs.
  pair    Print a QR pairing payload for the iPhone app.
  doctor  Check whether the bridge is reachable and ready.
`);
}

main().catch(error => {
  console.error(error?.stack || error?.message || String(error));
  process.exitCode = 1;
});
