// Loads the app in headless Chrome, waits, reports console errors and saves screenshots.
// Usage: node scripts/screenshot.mjs [url] [outDir] [waitSeconds] [actions or actions-file]
// Actions (comma-separated, or one per line in a file):
//   click:<selector>  key:<key>  wait:<s>  select:<selector>=<value>  shot:<name>  eval:<js>
//   canvasclick:<fx>;<fy>   click at a fraction of the 3D viewport
import { chromium } from 'playwright';
import fs from 'node:fs';

const url = process.argv[2] ?? 'http://localhost:5173/';
const outDir = process.argv[3] ?? '/tmp/smell-shots';
const waitSeconds = Number(process.argv[4] ?? 12);
const actionArg = process.argv[5] ?? '';
const actions = (fs.existsSync(actionArg) ? fs.readFileSync(actionArg, 'utf8').split('\n') : actionArg.split(',')).map((a) => a.trim()).filter(Boolean);
fs.mkdirSync(outDir, { recursive: true });

const browser = await chromium.launch({
  channel: 'chrome',
  headless: true,
  args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: 1600, height: 950 }, deviceScaleFactor: 1 });
const errors = [];
page.on('console', (message) => {
  if (message.type() === 'error' || message.type() === 'warning') errors.push(`[${message.type()}] ${message.text()}`);
});
page.on('pageerror', (error) => errors.push(`[pageerror] ${error.message}\n${error.stack}`));
await page.goto(url, { waitUntil: 'load' });
await page.waitForTimeout(waitSeconds * 1000);
await page.screenshot({ path: `${outDir}/01-initial.png` });

for (const [index, action] of actions.entries()) {
  const colon = action.indexOf(':');
  const kind = action.slice(0, colon);
  const arg = action.slice(colon + 1);
  if (kind === 'click') await page.click(arg);
  else if (kind === 'key') await page.keyboard.press(arg);
  else if (kind === 'wait') await page.waitForTimeout(Number(arg) * 1000);
  else if (kind === 'select') {
    const [selector, value] = arg.split('=');
    await page.selectOption(selector, value);
  } else if (kind === 'shot') await page.screenshot({ path: `${outDir}/${String(index + 2).padStart(2, '0')}-${arg}.png` });
  else if (kind === 'eval') console.log('eval:', await page.evaluate(arg));
  else if (kind === 'canvasclick') {
    const [fx, fy] = arg.split(';').map(Number);
    const box = await page.locator('#viewport canvas').first().boundingBox();
    await page.mouse.click(box.x + box.width * fx, box.y + box.height * fy);
  }
}

const glInfo = await page.evaluate(() => {
  const canvas = document.querySelector('#viewport canvas');
  const gl = canvas?.getContext('webgl2');
  if (!gl) return 'no webgl2';
  const ext = gl.getExtension('WEBGL_debug_renderer_info');
  return ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : 'unknown renderer';
});
console.log('renderer:', glInfo);
console.log(errors.length ? errors.join('\n') : 'no console errors');
await browser.close();
