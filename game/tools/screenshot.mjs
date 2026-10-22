#!/usr/bin/env node
// Smoke test + screenshots of the game: starts the vite dev server, drives the game in
// headless Chrome (puppeteer-core) and writes renders/game_*.png. Fails on console errors.
//   npm run shot:game          (CHROME_PATH=... to override the Chrome binary)
import { createServer } from 'vite';
import puppeteer from 'puppeteer-core';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const GAME = fileURLToPath(new URL('..', import.meta.url));
const OUT = join(GAME, '..', 'renders');
const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

await mkdir(OUT, { recursive: true });
const server = await createServer({ configFile: join(GAME, 'vite.config.js'), server: { port: 5179, strictPort: false }, logLevel: 'warn' });
await server.listen();
const url = server.resolvedUrls.local[0];
console.log('dev server:', url);

const args = ['--ignore-gpu-blocklist', '--enable-webgl', '--autoplay-policy=no-user-gesture-required'];
if (process.env.SWIFTSHADER) args.push('--use-angle=swiftshader', '--enable-unsafe-swiftshader');
const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args });
const problems = [];

async function open(viewport, query = '') {
  const page = await browser.newPage();
  await page.setViewport(viewport);
  page.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning') problems.push(`[${m.type()}] ${m.text()}`);
  });
  page.on('pageerror', (e) => problems.push(`[pageerror] ${e.message}`));
  page.on('response', (r) => { if (r.status() >= 400) problems.push(`[http ${r.status()}] ${r.url()}`); });
  page.on('requestfailed', (r) => problems.push(`[requestfailed] ${r.url()} ${r.failure()?.errorText}`));
  await page.goto(url + query, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__kubara?.ready, { timeout: 60000 });
  await sleep(1200);
  return page;
}
const shot = async (page, name) => {
  await page.screenshot({ path: join(OUT, name) });
  console.log('wrote', join(OUT, name));
};
const view = (page, yawOffset, pitch, dist) =>
  page.evaluate((y, p, d) => {
    const k = window.__kubara;
    k.setView(k.player.yaw * 180 / Math.PI + y, p, d);
  }, yawOffset, pitch, dist);

try {
  const page = await open({ width: 1280, height: 800, deviceScaleFactor: 1 });
  const fps = await page.evaluate(() => new Promise((res) => {
    let n = 0; const t0 = performance.now();
    const f = () => { n++; if (performance.now() - t0 < 1000) requestAnimationFrame(f); else res(n); };
    requestAnimationFrame(f);
  }));
  console.log('approx fps in headless chrome:', fps);

  // idle, seen from the front 3/4
  await view(page, 35, 12, 4.2);
  await sleep(900);
  await shot(page, 'game_idle.png');

  // walk sideways relative to the camera (profile view of the walk cycle)
  await view(page, 0, 14, 4.6);
  await sleep(300);
  await page.keyboard.down('KeyD');
  await sleep(1300);
  await shot(page, 'game_walk.png');
  await page.evaluate(() => window.__kubara.controls.minDistance = 1.5);
  await view(page, -80, 6, 2.4); // close profile of the stride while still walking
  await sleep(250);
  await shot(page, 'game_walk_close.png');
  await page.keyboard.up('KeyD');
  await page.evaluate(() => window.__kubara.controls.minDistance = 2.2);

  // run toward the onsen, camera follows from behind
  await page.keyboard.down('ShiftLeft');
  await page.keyboard.down('KeyA');
  await sleep(900);
  await page.keyboard.down('KeyW');
  await sleep(700);
  await shot(page, 'game_run.png');
  await page.keyboard.press('Space');
  await sleep(180);
  await shot(page, 'game_jump.png');
  await page.keyboard.up('KeyW');
  await page.keyboard.up('KeyA');
  await page.keyboard.up('ShiftLeft');
  await sleep(1200);

  // wave emote from the front
  await view(page, 25, 10, 3.6);
  await page.keyboard.press('KeyE');
  await sleep(700);
  await shot(page, 'game_wave.png');
  await sleep(2200);

  // walk into the pond (bathing capybara)
  const state = await page.evaluate(() => {
    const k = window.__kubara;
    k.player.pos.set(-5.5, 0, 4.0);
    k.player.yaw = 0;
    return { x: k.player.pos.x, z: k.player.pos.z };
  });
  console.log('teleported to pond edge', state);
  await sleep(400);
  await view(page, 140, 22, 5.5);
  await page.keyboard.down('KeyS');
  await sleep(1000);
  await page.keyboard.up('KeyS');
  await sleep(600);
  await view(page, 30, 18, 4.5);
  await sleep(500);
  await shot(page, 'game_pond.png');

  const info = await page.evaluate(() => ({ state: window.__kubara.character.state, collected: document.getElementById('count').textContent }));
  console.log('final state', info);
  await page.close();

  // phone layout with touch controls
  const mobile = await open({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true }, '?touch');
  await view(mobile, 30, 12, 4.8);
  await sleep(700);
  await shot(mobile, 'game_mobile.png');
  await mobile.close();
} finally {
  await browser.close();
  await server.close();
}

if (problems.length) {
  console.log(`\n${problems.length} console problem(s):`);
  for (const p of problems) console.log('  ' + p);
  process.exitCode = 1;
} else {
  console.log('\nno console errors or warnings');
}
