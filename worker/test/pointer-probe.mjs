#!/usr/bin/env node
/**
 * Real-pointer probe for the station map (`/map`).
 *
 * WHY THIS EXISTS, and why the 217 vitest specs do not cover it: every bug this
 * catches is a pointer-plumbing or screen-geometry bug, and a synthetic
 * `element.click()` has neither. It dispatches one `click` straight at a node —
 * it never goes through `pointerdown` -> pointer capture -> `pointerup` ->
 * `click` retargeting, never crosses the drag threshold, never hit-tests through
 * `preserveAspectRatio` letterboxing, and never produces a `detail > 1`. Four
 * shipped `/map` regressions (LAB-1702) were invisible to a DOM-assertion check
 * that happily reported 213 markers with the right classes and no console errors
 * on a page where clicking a station did nothing at all.
 *
 * Runs headlessly against a live Worker (`wrangler dev --local` in CI). Set
 * PROBE_URL to point it elsewhere; PROBE_HEADED=1 to watch it drive.
 *
 * RULES for anything added here, learned by having each of them violated:
 *   - Never sleep. Wait on the observable thing the gesture causes.
 *   - Never assume which marker is where. Hit-test with `elementFromPoint`, so a
 *     facilities-snapshot refresh cannot silently turn an assertion into a no-op.
 *   - Make the gesture the code actually reacts to. `mouse.click()` emits no
 *     `pointermove`, so it cannot test a drag threshold from either side; a drag
 *     that ends somewhere the marker no longer is cannot test click suppression.
 *     Both of those passed against a deliberately broken map before they were
 *     rewritten to move the mouse the way a hand does.
 *   - Every failure must say what it saw, not just that it timed out. When this
 *     goes red it is 2am and the reader is not you.
 */
import { chromium } from 'playwright-core';

const BASE = process.env.PROBE_URL ?? 'http://127.0.0.1:8787';
const HEADED = process.env.PROBE_HEADED === '1';
/** Wide enough for the two-column layout, short enough that the page scrolls. */
const VIEWPORT = { width: 1280, height: 800 };
/** Landscape-phone height: the map box renders under the 240 px that boxAspect()
 *  used to floor at, and its height stops being a whole number — which is the
 *  only viewport where the clientHeight-rounding letterbox shows up. */
const SHORT_VIEWPORT = { width: 900, height: 380 };
/** Mirrors DRAG_SLOP_PX in public/map.js. The probe brackets it from both sides:
 *  a smaller movement must still count as a click, a larger one must not. */
const DRAG_SLOP_PX = 4;
/** Mirrors LABEL_PX in public/map.js — jurisdiction labels are specified in
 *  SCREEN pixels and converted to user units on every view change. */
const LABEL_PX = 13;

let failed = 0;
let count = 0;

async function check(name, fn) {
  count += 1;
  try {
    await fn();
    // Printed as it happens, not buffered: a hang or a throw outside a check
    // would otherwise discard every line collected so far, and the one thing you
    // need from a stalled gate is which gesture it stalled on.
    console.log(`  ok   ${name}`);
  } catch (err) {
    failed += 1;
    console.log(`  FAIL ${name}\n         ${err instanceof Error ? err.message : String(err)}`);
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
    // Plain values only: a DOMRect's properties are prototype getters, and
    // Playwright documents evaluate() returns as plain-serializable — 1.62.1
    // happens to carry them across, but that is not a contract to lean on.
    return {
      w,
      h,
      cx: x + w / 2,
      cy: y + h / 2,
      rect: { width: rect.width, height: rect.height },
      box: rect.width / rect.height,
    };
  });

/**
 * Pick a marker we can actually hit: `elementFromPoint` at its centre must
 * return the marker itself. Markers are painted biggest-first so small ones stay
 * clickable, but a small station can still sit under a large one — asserting on a
 * covered marker would test the wrong element and pass for the wrong reason.
 * `order: 'smallest'` picks the tiniest hittable pin, which is the case that
 * actually broke: a 6 px dot is not a pointer target.
 */
function pickMarker(page, { order = 'largest', exclude = null } = {}) {
  return page.evaluate(
    ({ order, exclude }) => {
      const map = document.getElementById('map').getBoundingClientRect();
      const candidates = [...document.querySelectorAll('circle.marker')]
        .filter((m) => m.dataset.code !== exclude)
        .map((m) => ({ node: m, rect: m.getBoundingClientRect() }))
        .sort((a, b) => (order === 'smallest' ? a.rect.width - b.rect.width : b.rect.width - a.rect.width));
      for (const { node, rect } of candidates) {
        const x = rect.x + rect.width / 2;
        const y = rect.y + rect.height / 2;
        // Inside the map box, or elementFromPoint answers about the page chrome
        // (or nothing at all, for a marker scrolled out of the viewport).
        if (x < map.x || x > map.right || y < map.y || y > map.bottom) continue;
        if (document.elementFromPoint(x, y) !== node) continue;
        return { code: node.dataset.code, name: node.querySelector('title').textContent, x, y, r: rect.width / 2 };
      }
      return null;
    },
    { order, exclude },
  );
}

