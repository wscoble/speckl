import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';

const dist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist');

async function settled(page: Page): Promise<void> {
  await expect(page.locator('#status')).toHaveAttribute('data-state', /done|error|timeout/);
}

function walk(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const out: string[] = [];
  for (const name of fs.readdirSync(dir)) {
    const child = path.join(dir, name);
    if (fs.statSync(child).isDirectory()) out.push(...walk(child));
    else out.push(child);
  }
  return out;
}

test.beforeEach(async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (err) => errors.push(String(err)));
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(msg.text());
  });
  (page as Page & { __errors?: string[] }).__errors = errors;
});

test.afterEach(async ({ page }) => {
  const errors = (page as Page & { __errors?: string[] }).__errors ?? [];
  expect(errors, errors.join('\n')).toEqual([]);
});

test('loads DeployGate and compiles AGENTS.md plus the hook', async ({ page }) => {
  await page.goto('/');
  await settled(page);
  await expect(page.locator('#spec')).toHaveValue(/speck DeployGate/);
  await expect(page.locator('#output')).toContainText('Call-bound');
  await expect(page.locator('#diagnostics')).toContainText('Proofs are not run in the browser');
  await expect(page.locator('#diagnostics')).not.toContainText('output line');
  await expect(page.locator('#diagnostics')).not.toContainText('.ir.smt2');
  await expect.poll(() => page.evaluate(() => location.hash)).toBe('');
  await page.getByRole('button', { name: 'hook.mjs' }).click();
  await expect(page.locator('#output')).toContainText('pre');
  await expect(page.locator('#status')).toHaveAttribute('data-state', 'done');
});

test('editing the spec updates diagnostics and output', async ({ page }) => {
  await page.goto('/');
  await settled(page);
  await page.locator('#spec').fill('not a speck\n');
  await expect(page.locator('#diagnostics')).toContainText('No `speck');
  await expect(page.locator('#status')).toHaveAttribute('data-state', 'error');
  await page.getByRole('button', { name: 'Toggle switch' }).click();
  await page.getByRole('button', { name: 'Discard and load' }).click();
  await expect(page.locator('#output')).toContainText(/ToggleSwitch|toggle/i);
  await expect(page.locator('#diagnostics')).not.toContainText('no agent block');
  await page.locator('#target').selectOption('agent');
  await expect(page.locator('#diagnostics')).toContainText('no agent block');
});

test('empty editor and deleting the spec stay readable', async ({ page }) => {
  await page.goto('/');
  await settled(page);
  await page.locator('#spec').fill('speck Temp {\n state { x: Nat }\n}\n');
  await settled(page);
  await page.locator('#spec').fill('');
  await expect(page.locator('#diagnostics')).toContainText('Nothing to compile');
  await expect(page.locator('#status')).toHaveAttribute('data-state', 'done');
  await expect(page.locator('#copy-file')).toBeDisabled();
  await expect(page.locator('#output')).toContainText('No output');
});

test('garbage, binary text, and a refused oversized paste', async ({ page }) => {
  await page.goto('/');
  await settled(page);
  await page.locator('#spec').fill('@@@@\nhello\n');
  await expect(page.locator('#diagnostics')).toContainText('No `speck');

  await page.locator('#spec').evaluate((el: HTMLTextAreaElement) => {
    el.value = 'speck S {\0 state { x: Nat } }\n';
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await expect(page.locator('#diagnostics')).toContainText('binary');

  const refused = await page.evaluate(() => {
    const text = 'x'.repeat(2_200_000);
    const dt = new DataTransfer();
    dt.setData('text/plain', text);
    const el = document.querySelector('#spec') as HTMLTextAreaElement;
    const before = el.value;
    const ev = new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: dt });
    el.dispatchEvent(ev);
    return { prevented: ev.defaultPrevented, same: el.value === before };
  });
  expect(refused.prevented).toBe(true);
  expect(refused.same).toBe(true);
  await expect(page.locator('#banner')).toContainText(/limit/);
});

