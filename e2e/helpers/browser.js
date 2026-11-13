// Browser side of the e2e harness: one Chromium per test file, one fresh
// context (own localStorage, own service worker) per test.
import { chromium } from 'playwright';

/**
 * Launches Chromium. A missing browser is an error, never a skip: CI must not
 * pass on zero executed tests.
 */
export async function launchBrowser() {
  try {
    return await chromium.launch();
  } catch (err) {
    throw new Error(
      'Could not start Chromium for the e2e tests. Install it with '
      + '`npx playwright install chromium` (on CI: `npx playwright install --with-deps chromium`).\n'
      + `Original error: ${err.message}`,
    );
  }
}

/**
 * New context + page on the app under test.
 * - German locale and dark colour scheme by default, so the pre-paint script
 *   in index.html picks a known language and theme.
 * - Service workers are blocked unless `serviceWorkers: 'allow'` is passed:
 *   the worker would otherwise sit between the page and every request.
 * - Every request off the app's origin (Google Fonts, favicon service) is
 *   aborted, so the suite never touches the network.
 */
export async function openPage(browser, baseUrl, {
  locale = 'de-DE',
  colorScheme = 'dark',
  serviceWorkers = 'block',
  path = '/',
  goto = true,
} = {}) {
  const context = await browser.newContext({ locale, colorScheme, serviceWorkers, acceptDownloads: true });
  await context.route((url) => url.origin !== baseUrl, (route) => route.abort());
  // Fail fast: a missing element should not hold a test for 30 s.
  context.setDefaultTimeout(10_000);
  const page = await context.newPage();
  if (goto) await page.goto(baseUrl + path);
  return { context, page };
}

/** Enters a URL and submits it with Enter, as a user would. */
export async function convert(page, url) {
  await page.locator('#url-input').fill(url);
  await page.locator('#url-input').press('Enter');
}

/** The markdown shown in the raw view: one `.ln` span per line. */
export function rawViewText(page) {
  return page.$$eval('#result .ln', (lines) => lines.map((l) => l.textContent).join('\n'));
}

/** Waits until a conversion result is visible and returns the raw view text. */
export async function waitForResult(page) {
  await page.locator('#result-container.visible').waitFor();
  return rawViewText(page);
}

/** Waits until the error box is visible and returns its text. */
export async function waitForError(page) {
  await page.locator('#error.visible').waitFor();
  return page.locator('#error').innerText();
}
