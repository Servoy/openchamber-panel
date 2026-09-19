#!/usr/bin/env bun
// Build the panel: bundle main.ts -> main.js, then stamp index.html's
// <script src="main.js?v=…"> with a fresh token so OpenChamber's iframe cache
// cannot serve a stale bundle after a rebuild (a plain URL was cached across
// app restarts, which looked like "my changes didn't apply").
import { $ } from 'bun'
import { readFileSync, writeFileSync } from 'node:fs'

await $`bunx openchamber-guest-bundle panel/main.ts panel/main.js`

const stamp = Date.now().toString(36)
const htmlPath = 'panel/index.html'
const html = readFileSync(htmlPath, 'utf8')
const next = html.replace(/main\.js(\?v=[^"]*)?"/, `main.js?v=${stamp}"`)
if (next !== html) {
  writeFileSync(htmlPath, next)
  console.log(`stamped index.html -> main.js?v=${stamp}`)
} else {
  console.warn('warning: could not find main.js script tag to stamp')
}