test('a megabyte of spec text and ten thousand lines still return', async ({ page }) => {
  test.setTimeout(90_000);
  await page.goto('/');
  await settled(page);
  await page.locator('#spec').evaluate((el: HTMLTextAreaElement) => {
    el.value = 'speck Big {\n' + '// line\n'.repeat(10_000) + ' state { x: Nat }\n}\n';
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await settled(page);
  await expect(page.locator('#status')).toHaveAttribute('data-state', 'done');

  await page.locator('#spec').evaluate((el: HTMLTextAreaElement) => {
    el.value = 'speck Big {\n // ' + 'x'.repeat(1_100_000) + '\n state { x: Nat }\n}\n';
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await settled(page);
  await expect(page.locator('#status')).not.toHaveAttribute('data-state', 'compiling');
  await page.getByRole('button', { name: 'DeployGate' }).click();
  await page.getByRole('button', { name: 'Discard and load' }).click();
  await expect(page.locator('#output')).toContainText('Call-bound');
});

test('deep nesting and a very long line do not lock the page', async ({ page }) => {
  await page.goto('/');
  await settled(page);
  await page.locator('#spec').evaluate((el: HTMLTextAreaElement) => {
    el.value = 'speck S {\n constraint C: ' + '('.repeat(4_000) + 'true' + ')'.repeat(4_000) + '\n state { x: Nat }\n}\n';
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await settled(page);
  await expect(page.locator('#theme')).toBeEnabled();

  await page.locator('#spec').evaluate((el: HTMLTextAreaElement) => {
    el.value = 'speck S {\n // ' + 'x'.repeat(50_000) + '\n state { x: Nat }\n}\n';
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await expect(page.locator('#diagnostics')).toContainText('characters on one line');
  await page.locator('#theme').focus();
  await expect(page.locator('#theme')).toBeFocused();
});

test('unicode, emoji, RTL, tabs, and CRLF compile', async ({ page }) => {
  await page.goto('/');
  await settled(page);
  await page.locator('#spec').evaluate((el: HTMLTextAreaElement) => {
    el.value = 'speck S {\r\n\tstate {\r\n\t\tx: Nat\r\n\t}\r\n\t// مرحبا 😀\r\n}\r\n';
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await settled(page);
  await expect(page.locator('#status')).toHaveAttribute('data-state', 'done');
  await expect(page.locator('#diagnostics')).not.toContainText('binary');
  await expect(page.locator('#spec')).toHaveValue(/مرحبا 😀/);
});

test('a damaged share link and a tampered hash do not crash', async ({ page }) => {
  await page.goto('/#s1.!!!!');
  await expect(page.locator('#banner')).toContainText(/damaged|edited/i);
  await expect(page.locator('#spec')).toHaveValue(/speck DeployGate/);
  await settled(page);

  await page.goto('/#garbage');
  await expect(page.locator('#banner')).toContainText(/not a Speckl playground link/i);
  await page.goto('/#s3.abcd');
  await expect(page.locator('#banner')).toContainText(/version s3/);
  await page.goto('/#s2.abcd');
  await expect(page.locator('#banner')).toContainText(/cut off/i);

  await page.goto('/');
  await settled(page);
  await page.locator('#share').click();
  const href = await page.evaluate(() => location.href);
  expect(href).toContain('#s2.');
  await page.goto(href.slice(0, -6));
  await expect(page.locator('#banner')).toContainText(/cut off/i);
  await page.goto(href + 'zzz');
  await expect(page.locator('#banner')).toContainText(/cut off|edited/i);
  await expect(page.locator('#spec')).toHaveValue(/speck DeployGate/);
  await expect(page.locator('h1')).toHaveText('Playground');
});

test('a timeout query without the test hook still compiles', async ({ page }) => {
  await page.goto('/?timeout=1');
  await settled(page);
  await expect(page.locator('#output')).toContainText('Call-bound');
  await expect(page.locator('#status')).toHaveAttribute('data-state', 'done');
});

test('a spinning compile is cancelled and does not freeze the page', async ({ page }) => {
  await page.goto('/?spin=1&timeout=400');
  await expect(page.locator('#output')).toContainText('Call-bound');
  await page.locator('#spec').evaluate((el: HTMLTextAreaElement) => {
    el.value = 'speck Spin {\n /*__SPECKL_SPIN__*/\n state { x: Nat }\n}\n';
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await expect(page.locator('#status')).toHaveAttribute('data-state', 'timeout');
  await expect(page.locator('#diagnostics')).toContainText(/stopped/i);
  await page.getByRole('button', { name: 'Toggle switch' }).click();
  await page.getByRole('button', { name: 'Discard and load' }).click();
  await settled(page);
  await expect(page.locator('#status')).toHaveAttribute('data-state', 'done');
});

test('rapid edits do not leave a stale diagnostic', async ({ page }) => {
  await page.goto('/');
  await settled(page);
  const later = 'speck Rapid {\n state { x: Nat }\n action Go { x := 1 }\n}\n';
  await page.locator('#spec').fill('this is garbage');
  await page.locator('#spec').fill(later);
  await expect(page.locator('#output')).toContainText('Rapid');
  await expect(page.locator('#status')).toHaveAttribute('data-state', 'done');
  await page.waitForTimeout(500);
  await expect(page.locator('#diagnostics')).not.toContainText('No `speck');
  await expect(page.locator('#spec')).toHaveValue(later);
});

test('switching examples asks before discarding edits', async ({ page }) => {
  await page.goto('/');
  await settled(page);
  await page.locator('#spec').fill('speck Edited {\n state { x: Nat }\n}\n');
  await page.getByRole('button', { name: 'Toggle switch' }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.getByRole('button', { name: 'Keep editing' }).click();
  await expect(page.locator('#spec')).toHaveValue(/speck Edited/);
  await page.getByRole('button', { name: 'Toggle switch' }).click();
  await page.keyboard.press('Escape');
  await expect(page.locator('#spec')).toHaveValue(/speck Edited/);
  await page.getByRole('button', { name: 'Agent policy' }).click();
  await page.getByRole('button', { name: 'Discard and load' }).click();
  await expect(page.locator('#spec')).toHaveValue(/speck AgentPolicy/);
  await expect(page.locator('#output')).toContainText(/run_tests|AgentPolicy/);
});

test('back, forward, and refresh restore the spec', async ({ page }) => {
  await page.goto('/');
  await settled(page);
  await page.getByRole('button', { name: 'Agent policy' }).click();
  await expect(page.locator('#spec')).toHaveValue(/speck AgentPolicy/);
  await page.goBack();
  await expect(page.locator('#spec')).toHaveValue(/speck DeployGate/);
  await page.goForward();
  await expect(page.locator('#spec')).toHaveValue(/speck AgentPolicy/);

  const unique = 'speck RefreshMe {\n state { x: Nat }\n action Go { x := 1 }\n}\n';
  const beforeHash = await page.evaluate(() => location.hash);
  await page.locator('#spec').fill(unique);
  await expect.poll(() => page.evaluate(() => location.hash)).not.toBe(beforeHash);
  await page.reload();
  await expect(page.locator('#spec')).toHaveValue(unique);
  await settled(page);
});

test('keyboard use, copy buttons, and the cursor line', async ({ page }) => {
  await page.goto('/');
  await settled(page);
  await page.locator('.skip').focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('#spec')).toBeFocused();
  await page.locator('#spec').press('Control+End');
  await expect(page.locator('#cursor')).not.toHaveText('Line 1, column 1');

  await page.locator('#copy-file').focus();
  await page.keyboard.press('Enter');
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toContain('Call-bound');

  await page.locator('#share').click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toContain('#s2.');

  await page.locator('#theme').focus();
  await page.keyboard.press('Enter');
  await expect.poll(() => page.evaluate(() => document.documentElement.getAttribute('data-theme'))).toBe('dark');
});

test('dark and light follow the operating system', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.goto('/');
  const dark = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  expect(dark).toBe('rgb(35, 35, 43)');

  await page.emulateMedia({ colorScheme: 'light' });
  await page.reload();
  const light = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  expect(light).toBe('rgb(246, 241, 231)');
});

test('phone and small laptop layouts fit the viewport', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await settled(page);
  await expect(page.locator('#spec')).toBeVisible();
  await expect(page.locator('#output')).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);

  await page.setViewportSize({ width: 1280, height: 800 });
  await page.reload();
  await settled(page);
  const box = await page.locator('.workspace').boundingBox();
  expect(box && box.width).toBeGreaterThan(1000);
  const editor = await page.locator('#spec').boundingBox();
  const out = await page.locator('#output').boundingBox();
  expect(editor).not.toBeNull();
  expect(out).not.toBeNull();
  expect(editor!.x).toBeLessThan(out!.x);
});

test('stays usable under CPU throttle and after the network drops', async ({ page }) => {
  test.setTimeout(90_000);
  const client = await page.context().newCDPSession(page);
  await client.send('Emulation.setCPUThrottlingRate', { rate: 6 });
  await page.goto('/');
  await expect(page.locator('#output')).toContainText('Call-bound');
  await client.send('Emulation.setCPUThrottlingRate', { rate: 1 });

  await page.context().setOffline(true);
  await page.locator('#spec').fill('speck OfflineSpec {\n state { x: Nat }\n action Go { x := 1 }\n}\n');
  await expect(page.locator('#output')).toContainText('OfflineSpec');
  await page.context().setOffline(false);
});

test('spec text that looks like HTML is not executed', async ({ page }) => {
  await page.goto('/');
  await settled(page);
  const before = await page.locator('script').count();
  let dialogs = 0;
  page.on('dialog', async (dialog) => {
    dialogs += 1;
    await dialog.dismiss();
  });
  const payload = '<img src=x onerror="window.__xss=1"><script>window.__xss=1</script>';
  await page.locator('#spec').fill(`speck S {\n  // ${payload}\n  verify "${payload}"\n  state { x: Nat }\n}\n`);
  await expect(page.locator('#diagnostics')).toContainText(/Parse error|unsupported verify/);
  expect(await page.evaluate(() => (window as unknown as { __xss?: number }).__xss ?? 0)).toBe(0);
  expect(await page.locator('script').count()).toBe(before);
  const html = await page.locator('#diagnostics').innerHTML();
  expect(html).not.toContain('<script>window');
  expect(html).toContain('&lt;script');
  expect(dialogs).toBe(0);
});

test('without JavaScript the fallback message is visible', async ({ browser }) => {
  const context = await browser.newContext({ javaScriptEnabled: false });
  const page = await context.newPage();
  await page.goto('/');
  await expect(page.locator('.noscript')).toContainText('needs JavaScript');
  await expect(page.locator('#boot')).toContainText('JavaScript did not start');
  await context.close();
});

test('review findings: errors, empty editor, target files, and polish', async ({ page }) => {
  const html = await (await page.request.get('/')).text();
  expect(html).toContain('Compiling…');
  expect(html).toContain('Load an example');
  expect(html).toContain('speck Name');

  await page.goto('/');
  await settled(page);
  await expect(page.locator('.lede')).toContainText('AGENTS.md');
  await expect(page.getByRole('link', { name: 'Language reference' })).toHaveAttribute('href', /speckdl\/SPEC\.md/);
  await expect(page.getByRole('link', { name: 'Language reference' })).toHaveAttribute('target', '_blank');
  await expect(page.getByRole('link', { name: 'Source' })).toHaveAttribute('rel', /noopener/);
  await expect(page.getByRole('link', { name: 'Docs' })).toHaveAttribute('href', /speckl-by-example\.md/);
  await expect(page.locator('#examples')).toContainText('Call-bound sign-off');

  await page.locator('#spec').fill('');
  await settled(page);
  await expect(page.locator('#spec')).toHaveAttribute('placeholder', /Load an example/i);
  await expect(page.locator('#file')).toContainText(/Load an example/i);
  await page.getByRole('button', { name: 'Toggle switch' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.locator('#spec')).toHaveValue(/isOn := false/);

  const base = await page.locator('#spec').inputValue();
  await page.locator('#spec').fill(`${base}\nthis is trailing garbage !!!\n`);
  await expect(page.locator('#diagnostics')).toContainText(/unexpected text after end of speck/);
  await expect(page.locator('#status')).not.toContainText(/Compiled \d+ file/);

  await page.locator('#spec').fill('speck S {\n  state {\n    checksPassed: Booll\n  }\n  action Go {\n    requires stage == 1\n    bogus := 1\n  }\n}\n');
  await expect(page.locator('#diagnostics')).toContainText('unknown type "Booll"');
  await expect(page.locator('#diagnostics')).toContainText(/Did you mean `require`/);
  await expect(page.locator('#diagnostics')).toContainText('undeclared variable "bogus"');
  await expect(page.locator('#error-chip')).toContainText(/error/);
  await page.setViewportSize({ width: 390, height: 700 });
  const chip = await page.locator('#error-chip').boundingBox();
  const editorBox = await page.locator('#spec').boundingBox();
  expect(chip).not.toBeNull();
  expect(editorBox).not.toBeNull();
  expect(chip!.y).toBeLessThan(editorBox!.y + editorBox!.height + 120);
  await page.locator('#error-chip').click();
  await expect(page.locator('#spec')).toBeFocused();
  await page.setViewportSize({ width: 1280, height: 800 });

  await page.locator('#spec').fill('speck S {\n  state {\n    x: Nat\n  }\n  action Go { x := 1 }\n  action Go { x := 2 }\n}\n');
  await expect(page.locator('#diagnostics')).toContainText('duplicate action "Go"');

  await page.getByRole('button', { name: 'DeployGate' }).click();
  await page.getByRole('button', { name: 'Discard and load' }).click();
  await settled(page);
  await page.locator('#target').selectOption('openapi');
  await settled(page);
  await expect(page.locator('#file')).not.toContainText(/\.ts$/);
  const file = await page.locator('#file').inputValue();
  expect(file).toMatch(/openapi/i);

  await page.evaluate(() => { (document.body.style as CSSStyleDeclaration & { zoom?: string }).zoom = '1.75'; });
  const clip = await page.locator('#diagnostics').evaluate((el) => el.scrollHeight - el.clientHeight);
  expect(clip).toBeLessThan(8);

  const copiedAt = await page.evaluate(() => performance.now());
  await page.locator('#copy-file').click();
  await expect(page.locator('#copy-file')).toHaveText('Copied');
  await expect(page.locator('#copy-file')).toHaveText('Copy file', { timeout: 4000 });
  const copiedElapsed = await page.evaluate((t0) => performance.now() - t0, copiedAt);
  expect(copiedElapsed).toBeGreaterThan(1800);
  expect(copiedElapsed).toBeLessThan(2700);

  await page.goto('/#garbage');
  await expect(page.locator('#banner')).toBeVisible();
  await expect.poll(() => page.evaluate(() => location.hash)).toBe('');
});

test('round 2: unclosed blocks, stale output, and a failed compiler load', async ({ page }) => {
  const html = await (await page.request.get('/')).text();
  expect(html).toContain("Couldn't load the compiler. Refresh the page.");
  expect(html).toContain('no-cache');

  await page.goto('/');
  await settled(page);
  await page.getByRole('button', { name: 'Toggle switch' }).click();
  await settled(page);
  await expect(page.locator('#diagnostics')).not.toContainText(/no agent block/);
  await page.locator('#target').selectOption('agent');
  await settled(page);
  await expect(page.locator('#diagnostics')).toContainText(/no agent block/);
  await expect(page.locator('#diagnostics')).toContainText(/does not drive an agent/);

  await page.getByRole('button', { name: 'DeployGate' }).click();
  await settled(page);
  const full = await page.locator('#spec').inputValue();
  await expect(page.locator('#output')).toContainText('Call-bound');
  await page.locator('#spec').fill(full.split('\n').slice(0, 40).join('\n'));
  await expect(page.locator('#diagnostics')).toContainText(/missing `}`: block opened at line 1 is never closed/);
  await expect(page.locator('#status')).toContainText('Did not compile');
  await expect(page.locator('#status')).not.toContainText(/Compiled \d+ file/);
  await expect(page.locator('#stale')).toBeVisible();
  await expect(page.locator('#output')).toHaveClass(/stale/);
  await expect(page.locator('#output')).toContainText('Call-bound');

  const lines = full.split('\n');
  const brace = lines.findIndex((line) => line.includes('action RunChecks'));
  lines[brace] = lines[brace].replace('action RunChecks {', 'action RunChecks {{');
  await page.locator('#spec').fill(lines.join('\n'));
  await expect(page.locator('#diagnostics')).toContainText(/unexpected `\{`/);
  await expect(page.locator('#diagnostics')).toContainText(new RegExp(`line ${brace + 1}`, 'i'));

  lines[brace] = '    action {';
  await page.locator('#spec').fill(lines.join('\n'));
  await expect(page.locator('#diagnostics')).toContainText(/action is missing a name/);
  await expect(page.locator('#diagnostics')).not.toContainText('undeclared variable "checksPassed"');

  await page.setViewportSize({ width: 1000, height: 500 });
  const lede = await page.locator('.lede').evaluate((el) => {
    const style = getComputedStyle(el);
    return {
      clamp: style.webkitLineClamp,
      clipped: el.scrollHeight - el.clientHeight,
      text: el.textContent ?? '',
    };
  });
  expect(lede.clamp).toBe('none');
  expect(lede.clipped).toBeLessThan(2);
  expect(lede.text).toContain('nothing is uploaded');
  const theme = await page.locator('#theme').boundingBox();
  expect(theme).not.toBeNull();
  expect(theme!.x).toBeGreaterThanOrEqual(0);
  expect(theme!.x + theme!.width).toBeLessThanOrEqual(1001);
  await page.setViewportSize({ width: 1280, height: 800 });
});

test('round 3: comments, same-line fields, hash wording, and paste cost', async ({ page }) => {
  await page.goto('/#garbage');
  await expect(page.locator('#banner')).toContainText('An example was loaded instead');
  await expect(page.locator('#banner')).toContainText(/not a Speckl playground link/i);
  await expect(page.locator('#spec')).toHaveValue(/speck DeployGate/);
  const coldBanner = await page.locator('#banner').boundingBox();
  const coldSpec = await page.locator('#spec').boundingBox();
  expect(coldBanner).not.toBeNull();
  expect(coldSpec).not.toBeNull();
  expect(coldBanner!.y + coldBanner!.height).toBeLessThanOrEqual(coldSpec!.y + 1);

  await page.goto('/');
  await settled(page);
  const kept = await page.locator('#spec').inputValue();
  await page.evaluate(() => { location.hash = '#garbage'; });
  await expect(page.locator('#banner')).toContainText('left unchanged');
  await expect(page.locator('#banner')).not.toContainText('example was loaded');
  await expect.poll(() => page.evaluate(() => location.hash)).toBe('');
  expect(await page.locator('#spec').inputValue()).toBe(kept);
  const banner = await page.locator('#banner').boundingBox();
  const spec = await page.locator('#spec').boundingBox();
  expect(banner).not.toBeNull();
  expect(spec).not.toBeNull();
  expect(banner!.y + banner!.height).toBeLessThanOrEqual(spec!.y + 1);

  await page.locator('#spec').fill('speck S {\n  // {\n  state { x: Nat }\n  init { x := 0 // set { to zero\n  }\n  // }\n  action Go { x := 1 }\n}\n');
  await settled(page);
  await expect(page.locator('#status')).toHaveAttribute('data-state', 'done');
  await expect(page.locator('#diagnostics')).not.toContainText(/unexpected `\}`|missing `\}`/);

  await page.locator('#spec').fill('speck T {\n state { ready: Bool\n n: Nat }\n action Go { ready := true }\n}\n');
  await settled(page);
  await expect(page.locator('#diagnostics')).not.toContainText('undeclared variable "ready"');
  await expect(page.locator('#status')).toHaveAttribute('data-state', 'done');

  await page.locator('#spec').fill('speck S {\n  state { ready: Boolean }\n}\n');
  await expect(page.locator('#diagnostics')).toContainText(/Line 2, column \d+:/);
  await expect(page.locator('#diagnostics')).toContainText('unknown type "Boolean"');
  await expect(page.locator('#diagnostics')).toContainText(/Did you mean `Bool`/);

  await page.locator('#spec').fill('speck S {\n  state { ready Bool }\n}\n');
  await expect(page.locator('#diagnostics')).toContainText(/missing a colon/);

  await page.locator('#spec').fill('speck S {\n  action action {}\n}\n');
  await expect(page.locator('#diagnostics')).toContainText(/action name "action" is a keyword/);

  await page.locator('#spec').click();
  const samples = [
    { name: '5k', text: '// x\n'.repeat(5_000), accept: true },
    { name: '12k', text: '// x\n'.repeat(12_000), accept: true },
    { name: '30k', text: '// x\n'.repeat(30_000), accept: false },
    { name: '1.2mb', text: `speck Big {\n // ${'x'.repeat(1_200_000)}\n}\n`, accept: true },
    { name: '2mb', text: `speck Big {\n // ${'x'.repeat(1_900_000)}\n}\n`, accept: false },
  ];
  const pastePerf: { name: string; long: number[]; chars: number }[] = [];
  for (const sample of samples) {
    await page.locator('#spec').evaluate((el: HTMLTextAreaElement) => {
      el.focus();
      el.setSelectionRange(0, el.value.length);
    });
    await page.evaluate(async (text) => {
      await navigator.clipboard.writeText(text);
      const bag: number[] = [];
      const obs = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) bag.push(entry.duration);
      });
      obs.observe({ entryTypes: ['longtask'] });
      (window as unknown as { __pasteLong?: number[]; __pasteObs?: PerformanceObserver }).__pasteLong = bag;
      (window as unknown as { __pasteObs?: PerformanceObserver }).__pasteObs = obs;
    }, sample.text);
    await page.locator('#spec').press('Control+V');
    await page.waitForTimeout(50);
    const measured = await page.evaluate(() => {
      const w = window as unknown as { __pasteLong?: number[]; __pasteObs?: PerformanceObserver };
      w.__pasteObs?.disconnect();
      return {
        long: w.__pasteLong ?? [],
        chars: (document.querySelector('#spec') as HTMLTextAreaElement).value.length,
      };
    });
    pastePerf.push({ name: sample.name, long: measured.long, chars: measured.chars });
    if (sample.accept) expect(measured.chars, sample.name).toBe(sample.text.length);
    else {
      expect(measured.chars, sample.name).not.toBe(sample.text.length);
      await expect(page.locator('#banner')).toContainText(sample.name === '30k' ? /12,000 line/ : /1\.5 MB/);
    }
    expect(Math.max(0, ...measured.long), sample.name).toBeLessThan(200);
  }
  console.log('PASTE_PERF ' + JSON.stringify(pastePerf));
});

test('round 4: names, types, stray brace, and a steady error chip', async ({ page }) => {
  await page.goto('/');
  await settled(page);
  const quiet = await page.locator('#spec').boundingBox();
  await page.goto('/#garbage');
  await expect(page.locator('#banner')).toBeVisible();
  const loud = await page.locator('#spec').boundingBox();
  expect(quiet).not.toBeNull();
  expect(loud).not.toBeNull();
  expect(Math.abs(quiet!.y - loud!.y)).toBeLessThan(4);

  await page.goto('/');
  await settled(page);
  await expect(page.locator('#file')).toContainText(/AGENTS\.md|hook\.mjs/);
  const full = await page.locator('#spec').inputValue();
  await page.locator('#spec').fill(full.replace('speck DeployGate', 'speck 2fast'));
  await expect(page.locator('#diagnostics')).toContainText(/names must start with a letter/);
  await expect(page.locator('#stale')).toBeHidden();
  await expect(page.locator('#file')).not.toContainText('AGENTS.md');
  await expect(page.locator('#output')).not.toContainText('Call-bound');

  await page.locator('#spec').fill('speck My Spec {\n  state { x: Nat }\n}\n');
  await expect(page.locator('#diagnostics')).toContainText("spec names can't contain spaces");

  await page.locator('#spec').fill('speck S {\n  state { ready: Bool }\n  action Go { require foo == 1\n    ready := true }\n}\n');
  await expect(page.locator('#diagnostics')).toContainText(/Line \d+, column \d+:/);
  await expect(page.locator('#diagnostics')).toContainText('undeclared variable "foo"');

  await page.locator('#spec').fill('speck S {\n  state { ready: Bool }\n  action Go { ready := 5 }\n}\n');
  await expect(page.locator('#diagnostics')).toContainText(/cannot assign a number to Bool variable "ready"/);

  await page.setViewportSize({ width: 1920, height: 1113 });
  const chip = await page.locator('#error-chip').boundingBox();
  const editor = await page.locator('#spec').boundingBox();
  expect(chip).not.toBeNull();
  expect(editor).not.toBeNull();
  expect(chip!.y).toBeLessThan(editor!.y);
  expect(chip!.y + chip!.height).toBeLessThan(1113);

  const lines = full.split('\n');
  lines.splice(20, 0, '}');
  await page.locator('#spec').fill(lines.join('\n'));
  await expect(page.locator('#diagnostics')).toContainText(/Line 21, column \d+:/);
  await expect(page.locator('#diagnostics')).toContainText(/closed early at line 21/);
  await expect(page.locator('#diagnostics')).toContainText(/ended up at line 88/);
  await expect(page.locator('#error-chip')).toContainText(/line 21/);

  await page.locator('#spec').fill('speck S {\n  /* a /* b */ c */\n  state { x: Nat }\n}\n');
  await expect(page.locator('#diagnostics')).toContainText(/block comments do not nest/);
  await page.setViewportSize({ width: 1280, height: 800 });
});

test('a missing compiler worker says to refresh', async ({ page }) => {
  await page.route('**/*worker*', (route) => route.abort());
  await page.goto('/');
  await expect(page.locator('body')).toContainText(/Couldn't load the compiler/);
  const bag = page as Page & { __errors?: string[] };
  bag.__errors = (bag.__errors ?? []).filter((entry) => !/Failed to load resource/.test(entry));
});

test('round 6: a bad share link stays on screen and examples do not steal focus', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 520 });
  await page.goto('/#s2.garbage!!');
  await expect(page.locator('#banner')).toBeVisible();
  await expect(page.locator('#banner')).toContainText(/couldn't read this share link/i);
  await expect(page.locator('#spec')).toHaveValue(/speck DeployGate/);
  const banner = await page.locator('#banner').boundingBox();
  const viewport = page.viewportSize();
  expect(banner).not.toBeNull();
  expect(banner!.y).toBeGreaterThanOrEqual(0);
  expect(banner!.y + banner!.height).toBeLessThanOrEqual((viewport?.height ?? 520) + 1);
  expect(await page.evaluate(() => window.scrollY)).toBeLessThan(4);

  await page.goto('/');
  await settled(page);
  await page.getByRole('button', { name: 'Toggle switch' }).click();
  await settled(page);
  await expect(page.locator('#spec')).toHaveValue(/speck ToggleSwitch/);
  expect(await page.evaluate(() => window.scrollY)).toBeLessThan(4);
  expect(await page.evaluate(() => document.activeElement?.id ?? '')).not.toBe('spec');
  expect(await page.locator('#spec').evaluate((el: HTMLTextAreaElement) => el.scrollTop)).toBe(0);

  await page.locator('#spec').fill('speck Edited {\n state { x: Nat }\n}\n');
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await page.getByRole('button', { name: 'Agent policy' }).click();
  await page.getByRole('button', { name: 'Discard and load' }).click();
  await settled(page);
  await expect(page.locator('#spec')).toHaveValue(/speck AgentPolicy/);
  expect(await page.evaluate(() => window.scrollY)).toBeLessThan(4);
  expect(await page.evaluate(() => document.activeElement?.id ?? '')).not.toBe('spec');
  expect(await page.locator('#spec').evaluate((el: HTMLTextAreaElement) => el.scrollTop)).toBe(0);
  await page.setViewportSize({ width: 1280, height: 800 });
});

test('round 7: a hyphenated speck name is a positioned error', async ({ page }) => {
  await page.goto('/');
  await settled(page);
  await page.locator('#spec').fill(`speck Agent-Policy {
  state { stage: Nat }
  init { stage := 0 }
  action Go { stage := 1 }
  agent {
    stages stage { Idle = 0 }
    tool go -> Go effect act
  }
}
`);
  await settled(page);
  await expect(page.locator('#diagnostics')).toContainText('Line 1, column 7: speck name "Agent-Policy" is invalid (letters, digits, underscore only)');
  await expect(page.locator('#diagnostics')).not.toContainText(/not valid JavaScript|\/tmp\//);
  await expect(page.locator('#status')).toHaveAttribute('data-state', 'error');
  await expect(page.locator('#error-chip')).toContainText(/1 error, line 1/);
  await expect(page.locator('#file')).not.toContainText('AGENTS.md');
});

test('records first compiled output and gzipped bundle size', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#output')).toContainText('Call-bound');
  const timing = await page.evaluate(() => {
    const nav = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming;
    const mark = performance.getEntriesByName('speckl-first-output')[0];
    return {
      domContentLoadedMs: Math.round(nav.domContentLoadedEventEnd),
      loadMs: Math.round(nav.loadEventEnd),
      firstOutputMs: mark ? Math.round(mark.startTime) : null,
    };
  });
  const assets = walk(dist).map((file) => {
    const buf = fs.readFileSync(file);
    return {
      file: path.relative(dist, file),
      bytes: buf.length,
      gzip: zlib.gzipSync(buf).length,
    };
  });
  const js = assets.filter((a) => a.file.endsWith('.js'));
  const jsGzip = js.reduce((n, a) => n + a.gzip, 0);
  const report = { timing, jsGzip, assets };
  console.log('PLAYGROUND_PERF ' + JSON.stringify(report));
  expect(timing.firstOutputMs).not.toBeNull();
  expect(jsGzip).toBeGreaterThan(10_000);
  fs.writeFileSync('/tmp/speckl-playground-perf.json', JSON.stringify(report, null, 2));
});
