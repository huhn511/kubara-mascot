#!/usr/bin/env node
// Loads the production build (game/dist) through `vite preview` in headless Chrome and
// checks that the mascot loads without console errors.  npm run build:game && node game/tools/check-build.mjs
import { preview } from 'vite';
import puppeteer from 'puppeteer-core';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const GAME = fileURLToPath(new URL('..', import.meta.url));
const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const server = await preview({ configFile: join(GAME, 'vite.config.js'), preview: { port: 4179 } });
const url = server.resolvedUrls.local[0];
const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--ignore-gpu-blocklist'] });
const problems = [];
try {
  const page = await browser.newPage();
  page.on('console', (m) => { if (['error', 'warning'].includes(m.type())) problems.push(m.text()); });
  page.on('pageerror', (e) => problems.push(e.message));
  page.on('response', (r) => { if (r.status() >= 400) problems.push(`http ${r.status()} ${r.url()}`); });
  await page.goto(url, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__kubara?.ready, { timeout: 30000 });
  const parts = await page.evaluate(() => Object.keys(window.__kubara.character.parts));
  console.log('build OK at', url, '- animated parts:', parts.join(', '));
} finally {
  await browser.close();
  await new Promise((r) => server.httpServer.close(r));
}
if (problems.length) { console.log(problems.join('\n')); process.exitCode = 1; } else console.log('no console errors');
