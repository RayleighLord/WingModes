import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { chromium } from "playwright";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const artifactDir = new URL("../output/playwright/", import.meta.url);
const host = "127.0.0.1";
const port = Number(process.env.BROWSER_TEST_PORT ?? 32_000 + (process.pid % 20_000));
const repositoryPath = "/WingModes/";
const baseUrl = `http://${host}:${port}${repositoryPath}`;
const executablePath = process.env.CHROME_PATH ??
  (existsSync("/usr/bin/google-chrome") ? "/usr/bin/google-chrome" : undefined);
const launchArgs = process.env.CHROME_ARGS ? JSON.parse(process.env.CHROME_ARGS) :
  process.platform === "linux" && (process.env.DISPLAY || process.env.WAYLAND_DISPLAY) ?
    ["--use-gl=angle", "--use-angle=gl"] : [];
await mkdir(artifactDir, { recursive: true });

const preview = spawn(process.execPath, [
  fileURLToPath(new URL("../node_modules/vite/bin/vite.js", import.meta.url)),
  "preview", "--base", repositoryPath, "--host", host, "--port", String(port), "--strictPort"
], { cwd: projectRoot, stdio: ["ignore", "inherit", "inherit"] });

let browser;
try {
  await waitForServer();
  browser = await chromium.launch({
    headless: process.env.HEADED !== "1",
    args: launchArgs,
    ...(executablePath ? { executablePath } : {})
  });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = collectErrors(page);
  await page.goto(baseUrl, { waitUntil: "networkidle" });
  await waitForWing(page, 1);
  await assertComposition(page);
  await assertModesAndTiming(page);
  await captureModalPhases(page);
  await assertPlayback(page);
  await assertCameraAndCleanView(page);
  await assertLifecycle(page);
  await assertContextRecovery(page);
  await assertResponsiveLayout(page);
  await assertNoHoverMessages(page);
  await assertReducedMotion(browser);
  await assertAssetRecovery(browser);
  assert.deepEqual(errors, [], `Browser errors:\n${errors.join("\n")}`);
  console.log("Browser smoke checks passed: all 24 modes, desktop/mobile, keyboard/pointer, timing, recovery, and no hover messages.");
} finally {
  await browser?.close();
  preview.kill("SIGTERM");
  await waitForExit(preview);
}

async function assertComposition(page) {
  assert.match(await page.title(), /Wing.*Modes/i);
  assert.equal(await page.locator('input[type="range"]').count(), 1);
  assert.equal(await page.locator("#mode-slider").getAttribute("min"), "1");
  assert.equal(await page.locator("#mode-slider").getAttribute("max"), "24");
  assert.equal(await page.locator("#mode-slider").getAttribute("step"), "1");
  assert.equal(await page.locator("#wing-stage canvas").count(), 1);
  assert.equal(await page.locator(".katex, math, #formula-card, #shape-math").count(), 0);
  await assertTargets(page);
  const composition = await page.evaluate(() => {
    const stage = document.querySelector("#wing-stage").getBoundingClientRect();
    return { width: stage.width, center: stage.x + stage.width / 2, viewport: innerWidth };
  });
  assert.ok(Math.abs(composition.width - composition.viewport) <= 2, "Desktop stage must span the viewport");
  assert.ok(Math.abs(composition.center - composition.viewport / 2) <= 2, "Wing stage is not centered");
  await setPlaying(page, false);
  await selectMode(page, 2);
  await selectMode(page, 1);
  await page.screenshot({ path: new URL("browser-smoke-desktop.png", artifactDir).pathname, fullPage: true });
  if (process.env.UPDATE_README_SCREENSHOT === "1") {
    await mkdir(new URL("../docs/", import.meta.url), { recursive: true });
    await page.screenshot({
      path: fileURLToPath(new URL("../docs/wing-modes-explorer.png", import.meta.url)), fullPage: true
    });
  }
  await assertNoHoverMessages(page);
}