/** A point over bare basemap — no marker under it, so a drag or double-click
 *  there exercises the pan/zoom path and not the drill-down. */
async function pickEmptyPoint(page) {
  const point = await page.evaluate(() => {
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
  assert(point, 'no bare-basemap point found — is the map covered by pins, or off screen?');
  return point;
}

const selectedCode = (page) =>
  page.evaluate(() => document.querySelector('circle.marker.selected')?.dataset.code ?? null);

/** The drill-down opening is the observable, so this is the assertion for most
 *  of the click checks — and a bare "Timeout 10000ms exceeded" cannot tell
 *  "the click did nothing" (capture retargeting) from "the click opened the
 *  wrong station" (a coordinate offset). Those are two different bugs and the
 *  message has to name which one happened. */
async function waitForStation(page, marker, what) {
  try {
    await page.waitForFunction((code) => new URLSearchParams(location.search).get('station') === code, marker.code);
  } catch {
    const [selected, station] = await Promise.all([
      selectedCode(page),
      page.evaluate(() => new URLSearchParams(location.search).get('station')),
    ]);
    throw new Error(
      selected == null
        ? `${what} on ${marker.name} did nothing — no station selected`
        : `${what} on ${marker.name} (${marker.code}) selected ${selected} instead (?station=${station})`,
    );
  }
}

/** Ready = the join ran, markers are in the DOM, and the view has been set. */
async function openMap(page, crashes) {
  const response = await page.goto(`${BASE}/map`, { waitUntil: 'domcontentloaded' });
  try {
    await page.waitForFunction(
      () =>
        document.querySelectorAll('circle.marker').length > 0 &&
        document.getElementById('map').hasAttribute('viewBox'),
      null,
      { timeout: 30_000 },
    );
  } catch {
    // The usual cause is a server with no seeded D1 (`npm run migrate:local`),
    // which otherwise presents as an unexplained 30 s timeout.
    const state = await page.evaluate(() => ({
      markers: document.querySelectorAll('circle.marker').length,
      viewBox: document.getElementById('map')?.getAttribute('viewBox') ?? null,
      error: document.getElementById('error-text')?.textContent || null,
    }));
    throw new Error(
      `/map never became ready: HTTP ${response?.status()}, ${state.markers} markers, ` +
        `viewBox=${state.viewBox}, page error=${state.error ?? 'none'}` +
        (crashes.length ? `, uncaught: ${crashes.join('; ')}` : '') +
        ' — is the Worker seeded (npm run migrate:local)?',
    );
  }
}

/** Stepped, so `pointermove` fires repeatedly and the drag threshold is really
 *  crossed. A single jump can be delivered as one move and is not a drag. */
async function drag(page, from, ...waypoints) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  for (const point of waypoints) await page.mouse.move(point.x, point.y, { steps: 12 });
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

  console.log(`pointer probe — ${BASE}/map`);
  try {
    await openMap(page, crashes);

    // 1. The headline regression: setPointerCapture() retargeted `pointerup` AND
    //    `click` to the <svg>, so the marker's own listener never ran and
    //    clicking a station did nothing.
    let clicked = null;
    await check('click on a marker opens that station', async () => {
      clicked = await pickMarker(page, { order: 'largest' });
      assert(clicked, 'no hittable marker found');
      await page.mouse.click(clicked.x, clicked.y);
      await waitForStation(page, clicked, 'a click');
      assert((await selectedCode(page)) === clicked.code, `marker class did not follow the selection`);
    });

    // 2. Same path on the smallest pin on the map, with a hand tremor in it. The
    //    drag threshold was 0.2% of the viewBox width — under two screen pixels
    //    at the whole-NEM view — so the jitter in an ordinary click registered as
    //    a drag and the click was suppressed. `mouse.click()` cannot catch that:
    //    it emits no `pointermove` at all, so it passes at any threshold,
    //    including a negative one. The movement has to be real and sub-slop.
    let small = null;
    await check('a click with a hand tremor still opens the smallest pin', async () => {
      assert(clicked, 'assertion 1 did not run, so there is no station to exclude');
      small = await pickMarker(page, { order: 'smallest', exclude: clicked.code });
      assert(small, 'no second hittable marker found');
      assert(small.r * 2 <= 24, `"smallest" marker is ${(small.r * 2).toFixed(1)} px wide — the pick logic is wrong`);
      await drag(page, small, { x: small.x + DRAG_SLOP_PX - 2, y: small.y + 1 });
      await waitForStation(page, small, 'a click with 2 px of tremor');
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
      const before = await geometry(page);
      await page.mouse.move(empty.x, empty.y);
      await page.mouse.wheel(0, -240);
      await page.waitForFunction((w) => Number(document.getElementById('map').getAttribute('viewBox').split(' ')[2]) < w, before.w);
    });

    // 6. Pan. Window-level pointermove/up replaced pointer capture, so this is
    //    the assertion that the replacement actually works — and the distance
    //    check is what would catch a pointer coordinate being mistranslated.
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

    // 7. The other half of the drag contract: a drag that finishes over a pin
    //    must not open it (`suppressClick`). It has to end where it STARTED —
    //    dragging away and releasing on empty space proves nothing, because the
    //    map pans with the pointer and the marker is no longer under it, so no
    //    click on a marker was ever in flight. Out and back also means the
    //    browser really does fire a click on the marker, which is the event that
    //    must be swallowed.
    await check('a drag that returns to its marker does not select it', async () => {
      const before = await selectedCode(page);
      const target = await pickMarker(page, { order: 'largest', exclude: before });
      assert(target, 'no marker to drag onto');
      assert(DRAG_SLOP_PX < 40, 'the drag below must exceed the slop to be a drag at all');
      await drag(page, target, { x: target.x + 40, y: target.y + 24 }, target);
      assert(
        (await selectedCode(page)) === before,
        `a pan opened ${await selectedCode(page)} — the drag was not distinguished from a click`,
      );
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
      // Left scrolled, the map sits partly above the viewport and every later
      // hit-test would be measuring a different page than this one did.
      await page.evaluate(() => scrollTo(0, 0));
      await page.waitForFunction(() => scrollY === 0);
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

    // 10. Marker radii and jurisdiction label type are specified in SCREEN pixels
    //     but SVG attributes are in user units, so both are converted on every
    //     view change. Missing that renders a 13 px label about 150 px tall and
    //     swallows the continent — and it is invisible to hit-testing, because
    //     `.region-label` is `pointer-events: none`. Marker radii are covered by
    //     the clicks above (an unscaled pin is unhittable); labels need their own
    //     look, and this is the one assertion here that needs no pointer at all.
    await check('jurisdiction labels stay screen-sized through a zoom', async () => {
      await page.click('#zoom-in');
      const heights = await page.evaluate(() =>
        [...document.querySelectorAll('text.region-label')].map((t) => t.getBoundingClientRect().height),
      );
      assert(heights.length > 0, 'no jurisdiction labels rendered');
      const worst = Math.max(...heights);
      assert(
        worst < LABEL_PX * 2,
        `a jurisdiction label renders ${worst.toFixed(1)} px tall for a ${LABEL_PX} px spec — user units are being treated as screen pixels`,
      );
    });

    // 11. A pin is a target; hitting it twice must not move the map out from
    //     under the panel that just opened, and one gesture must not fire the
    //     24-hour fetch twice (`event.detail > 1`).
    await check('double-clicking a pin opens it once and does not zoom', async () => {
      await page.click('#reset-view');
      const before = await geometry(page);
      const target = await pickMarker(page, { order: 'largest', exclude: await selectedCode(page) });
      assert(target, 'no marker to double-click');
      const fetchesBefore = valuesFetches;
      await page.mouse.dblclick(target.x, target.y);
      await waitForStation(page, target, 'a double-click');
      // Both clicks are delivered before `dblclick`, so a second drill-down fetch
      // is issued during the same task as the first; this round trip yields to
      // the page's task queue so that request is on the wire before we count.
      // (A task boundary, not a sleep — nothing here waits on elapsed time.)
      await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 0)));
      const after = await geometry(page);
      assert(after.w === before.w, `double-click on a pin zoomed the map (${before.w} -> ${after.w})`);
      assert(
        valuesFetches - fetchesBefore === 1,
        `one gesture fired ${valuesFetches - fetchesBefore} drill-down fetches`,
      );
    });

    // 12. reframe(): a resize must keep the visitor's centre and zoom, and the
    //     aspect must still match at a short viewport — the boxAspect() floor
    //     that reintroduced letterboxing on a landscape phone, and the
    //     clientHeight rounding that survived it.
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
      assert(
        Math.abs(after.cx - before.cx) < 1e-6 && Math.abs(after.cy - before.cy) < 1e-6,
        `resize moved the centre (${before.cx.toFixed(3)}, ${before.cy.toFixed(3)}) -> (${after.cx.toFixed(3)}, ${after.cy.toFixed(3)})`,
      );
      assert(Math.abs(after.w - before.w) < 1e-6, `resize changed the zoom (${before.w} -> ${after.w})`);
      assert(
        Math.abs(after.w / after.h - after.box) < 1e-4,
        `short viewport letterboxes: viewBox aspect ${(after.w / after.h).toFixed(6)} vs box ${after.box.toFixed(6)}`,
      );
      // Back to the whole-NEM view so there are pins on screen at all, then
      // prove a click still lands on the one under the cursor at this height —
      // a letterbox offset would put it on a neighbour, or on nothing.
      await page.click('#reset-view');
      const marker = await pickMarker(page, { order: 'largest', exclude: await selectedCode(page) });
      assert(marker, 'no hittable marker after the resize');
      await page.mouse.click(marker.x, marker.y);
      await waitForStation(page, marker, 'a click at a short viewport');
    });

    await check('no uncaught page errors', () => assert(!crashes.length, crashes.join('\n         ')));
  } finally {
    await browser.close();
  }

  console.log(failed ? `\n${failed} of ${count} FAILED` : `\n${count} assertions passed`);
  process.exitCode = failed ? 1 : 0;
}

main().catch((err) => {
  console.error(`\npointer probe could not run: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
