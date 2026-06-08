import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs";
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
      "urls",
      "--host",
      "::",
      "--port",
      "17842"
    ], { cwd: root });

    assert.match(stdout, /Codex Watch Bridge URLs/);
    assert.match(stdout, /Watch app URL:/);
    assert.match(stdout, /State check:/);
    assert.match(stdout, /\/codex-stopwatch\/state/);
    assert.match(stdout, /codex-watch-bridge doctor/);
    assert.doesNotMatch(stdout, /127\.0\.0\.1:17842\s+Use this on Apple Watch/);
  });
});
