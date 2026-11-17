/**
 * Her browser.
 *
 * CloakBrowser (stealth Chromium, drop-in Playwright), headed under Xvfb in
 * production. If cloakbrowser is not there, or CHROME_PATH is set, or
 * BROWSER=playwright, it falls back to plain playwright-core Chromium.
 *
 * Not a persistent profile: the console login is a Playwright storageState
 * kept in Mongo (halcyra_session) and handed to the context here, so it
 * survives redeploys.
 */
import { say } from './log.js';

export async function openBrowser({ headless = false, executablePath, flavour = '', width = 1280, height = 720, proxy, storageState, extraArgs = [], canvasNoise = false } = {}) {
  const args = [
    ...extraArgs,
    '--autoplay-policy=no-user-gesture-required',
    '--disable-dev-shm-usage',
    `--window-size=${width},${height}`,
    '--window-position=0,0',
  ];
  // headed (production, under Xvfb): no viewport emulation, the page is the real
  // window, which fullscreenWindow() then blows up to the whole display. A fixed
  // emulated viewport inside a real window leaves the browser's own bars on the
  // screen the stream grabs. Headless: a fixed viewport.
  const viewport = headless ? { width, height } : null;
  const contextOptions = {
    viewport,
    ...(storageState ? { storageState } : {}),
  };
  if (!executablePath && flavour !== 'playwright') {
    try {
      const cb = await import('cloakbrowser');
      // cloakbrowser adds fingerprint noise to canvas pixel reads by default
      // (measured: 15 of 192 values of a flat grey canvas changed). Her eye reads
      // the game through a canvas, so that noise would be input nobody put
      // there: it is switched off unless CANVAS_NOISE=on.
      const cbArgs = canvasNoise ? args : ['--fingerprint-noise=false', ...args];
      const context = await cb.launchContext({
        headless, args: cbArgs, humanize: false, proxy, geoip: Boolean(proxy),
        viewport, contextOptions: storageState ? { storageState } : undefined,
      });
      say(`browser up (cloakbrowser${canvasNoise ? ', canvas noise on' : ', canvas noise off'})`, { kind: 'browser' });
      return { context, browser: context.browser(), flavour: 'cloakbrowser' };
    } catch (e) {
      say(`cloakbrowser unavailable (${String(e.message).split('\n')[0].slice(0, 140)}), using playwright-core Chromium`, { kind: 'browser' });
    }
  }
  const { chromium } = await import('playwright-core');
  const browser = await chromium.launch({
    headless,
    executablePath: executablePath || process.env.PLAYWRIGHT_CHROMIUM || undefined,
    args: ['--no-sandbox', ...args],
    proxy: proxy ? { server: proxy } : undefined,
  });
  const context = await browser.newContext(contextOptions);
  say(`browser up (playwright-core${executablePath ? `, ${executablePath}` : ''})`, { kind: 'browser' });
  return { context, browser, flavour: 'playwright' };
}

/**
 * Headed only: make the page's window fullscreen (no tab strip, no address
 * bar), through CDP. --kiosk is not reliable for windows Playwright opens.
 * Note for anyone capturing frames: Page.captureScreenshot with a clip.scale
 * re-renders the visible window at that scale for a moment, which shows up on
 * the display (and in an x11grab stream) as flicker. Plain screenshots do not.
 */
export async function fullscreenWindow(page) {
  try {
    const cdp = await page.context().newCDPSession(page);
    const { windowId } = await cdp.send('Browser.getWindowForTarget');
    await cdp.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'fullscreen' } });
    await cdp.detach().catch(() => {});
    return true;
  } catch (e) {
    say(`could not make the window fullscreen: ${String(e.message).split('\n')[0]}`, { kind: 'browser' });
    return false;
  }
}
