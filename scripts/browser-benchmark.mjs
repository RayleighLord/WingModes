import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { chromium } from "playwright";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const host = "127.0.0.1";
const port = Number(process.env.BROWSER_BENCHMARK_PORT ?? 32_000 + (process.pid % 20_000));
const repositoryPath = "/WingModes/";
const baseUrl = `http://${host}:${port}${repositoryPath}`;
const executablePath = process.env.CHROME_PATH ??
  (existsSync("/usr/bin/google-chrome") ? "/usr/bin/google-chrome" : undefined);
const launchArgs = process.env.CHROME_ARGS ? JSON.parse(process.env.CHROME_ARGS) :
  process.platform === "linux" && (process.env.DISPLAY || process.env.WAYLAND_DISPLAY) ?
    ["--use-gl=angle", "--use-angle=gl"] : [];
const report = { generatedAt: new Date().toISOString(), launchArgs, samplesPerModeSeconds: 2, cases: [] };
const preview = spawn(process.execPath, [
  fileURLToPath(new URL("../node_modules/vite/bin/vite.js", import.meta.url)),
  "preview", "--base", repositoryPath, "--host", host, "--port", String(port), "--strictPort"
], { cwd: projectRoot, stdio: ["ignore", "inherit", "inherit"] });

let browser;
try {
  await waitForServer();
  browser = await chromium.launch({ headless: true, args: launchArgs, ...(executablePath ? { executablePath } : {}) });
  report.browser = browser.version();
  for (const configuration of [
    { name: "desktop", viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 },
    { name: "mobile", viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true }
  ]) {
    const { name, ...contextOptions } = configuration;
    const context = await browser.newContext(contextOptions);
    try {
      const page = await context.newPage();
      const errors = [];
      page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
      page.on("pageerror", (error) => errors.push(error.message));
      page.on("requestfailed", (request) => errors.push(`${request.url()}: ${request.failure()?.errorText}`));
      page.on("response", (response) => { if (response.status() >= 400) errors.push(`${response.status()} ${response.url()}`); });
      const navigationStart = performance.now();
      await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
      await page.waitForFunction(() => {
        const stage = document.querySelector("#wing-stage");
        return stage?.dataset.status === "ready" && Number(stage.dataset.frame) > 0;
      });
      const firstReadyMs = performance.now() - navigationStart;
      const hardware = await page.locator("#wing-stage canvas").evaluate((canvas) => {
        const gl = canvas.getContext("webgl2") ?? canvas.getContext("webgl");
        const debug = gl.getExtension("WEBGL_debug_renderer_info");
        return {
          vendor: gl.getParameter(debug ? debug.UNMASKED_VENDOR_WEBGL : gl.VENDOR),
          renderer: gl.getParameter(debug ? debug.UNMASKED_RENDERER_WEBGL : gl.RENDERER),
          version: gl.getParameter(gl.VERSION),
          devicePixelRatio, hardwareConcurrency: navigator.hardwareConcurrency,
          drawingBuffer: [gl.drawingBufferWidth, gl.drawingBufferHeight]
        };
      });
      // Warm every mode once before measuring, then allow shader compilation and GPU work to settle.
      await page.evaluate(async () => {
        const slider = document.querySelector("#mode-slider");
        for (let mode = 1; mode <= 24; mode += 1) {
          slider.value = String(mode);
          slider.dispatchEvent(new Event("input", { bubbles: true }));
          await new Promise(requestAnimationFrame);
        }
      });
      await page.waitForTimeout(2_000);
      const baselineResources = await resources(page);
      assert.ok(Object.values(baselineResources).every((value) => Number.isInteger(value) && value > 0),
        "Missing or invalid GPU resource telemetry");
      const modes = [];
      for (let mode = 1; mode <= 24; mode += 1) {
        const result = await page.evaluate(async (selectedMode) => {
          const stage = document.querySelector("#wing-stage");
          const slider = document.querySelector("#mode-slider");
          slider.value = String(selectedMode);
          slider.dispatchEvent(new Event("input", { bubbles: true }));
          await new Promise(requestAnimationFrame);
          await new Promise(requestAnimationFrame);
          const intervals = [];
          let previousFrame = Number(stage.dataset.frame);
          let previousTime = performance.now();
          const deadline = previousTime + 2_000;
          while (performance.now() < deadline) {
            await new Promise(requestAnimationFrame);
            const frame = Number(stage.dataset.frame);
            if (frame !== previousFrame) {
              const now = performance.now();
              intervals.push(now - previousTime);
              previousFrame = frame;
              previousTime = now;
            }
          }
          return { intervals, cycleSeconds: Number(stage.dataset.cycleSeconds) };
        }, mode);
        const stats = summarize(result.intervals);
        modes.push({ mode, ...stats, cycleSeconds: result.cycleSeconds,
          meanFramesPerCycle: result.cycleSeconds * 1_000 / stats.meanMs });
        if (mode % 8 === 0) console.log(`${name}: measured modes 1–${mode}/24`);
      }
      const switching = await page.evaluate(async () => {
        const stage = document.querySelector("#wing-stage");
        const slider = document.querySelector("#mode-slider");
        const toggle = document.querySelector("#animation-toggle");
        if (stage.dataset.playing === "true") toggle.click();
        await new Promise(requestAnimationFrame);
        const samples = [];
        for (let pass = 0; pass < 3; pass += 1) {
          for (let mode = 1; mode <= 24; mode += 1) {
            const frameBefore = Number(stage.dataset.frame);
            const start = performance.now();
            slider.value = String(mode);
            slider.dispatchEvent(new Event("input", { bubbles: true }));
            do {
              await new Promise(requestAnimationFrame);
              if (performance.now() - start > 2_000) throw new Error(`Mode ${mode} did not render`);
            } while (stage.dataset.mode !== String(mode) || Number(stage.dataset.frame) <= frameBefore);
            samples.push(performance.now() - start);
          }
        }
        return samples;
      });
      const finalResources = await resources(page);
      const result = { name, viewport: configuration.viewport, firstReadyMs, hardware, modes,
        switching: summarize(switching), baselineResources, finalResources, errors };
      report.cases.push(result);
      console.log(`${name}: first ready ${firstReadyMs.toFixed(1)} ms; switching p95 ${result.switching.p95Ms.toFixed(2)} ms; ` +
        `worst mean frame ${Math.max(...modes.map((mode) => mode.meanMs)).toFixed(2)} ms; ` +
        `worst frame p95 ${Math.max(...modes.map((mode) => mode.p95Ms)).toFixed(2)} ms`);
      console.log(`${name}: ${hardware.renderer}`);
    } finally {
      await context.close();
    }
  }
  // Write measurements even when a gate fails; never substitute a weaker software-rendering threshold.
  await saveReport();
  const failures = [];
  for (const result of report.cases) {
    for (const mode of result.modes) {
      const prefix = `${result.name} mode ${mode.mode}`;
      if (mode.count < 60) failures.push(`${prefix}: only ${mode.count} rendered frames in 2 seconds`);
      if (mode.meanMs > 20) failures.push(`${prefix}: mean ${mode.meanMs.toFixed(2)} ms > 20 ms`);
      if (mode.p95Ms > 33.4) failures.push(`${prefix}: p95 ${mode.p95Ms.toFixed(2)} ms > 33.4 ms`);
      if (mode.maxMs > 100) failures.push(`${prefix}: maximum ${mode.maxMs.toFixed(2)} ms > 100 ms`);
    }
    if (result.switching.p95Ms > 100) failures.push(`${result.name}: switching p95 exceeds 100 ms`);
    if (JSON.stringify(result.baselineResources) !== JSON.stringify(result.finalResources)) {
      failures.push(`${result.name}: GPU resource counts changed after repeated mode sweeps`);
    }
    failures.push(...result.errors.map((error) => `${result.name}: ${error}`));
  }
  report.passed = failures.length === 0;
  report.failures = failures;
  await saveReport();
  assert.deepEqual(failures, [], `Browser performance gates failed:\n${failures.join("\n")}`);
  console.log("Performance gates passed for all 24 modes at desktop and mobile sizes. Report: output/performance.json");
} finally {
  if (report.cases.length > 0) await saveReport();
  await browser?.close();
  preview.kill("SIGTERM");
  await waitForExit(preview);
}

