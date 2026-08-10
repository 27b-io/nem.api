#!/usr/bin/env node
/**
 * Real-pointer probe for the station map (`/map`).
 *
 * WHY THIS EXISTS, and why the 217 vitest specs do not cover it: every bug this
 * catches is a pointer-plumbing bug, and a synthetic `element.click()` does not
 * have pointer plumbing. It dispatches one `click` straight at a node — it never
 * goes through `pointerdown` -> pointer capture -> `pointerup` -> `click`
 * retargeting, never hit-tests through `preserveAspectRatio` letterboxing, and
 * never produces a `detail > 1`. Four shipped `/map` regressions (LAB-1702) were
 * invisible to a DOM-assertion check that happily reported 213 markers with the
 * right classes and no console errors on a page where clicking a station did
 * nothing at all. Only a real browser moving a real mouse sees them.
 *
 * Runs headlessly against a live Worker (`wrangler dev --local` in CI). Set
 * PROBE_URL to point it elsewhere; PROBE_HEADED=1 to watch it drive.
 *
 * Determinism rules for anything added here: never sleep, always wait on an
 * observable condition, and never assume which marker is where — pick targets by
 * hit-testing with `elementFromPoint` so a facilities-snapshot refresh cannot
 * silently turn an assertion into a no-op.
 */
import { chromium } from 'playwright-core';

const BASE = process.env.PROBE_URL ?? 'http://127.0.0.1:8787';
const HEADED = process.env.PROBE_HEADED === '1';
/** Wide enough for the two-column layout, short enough that the page scrolls. */
const VIEWPORT = { width: 1280, height: 800 };
/** Landscape-phone height: the map box renders under the 240 px that boxAspect()
 *  used to floor at, which is the `boxAspect` boundary CodeRabbit found. */
const SHORT_VIEWPORT = { width: 900, height: 380 };

const results = [];
let failed = 0;