async function assertModesAndTiming(page) {
  const slider = page.locator("#mode-slider");
  await slider.focus();
  await slider.press("End");
  await waitForWing(page, 24);
  await slider.press("Home");
  await waitForWing(page, 1);
  await slider.press("ArrowUp");
  await waitForWing(page, 2);
  const bounds = await slider.boundingBox();
  assert.ok(bounds);
  await page.mouse.click(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
  const pointerMode = Number(await slider.inputValue());
  assert.ok(pointerMode >= 10 && pointerMode <= 15, `Pointer did not select the middle of the slider: ${pointerMode}`);
  await waitForWing(page, pointerMode);

  const frequencies = [];
  let fundamentalProduct = 0;
  for (let mode = 1; mode <= 24; mode += 1) {
    await selectMode(page, mode);
    const data = await stageData(page);
    const frequency = Number(data.frequencyHz);
    const cycle = Number(data.cycleSeconds);
    assert.ok(Number.isFinite(frequency) && frequency > 0, `Mode ${mode} has an invalid frequency`);
    assert.ok(Number.isFinite(cycle) && cycle > 0, `Mode ${mode} has invalid animation timing`);
    assert.ok(Math.abs(Number(data.phase)) < 1e-6, `Mode ${mode} did not reset to maximum displacement`);
    if (mode === 1) {
      assert.ok(cycle >= 10 - 1e-10, "Fundamental visual cycle must be at least 10 seconds");
      fundamentalProduct = frequency * cycle;
    }
    assert.ok(Math.abs(frequency * cycle / fundamentalProduct - 1) < 1e-8,
      `Mode ${mode} does not preserve the computed frequency ratio`);
    assert.ok(cycle >= 2 / 3 - 1e-10, `Mode ${mode} exceeds the 1.5 Hz visual-frequency limit`);
    frequencies.push(frequency);
    if ([1, 8, 16, 24].includes(mode)) {
      await page.screenshot({ path: new URL(`mode-${mode}-maximum.png`, artifactDir).pathname });
    }
  }
  assert.ok(frequencies.every((frequency, index) => index === 0 || frequency >= frequencies[index - 1]),
    "Modes must be ordered by natural frequency");
  const expectedFundamentalPeriod = Math.max(10, (2 / 3) * frequencies[23] / frequencies[0]);
  assert.ok(Math.abs(fundamentalProduct / frequencies[0] - expectedFundamentalPeriod) < 1e-8,
    "Common slowdown differs from the documented 10-second minimum and 1.5 Hz upper limit");

  for (const mode of [1, 24]) {
    await selectMode(page, mode);
    const cycle = Number(await page.locator("#wing-stage").getAttribute("data-cycle-seconds"));
    const timing = await page.evaluate(async () => {
      const stage = document.querySelector("#wing-stage");
      const toggle = document.querySelector("#animation-toggle");
      toggle.click();
      await new Promise(requestAnimationFrame);
      const start = performance.now();
      const initial = Number(stage.dataset.phase);
      await new Promise((resolve) => setTimeout(resolve, 350));
      const final = Number(stage.dataset.phase);
      const seconds = (performance.now() - start) / 1000;
      toggle.click();
      return { initial, final, seconds };
    });
    const expected = timing.seconds * 2 * Math.PI / cycle;
    const actual = (timing.final - timing.initial + 2 * Math.PI) % (2 * Math.PI);
    const circularError = Math.abs(Math.atan2(Math.sin(actual - expected), Math.cos(actual - expected)));
    assert.ok(circularError < Math.max(0.12, 0.08 * 2 * Math.PI / cycle),
      `Mode ${mode} animation phase does not follow its reported cycle`);
  }
  await selectMode(page, 1);
}

async function assertPlayback(page) {
  await setPlaying(page, true);
  const phase = Number((await stageData(page)).phase);
  await page.waitForTimeout(180);
  assert.notEqual(Number((await stageData(page)).phase), phase);
  await setPlaying(page, false);
  await page.waitForTimeout(150);
  const paused = await stageData(page);
  await page.waitForTimeout(180);
  const still = await stageData(page);
  assert.equal(still.phase, paused.phase, "Paused displacement moved");
  assert.equal(still.frame, paused.frame, "Paused renderer continues to schedule frames");
  await page.locator("#wing-stage").focus();
  await page.keyboard.press("Space");
  assert.equal((await stageData(page)).playing, "true");
  await page.keyboard.press("Space");
  assert.equal((await stageData(page)).playing, "false");
}

async function captureModalPhases(page) {
  await setPlaying(page, false);
  await selectMode(page, 1);
  await selectMode(page, 24);
  const captures = [];
  for (const [name, target] of [["positive", 0], ["equilibrium", Math.PI / 2], ["negative", Math.PI]]) {
    let phase = 0;
    if (target !== 0) {
      phase = await page.evaluate(async (desired) => {
        const stage = document.querySelector("#wing-stage");
        const toggle = document.querySelector("#animation-toggle");
        toggle.click();
        const deadline = performance.now() + 10_000;
        while (performance.now() < deadline) {
          await new Promise(requestAnimationFrame);
          const current = Number(stage.dataset.phase);
          const distance = Math.abs(Math.atan2(Math.sin(current - desired), Math.cos(current - desired)));
          if (distance < 0.07) {
            toggle.click();
            return Number(stage.dataset.phase);
          }
        }
        toggle.click();
        throw new Error(`The modal animation did not reach phase ${desired}`);
      }, target);
    }
    const path = new URL(`mode-24-${name}.png`, artifactDir).pathname;
    // Allow accelerated text and glass layers to settle after the programmatic pause.
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await page.waitForTimeout(500);
    await page.screenshot({ path });
    captures.push({ mode: 24, name, targetPhase: target, actualPhase: phase, path });
  }
  await writeFile(new URL("phase-captures.json", artifactDir), `${JSON.stringify(captures, null, 2)}\n`);
  console.log(`Mode 24 visual phases: ${captures.map(({ name, actualPhase }) => `${name}=${actualPhase.toFixed(6)}`).join(", ")}`);
  await selectMode(page, 1);
  await page.locator("#reset-camera").click();
  if (process.env.UPDATE_README_SCREENSHOT === "1") {
    await page.screenshot({
      path: fileURLToPath(new URL("../docs/wing-modes-explorer.png", import.meta.url)), fullPage: true
    });
  }
}

async function assertCameraAndCleanView(page) {
  const stage = page.locator("#wing-stage");
  const initial = (await stageData(page)).camera;
  await stage.focus();
  await stage.press("ArrowLeft");
  await page.waitForTimeout(100);
  assert.notEqual((await stageData(page)).camera, initial);
  await page.locator("#reset-camera").focus();
  await page.keyboard.press("Space");
  await page.waitForTimeout(100);
  assert.equal((await stageData(page)).camera, initial, "Keyboard reset did not restore the camera");
  assert.equal((await stageData(page)).playing, "false", "Button Space leaked into global playback shortcut");

  const bounds = await stage.boundingBox();
  assert.ok(bounds);
  const x = bounds.x + bounds.width * 0.65;
  const y = bounds.y + bounds.height * 0.6;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + 110, y - 120, { steps: 12 });
  await page.mouse.up();
  await page.waitForTimeout(300);
  const rotated = (await stageData(page)).camera;
  assert.notEqual(rotated, initial, "Pointer drag did not rotate the camera");
  await page.mouse.wheel(0, 200);
  await page.waitForTimeout(300);
  assert.notEqual((await stageData(page)).camera, rotated, "Wheel did not zoom the camera");
  await page.locator("#reset-camera").click();
  await page.waitForTimeout(100);
  assert.equal((await stageData(page)).camera, initial);

  await page.locator("#ui-visibility-toggle").click();
  assert.equal(await page.locator("#app-shell").getAttribute("data-ui-hidden"), "true");
  assert.equal(await page.locator(".ui-chrome:visible").count(), 0);
  assert.equal(await page.locator("#ui-visibility-toggle").isVisible(), true);
  await assertNoHoverMessages(page);
  await page.keyboard.press("h");
  assert.equal(await page.locator("#app-shell").getAttribute("data-ui-hidden"), "false");
  await assertNoHoverMessages(page);
}