async function resources(page) {
  return page.locator("#wing-stage").evaluate((stage) => ({
    geometries: Number(stage.dataset.geometryCount),
    textures: Number(stage.dataset.textureCount),
    programs: Number(stage.dataset.programCount)
  }));
}

function summarize(values) {
  assert.ok(values.length > 0 && values.every((value) => Number.isFinite(value) && value > 0), "Invalid timing sample");
  const sorted = [...values].sort((a, b) => a - b);
  return {
    count: values.length,
    meanMs: values.reduce((sum, value) => sum + value, 0) / values.length,
    p95Ms: sorted[Math.ceil(0.95 * sorted.length) - 1],
    maxMs: sorted.at(-1)
  };
}

async function saveReport() {
  await mkdir(new URL("../output/", import.meta.url), { recursive: true });
  await writeFile(new URL("../output/performance.json", import.meta.url), `${JSON.stringify(report, null, 2)}\n`);
}

async function waitForServer() {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (preview.exitCode !== null) throw new Error(`Preview exited with code ${preview.exitCode}`);
    try { if ((await fetch(baseUrl)).ok) return; } catch { /* The preview is still starting. */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for ${baseUrl}`);
}

async function waitForExit(child) {
  if (child.exitCode !== null) return;
  await new Promise((resolve) => { child.once("exit", resolve); setTimeout(resolve, 2_000).unref(); });
}