async function check(name, fn) {
  try {
    await fn();
    results.push(`  ok   ${name}`);
  } catch (err) {
    failed += 1;
    results.push(`  FAIL ${name}\n         ${err instanceof Error ? err.message : String(err)}`);
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

/* ------------------------------------------------------------------- helpers */

/** The map's live geometry, read from the DOM the browser actually laid out. */
const geometry = (page) =>
  page.evaluate(() => {
    const svg = document.getElementById('map');
    const [x, y, w, h] = svg.getAttribute('viewBox').split(' ').map(Number);
    const rect = svg.getBoundingClientRect();
    return { x, y, w, h, cx: x + w / 2, cy: y + h / 2, rect, box: rect.width / rect.height };
  });

/**
 * Pick a marker we can actually hit: `elementFromPoint` at its centre must
 * return the marker itself. Markers are painted biggest-first so small ones stay
 * clickable, but a small station can still sit under a large one — asserting on a
 * covered marker would test the wrong element and pass for the wrong reason.
 * `order: 'smallest'` picks the tiniest hittable pin, which is the case that
 * actually broke (a 6 px dot is not a pointer target).
 */
function pickMarker(page, { order = 'largest', exclude = null } = {}) {
  return page.evaluate(
    ({ order, exclude }) => {
      const map = document.getElementById('map').getBoundingClientRect();
      const markers = [...document.querySelectorAll('circle.marker')]
        .filter((m) => m.dataset.code !== exclude)
        .map((m) => ({ node: m, r: m.getBoundingClientRect().width / 2 }))
        .sort((a, b) => (order === 'smallest' ? a.r - b.r : b.r - a.r));
      for (const { node, r } of markers) {
        const rect = node.getBoundingClientRect();
        const x = rect.x + rect.width / 2;
        const y = rect.y + rect.height / 2;
        // Inside the map box, or elementFromPoint answers about the page chrome
        // (or nothing at all, for a marker scrolled out of the viewport).
        if (x < map.x || x > map.right || y < map.y || y > map.bottom) continue;
        if (document.elementFromPoint(x, y) !== node) continue;
        return { code: node.dataset.code, name: node.querySelector('title').textContent, x, y, r };
      }
      return null;
    },
    { order, exclude },
  );
}

/** A point over bare basemap — no marker under it, so a drag or double-click
 *  there exercises the pan/zoom path and not the drill-down. */
function pickEmptyPoint(page) {
  return page.evaluate(() => {
    const rect = document.getElementById('map').getBoundingClientRect();
    for (let fx = 0.2; fx <= 0.8; fx += 0.05) {
      for (let fy = 0.2; fy <= 0.8; fy += 0.05) {
        const x = rect.x + rect.width * fx;
        const y = rect.y + rect.height * fy;
        const hit = document.elementFromPoint(x, y);
        if (hit && !hit.classList.contains('marker')) return { x, y };
      }
    }
    return null;
  });
}

const selectedCode = (page) =>
  page.evaluate(() => document.querySelector('circle.marker.selected')?.dataset.code ?? null);

const panelHeading = (page) =>
  page.evaluate(() => document.querySelector('#panel-body h2')?.textContent ?? null);

/** Ready = the join ran, markers are in the DOM, and the view has been set.
 *  This is the only "wait" in the probe; everything after it waits on the
 *  specific thing it is about to assert on. */
async function openMap(page) {
  await page.goto(`${BASE}/map`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(
    () =>
      document.querySelectorAll('circle.marker').length > 0 &&
      document.getElementById('map').hasAttribute('viewBox'),
    null,
    { timeout: 30_000 },
  );
}

async function drag(page, from, to) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  // Stepped so `pointermove` fires repeatedly and the 4 px drag slop is really
  // crossed — a single jump can be delivered as one move and is not a drag.
  await page.mouse.move(to.x, to.y, { steps: 12 });
  await page.mouse.up();
}

/* -------------------------------------------------------------------- probes */

async function main() {
  const browser = await chromium.launch({ headless: !HEADED });
  const context = await browser.newContext({ viewport: VIEWPORT });
  // Every wait here is on a condition the gesture causes within a frame or two,
  // so 10 s is generous — but it is what bounds a red build: at playwright's
  // 30 s default, a broken click makes CI sit for minutes before saying so.
  context.setDefaultTimeout(10_000);
  const page = await context.newPage();

  // Every /api/v2/values call is a station drill-down fetch. Counting them is how
  // "one gesture selects once" is checked: the double-click bug fired the
  // 24-hour fetch twice for a single gesture.
  let valuesFetches = 0;
  page.on('request', (req) => {
    if (req.url().includes('/api/v2/values')) valuesFetches += 1;
  });
  const crashes = [];
  page.on('pageerror', (err) => crashes.push(err.message));

  try {
    await openMap(page);

    // 1. The headline regression: setPointerCapture() retargeted `pointerup` AND
    //    `click` to the <svg>, so the marker's own listener never ran and
    //    clicking a station did nothing.
    let clicked;
    await check('click on a marker opens that station', async () => {
      clicked = await pickMarker(page, { order: 'largest' });
      assert(clicked, 'no hittable marker found');
      await page.mouse.click(clicked.x, clicked.y);
      await page.waitForFunction((code) => new URLSearchParams(location.search).get('station') === code, clicked.code);
      assert((await selectedCode(page)) === clicked.code, `selected ${await selectedCode(page)}, expected ${clicked.code}`);
      assert(await panelHeading(page), 'drill-down panel stayed empty');
    });

    // 2. Same path, smallest pin on the map: the drag threshold was ~1.6 px, so
    //    the hand tremor in a click on a small target read as a drag and was
    //    suppressed. Small stations are exactly the ones you click to identify.
    await check('click on the smallest marker opens that station, not a neighbour', async () => {
      const small = await pickMarker(page, { order: 'smallest', exclude: clicked.code });
      assert(small, 'no second hittable marker found');
      assert(small.r * 2 <= 24, `"smallest" marker is ${(small.r * 2).toFixed(1)} px wide — pick logic is wrong`);
      await page.mouse.click(small.x, small.y);
      await page.waitForFunction((code) => new URLSearchParams(location.search).get('station') === code, small.code);
      assert((await selectedCode(page)) === small.code, 'a different station was selected');
    });

    // 3-4. The visible, keyboard-reachable controls. They are the primary way in;
    //      wheel-only zoom was the revision Ray rejected.
    await check('the + button zooms in', async () => {
      const before = await geometry(page);
      await page.click('#zoom-in');
      await page.waitForFunction((w) => Number(document.getElementById('map').getAttribute('viewBox').split(' ')[2]) < w, before.w);
    });

    await check('the − button zooms out', async () => {
      const before = await geometry(page);
      await page.click('#zoom-out');
      await page.waitForFunction((w) => Number(document.getElementById('map').getAttribute('viewBox').split(' ')[2]) > w, before.w);
    });

    // 5. Plain wheel, no modifier. The ctrl/⌘ requirement was a real fix applied
    //    in the wrong place; no map on the web works that way.
    await check('an unmodified wheel zooms the map', async () => {
      const empty = await pickEmptyPoint(page);
      assert(empty, 'no bare-basemap point found');
      const before = await geometry(page);
      await page.mouse.move(empty.x, empty.y);
      await page.mouse.wheel(0, -240);
      await page.waitForFunction((w) => Number(document.getElementById('map').getAttribute('viewBox').split(' ')[2]) < w, before.w);
    });

    // 6. Pan. Window-level pointermove/up replaced pointer capture, so this is
    //    the assertion that the replacement actually works.
    await check('dragging pans the view', async () => {
      await page.click('#reset-view');
      const empty = await pickEmptyPoint(page);
      const before = await geometry(page);
      await drag(page, empty, { x: empty.x - 160, y: empty.y });
      const after = await geometry(page);
      const moved = after.cx - before.cx;
      const expected = (160 / before.rect.width) * before.w;
      assert(moved > 0, `drag left should move the view east; centre moved ${moved.toFixed(3)}`);
      assert(
        Math.abs(moved - expected) / expected < 0.25,
        `pan moved ${moved.toFixed(3)} user units, expected ~${expected.toFixed(3)} — pointer coordinates are being mistranslated`,
      );
    });

    // 7. The other half of the drag contract: a drag that happens to finish over
    //    a pin must not open it. (`suppressClick`.)
    await check('a drag ending on a marker does not select it', async () => {
      const before = await selectedCode(page);
      const target = await pickMarker(page, { order: 'largest', exclude: before });
      assert(target, 'no marker to drag onto');
      await drag(page, { x: target.x + 120, y: target.y + 60 }, { x: target.x, y: target.y });
      assert((await selectedCode(page)) === before, `a pan opened ${await selectedCode(page)}`);
    });

    // 8. The scroll-trap guard is CSS (the map is capped at min(62vh, 34rem)), so
    //    there is always page around it. Verified by scrolling with the cursor
    //    beside the map rather than by asserting on the cap.
    await check('the page still scrolls with the cursor outside the map', async () => {
      await page.evaluate(() => scrollTo(0, 0));
      const outside = await page.evaluate(() => {
        const rect = document.getElementById('map').getBoundingClientRect();
        return { x: rect.x + rect.width / 2, y: Math.max(4, rect.y / 2) };
      });
      await page.mouse.move(outside.x, outside.y);
      await page.mouse.wheel(0, 300);
      await page.waitForFunction(() => scrollY > 0);
    });

    // 9. A viewBox whose aspect differs from the element's letterboxes under
    //    preserveAspectRatio and silently offsets EVERY pointer coordinate — the
    //    bug behind clicks landing on the wrong station.
    await check('the viewBox aspect matches the box aspect', async () => {
      const g = await geometry(page);
      assert(
        Math.abs(g.w / g.h - g.box) < 1e-4,
        `viewBox aspect ${(g.w / g.h).toFixed(6)} vs box ${g.box.toFixed(6)} — the map is letterboxed`,
      );
    });

    // 10. A pin is a target; hitting it twice must not move the map out from
    //     under the panel that just opened, and one gesture must not fire the
    //     24-hour fetch twice (`event.detail > 1`).
    await check('double-clicking a pin opens it once and does not zoom', async () => {
      await page.click('#reset-view');
      const before = await geometry(page);
      const target = await pickMarker(page, { order: 'largest', exclude: await selectedCode(page) });
      assert(target, 'no marker to double-click');
      const fetchesBefore = valuesFetches;
      await page.mouse.dblclick(target.x, target.y);
      await page.waitForFunction((code) => new URLSearchParams(location.search).get('station') === code, target.code);
      const after = await geometry(page);
      assert(after.w === before.w, `double-click on a pin zoomed the map (${before.w} -> ${after.w})`);
      assert(
        valuesFetches - fetchesBefore === 1,
        `one gesture fired ${valuesFetches - fetchesBefore} drill-down fetches`,
      );
    });

    // 11. reframe(): a resize must keep the visitor's centre and zoom, and the
    //     aspect must still match at a short viewport — the boxAspect() floor
    //     that reintroduced letterboxing on a landscape phone.
    await check('a resize to a short viewport keeps the view and the aspect', async () => {
      // Zoomed in before panning, so the view sits well inside clampView's
      // bounds and "the centre survived" is testing reframe(), not the clamp.
      await page.click('#zoom-in');
      await page.click('#zoom-in');
      const empty = await pickEmptyPoint(page);
      await drag(page, empty, { x: empty.x - 100, y: empty.y - 60 });
      const before = await geometry(page);
      await page.setViewportSize(SHORT_VIEWPORT);
      // Wait on reframe having RUN (it rewrites the viewBox height), not on the
      // element having been laid out — layout lands before the resize handler.
      await page.waitForFunction(
        (h) => Number(document.getElementById('map').getAttribute('viewBox').split(' ')[3]) !== h,
        before.h,
      );
      const after = await geometry(page);
      assert(
        after.rect.height < 240,
        `short viewport gave a ${after.rect.height.toFixed(0)} px map — it no longer tests the floor boundary`,
      );
      assert(Math.abs(after.cx - before.cx) < 1e-6 && Math.abs(after.cy - before.cy) < 1e-6,
        `resize moved the centre (${before.cx.toFixed(3)}, ${before.cy.toFixed(3)}) -> (${after.cx.toFixed(3)}, ${after.cy.toFixed(3)})`);
      assert(Math.abs(after.w - before.w) < 1e-6, `resize changed the zoom (${before.w} -> ${after.w})`);
      assert(
        Math.abs(after.w / after.h - after.box) < 1e-4,
        `short viewport letterboxes: viewBox aspect ${(after.w / after.h).toFixed(6)} vs box ${after.box.toFixed(6)}`,
      );
      // Back to the whole-NEM view so there are pins on screen at all, then
      // prove a click still lands on the one under the cursor at this height —
      // the letterbox offset would put it on a neighbour, or on nothing.
      await page.click('#reset-view');
      const marker = await pickMarker(page, { order: 'largest', exclude: await selectedCode(page) });
      assert(marker, 'no hittable marker after the resize');
      await page.mouse.click(marker.x, marker.y);
      await page.waitForFunction((code) => new URLSearchParams(location.search).get('station') === code, marker.code);
    });

    if (crashes.length) {
      failed += 1;
      results.push(`  FAIL no uncaught page errors\n         ${crashes.join('\n         ')}`);
    } else {
      results.push('  ok   no uncaught page errors');
    }
  } finally {
    await browser.close();
  }

  console.log(`pointer probe — ${BASE}/map\n${results.join('\n')}`);
  const total = results.length;
  console.log(failed ? `\n${failed} of ${total} FAILED` : `\n${total} assertions passed`);
  process.exitCode = failed ? 1 : 0;
}

main().catch((err) => {
  console.error('pointer probe could not run:', err);
  process.exitCode = 1;
});