async function assertLifecycle(page) {
  await setPlaying(page, true);
  const canvas = page.locator("#wing-stage canvas");
  await canvas.evaluate((element) => { element.dataset.lifecycleMarker = "original"; });
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: true })));
  await page.waitForTimeout(100);
  const hidden = await stageData(page);
  await page.waitForTimeout(150);
  assert.equal((await stageData(page)).frame, hidden.frame, "BFCache pagehide did not suspend rendering");
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true })));
  await page.waitForTimeout(100);
  assert.equal(await canvas.getAttribute("data-lifecycle-marker"), "original");
  assert.equal(await canvas.count(), 1);
  assert.ok(Number((await stageData(page)).frame) > Number(hidden.frame));

  // Deterministic visibility events exercise the same path as a hidden browser tab.
  // Headless Chromium does not reliably hide the first tab when another tab opens.
  await page.evaluate(() => {
    Object.defineProperty(document, "hidden", { configurable: true, value: true });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await page.waitForTimeout(100);
  const suspended = await stageData(page);
  await page.waitForTimeout(150);
  assert.equal((await stageData(page)).frame, suspended.frame, "Hidden document continued rendering");
  await page.evaluate(() => {
    delete document.hidden;
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await page.waitForTimeout(100);
  assert.ok(Number((await stageData(page)).frame) > Number(suspended.frame));
  await setPlaying(page, false);
}

async function assertContextRecovery(page) {
  await selectMode(page, 8);
  const lose = async () => {
    const supported = await page.locator("#wing-stage canvas").evaluate((canvas) => {
      const gl = canvas.getContext("webgl2") ?? canvas.getContext("webgl");
      window.__wingTestContextLoss = gl?.getExtension("WEBGL_lose_context");
      window.__wingTestContextLoss?.loseContext();
      return Boolean(window.__wingTestContextLoss);
    });
    assert.equal(supported, true, "WEBGL_lose_context extension is unavailable");
    await page.waitForFunction(() => document.querySelector("#wing-stage").dataset.status === "context-lost");
    assert.equal(await page.locator("#wing-fallback").isVisible(), true);
  };
  await lose();
  await page.evaluate(() => window.__wingTestContextLoss.restoreContext());
  await waitForWing(page, 8);
  assert.equal(await page.locator("#wing-fallback").isHidden(), true);
  await lose();
  await page.locator("#retry-renderer").click();
  await waitForWing(page, 8);
  assert.equal(await page.locator("#wing-stage canvas").count(), 1);
  assert.equal(await page.locator("#wing-fallback").isHidden(), true);
  await page.evaluate(() => delete window.__wingTestContextLoss);
  await selectMode(page, 1);
}

async function assertResponsiveLayout(page) {
  for (const viewport of [{ width: 1024, height: 768 }, { width: 600, height: 800 }, { width: 390, height: 844 }, { width: 320, height: 568 }]) {
    await page.setViewportSize(viewport);
    await page.waitForTimeout(120);
    const layout = await page.evaluate(() => {
      const canvas = document.querySelector("#wing-stage canvas");
      const bounds = canvas.getBoundingClientRect();
      return {
        documentWidth: document.documentElement.scrollWidth,
        canvasWidth: bounds.width, canvasHeight: bounds.height,
        bufferWidth: canvas.width, bufferHeight: canvas.height
      };
    });
    assert.ok(layout.documentWidth <= viewport.width + 1, `Horizontal overflow at ${viewport.width}px`);
    assert.ok(layout.canvasWidth > 0 && layout.canvasHeight > 0);
    assert.ok(layout.bufferWidth > 0 && layout.bufferHeight > 0);
    await assertTargets(page);
    await selectMode(page, 24);
    await selectMode(page, 1);
    if (viewport.width === 390) {
      await page.screenshot({ path: new URL("browser-smoke-mobile.png", artifactDir).pathname, fullPage: true });
      await page.locator("#ui-visibility-toggle").click();
      const clean = await page.locator("#wing-stage").boundingBox();
      assert.ok(clean && Math.abs(clean.height - viewport.height) <= 2, "Mobile clean view must fill the viewport");
      await page.locator("#ui-visibility-toggle").click();
    }
  }
}

async function assertReducedMotion(browser) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, reducedMotion: "reduce", hasTouch: true });
  try {
    const page = await context.newPage();
    const errors = collectErrors(page);
    await page.goto(baseUrl, { waitUntil: "networkidle" });
    await waitForWing(page, 1);
    assert.equal((await stageData(page)).playing, "false");
    await page.waitForTimeout(150);
    const frame = (await stageData(page)).frame;
    await page.waitForTimeout(150);
    assert.equal((await stageData(page)).frame, frame);
    await page.locator("#animation-toggle").tap();
    assert.equal((await stageData(page)).playing, "true", "Reduced motion must still allow explicit playback");
    await page.emulateMedia({ reducedMotion: "no-preference" });
    // Let the media-query change event reach the controller before changing it back.
    await page.waitForTimeout(100);
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.waitForTimeout(100);
    assert.equal((await stageData(page)).playing, "false");
    await assertNoHoverMessages(page);
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
}

async function assertAssetRecovery(browser) {
  for (const asset of ["wing.json", "displacements.bin"]) {
    const page = await browser.newPage();
    const uncaught = [];
    page.on("pageerror", (error) => uncaught.push(error.message));
    const pattern = `**/data/${asset}`;
    try {
      await page.route(pattern, (route) => route.abort("failed"));
      await page.goto(baseUrl, { waitUntil: "networkidle" });
      await page.locator("#wing-fallback").waitFor({ state: "visible" });
      assert.equal(await page.locator("#wing-loading").isHidden(), true);
      assert.equal(await page.locator("#retry-renderer").isEnabled(), true);
      await page.unroute(pattern);
      await page.locator("#retry-renderer").click();
      await waitForWing(page, 1);
      assert.equal(await page.locator("#wing-fallback").isHidden(), true);
      assert.deepEqual(uncaught, [], `Uncaught error during ${asset} recovery`);
    } finally {
      await page.close();
    }
  }
}

async function assertNoHoverMessages(page) {
  assert.equal(await page.locator('[title], svg title, [role="tooltip"], [data-tooltip]').count(), 0,
    "Hover messages are forbidden; retain aria-labels instead of title attributes");
  for (const selector of ["#animation-toggle", "#ui-visibility-toggle", "#reset-camera", "#mode-slider"]) {
    const element = page.locator(selector);
    if (await element.isVisible()) {
      await element.hover();
      assert.equal(await page.locator('[title], svg title, [role="tooltip"], [data-tooltip]').count(), 0);
    }
  }
}

async function assertTargets(page) {
  const targets = await page.locator("#mode-slider, #animation-toggle, #reset-camera, #ui-visibility-toggle")
    .evaluateAll((elements) => elements.map((element) => {
      const bounds = element.getBoundingClientRect();
      return { id: element.id, width: bounds.width, height: bounds.height };
    }));
  for (const target of targets) {
    assert.ok(target.width >= 44 && target.height >= 44, `${target.id} must provide a 44px touch target`);
  }
}

async function selectMode(page, mode) {
  await page.locator("#mode-slider").fill(String(mode));
  await waitForWing(page, mode);
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

async function setPlaying(page, playing) {
  if ((await stageData(page)).playing !== String(playing)) await page.locator("#animation-toggle").click();
  assert.equal((await stageData(page)).playing, String(playing));
}

async function stageData(page) {
  return page.locator("#wing-stage").evaluate((stage) => ({ ...stage.dataset }));
}

async function waitForWing(page, mode) {
  await page.waitForFunction((expected) => {
    const stage = document.querySelector("#wing-stage");
    return stage?.dataset.status === "ready" && stage.dataset.mode === String(expected) && Number(stage.dataset.frame) > 0;
  }, mode);
}

function collectErrors(page) {
  const errors = [];
  page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("requestfailed", (request) => errors.push(`${request.url()}: ${request.failure()?.errorText}`));
  page.on("response", (response) => { if (response.status() >= 400) errors.push(`${response.status()} ${response.url()}`); });
  return errors;
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
