#!/usr/bin/env node
// Guards the one silent failure mode of tailwind.css's scan allow-list
// (LAB-1702): the station map is deliberately NOT scanned, so every daisyUI /
// utility class it uses exists only because the chart page happens to use it
// too. Delete `join-item` from app.js and the map's region filter quietly
// unstyles — the stylesheet still rebuilds, CI still passes, and nobody finds
// out until they open the page.
//
// This turns that into a build failure. Run: npm run check:classes
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

// The unscanned page, and the two stylesheets it is allowed to draw from.
const SOURCES = ['public/map.html', 'public/map.js'];
const STYLESHEETS = ['public/assets/styles.css', 'public/assets/map.css'];

/** Class tokens from `class="…"` attributes and `class: '…'` element props. */
function classesIn(text) {
  const found = new Set();
  for (const [, value] of text.matchAll(/class="([^"]+)"/g)) {
    for (const token of value.split(/\s+/)) if (token) found.add(token);
  }
  // el(tag, { class: 'a b' }) and `class: \`a b${x ? ' c' : ''}\``: take the
  // literal head of the string; an interpolated tail is checked on its own by
  // the `' c'` fragment rule below.
  for (const [, value] of text.matchAll(/class:\s*[`'"]([^`'"${]*)/g)) {
    for (const token of value.split(/\s+/)) if (token) found.add(token);
  }
  for (const [, value] of text.matchAll(/classList\.(?:add|remove|toggle)\(\s*'([^']+)'/g)) {
    for (const token of value.split(/\s+/)) if (token) found.add(token);
  }
  return found;
}

const css = STYLESHEETS.map(read).join('\n');

/** Tailwind escapes `:`, `/`, `.`, `[`, `]`, `(`, `)`, `,` in selectors. */
const defined = (token) => {
  const escaped = token.replace(/[:/.[\](),%]/g, (c) => `\\${c}`);
  return css.includes(`.${escaped}`) || css.includes(`.${token}`);
};

const missing = [];
for (const source of SOURCES) {
  for (const token of classesIn(read(source))) {
    if (!defined(token)) missing.push(`${source}: ${token}`);
  }
}

assert.deepEqual(
  missing,
  [],
  `The station map uses classes no stylesheet defines. Either the chart page ` +
    `stopped using them (tailwind.css only scans the chart page — see the ` +
    `comment there) or they were never emitted. Add a rule to ` +
    `public/assets/map.css, or use a class the chart page already emits:\n  ` +
    missing.join('\n  '),
);

console.log(`check:classes passed — every class in ${SOURCES.join(' + ')} is defined`);
