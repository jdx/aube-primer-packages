#!/usr/bin/env node
// Produce `data/packages.json` — the canonical name list aube embeds in its
// metadata primer.
//
// Two inputs are merged:
//   1. npm-rank popularity (direct-install count, fetched from upstream)
//   2. cross-stack transitive popularity (mined by scripts/mine-transitives.mjs)
//
// The merge keeps the output at exactly TOP_N entries: the top (TOP_N -
// supplement_size) popularity entries plus every transitive with score
// >= MIN_STACKS not already in popularity. Net effect: the lowest-rank
// popularity entries are displaced by the most cross-cutting transitives.
//
// Env overrides:
//   TOP_N=2000                       output size
//   POPULAR_TOP_N=100000             typo/squat reference corpus size
//   PACKAGES_URL=<url>               popularity source (defaults to npm-rank)
//   POPULAR_URL=<url>                broad popularity source (defaults to ecosyste.ms)
//   MIN_STACKS=5                     transitive score threshold
//   SKIP_MINER=1                     skip mining, use existing transitives.json
//   TRANSITIVES_PATH=<path>          override transitives source (default: data/transitives.json)

import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '..')

const top = Number(process.env.TOP_N ?? 2000)
const popularTop = Number(process.env.POPULAR_TOP_N ?? 100000)
const sourceUrl = process.env.PACKAGES_URL ?? 'https://tristan-f-r.github.io/npm-rank/PACKAGES.html'
const popularUrl =
  process.env.POPULAR_URL ??
  'https://packages.ecosyste.ms/api/v1/registries/npmjs.org/package_names'
const minStacks = Number(process.env.MIN_STACKS ?? 5)
const transitivesPath = resolve(process.env.TRANSITIVES_PATH ?? `${ROOT}/data/transitives.json`)
// Cap supplement at 10% of TOP_N so a pathologically low MIN_STACKS (or a
// malformed transitives file) can't wipe out the popularity signal entirely.
// Override via SUPPLEMENT_MAX_RATIO (e.g. "0.2" for 20%) when intentionally
// experimenting with larger supplements.
const supplementMaxRatio = Number(process.env.SUPPLEMENT_MAX_RATIO ?? 0.10)
const outDir = `${ROOT}/data`

if (!Number.isInteger(top) || top < 1) {
  throw new Error('TOP_N must be a positive integer')
}
if (!Number.isInteger(popularTop) || popularTop < 1) {
  throw new Error('POPULAR_TOP_N must be a positive integer')
}
if (!Number.isInteger(minStacks) || minStacks < 1) {
  throw new Error('MIN_STACKS must be a positive integer')
}
if (!(supplementMaxRatio > 0 && supplementMaxRatio <= 1)) {
  throw new Error('SUPPLEMENT_MAX_RATIO must be in (0, 1]')
}

if (!isTruthyEnv(process.env.SKIP_MINER)) {
  console.error('mining transitives (set SKIP_MINER=1 to reuse existing transitives.json)')
  await runScript(`${__dirname}/mine-transitives.mjs`)
}

const popular = parsePackageNames(await fetchText(sourceUrl))
const broadPopular = await fetchPopularNames(popularUrl, popularTop)
const transitives = loadTransitives(transitivesPath, minStacks)

// Pick how many supplement slots we actually need: only transitives that
// don't already appear in the top-N popular list need promoting.
// Cap separately at `top * supplementMaxRatio` so a malformed transitives
// file or pathologically low MIN_STACKS can't displace most of the
// popularity signal.
const popularSet = new Set(popular.slice(0, top))
const supplementCap = Math.floor(top * supplementMaxRatio)
const supplementNeed = transitives.filter((n) => !popularSet.has(n)).length
const supplementSize = Math.min(supplementNeed, supplementCap)
const truncation = top - supplementSize
const keptSet = new Set(popular.slice(0, truncation))

// Build the supplement by walking transitives in score order, taking any
// name not already in `kept`. This includes both "not in popular at all"
// and "in popular's displaced zone (rank ≥ truncation)" — without the
// keptSet-based filter the latter group silently vanishes (filtered out
// of supplement by popularSet, also past kept's truncation point).
const supplement = []
const seen = new Set(keptSet)
for (const name of transitives) {
  if (supplement.length >= supplementSize) break
  if (seen.has(name)) continue
  supplement.push(name)
  seen.add(name)
}

const kept = popular.slice(0, truncation)
const names = [...kept, ...supplement]

await mkdir(outDir, { recursive: true })
const json = `${JSON.stringify(names, null, 2)}\n`
await writeFile(`${outDir}/packages.json`, json)
await writeFile(`${outDir}/packages.txt`, `${names.join('\n')}\n`)
await writeFile(`${outDir}/packages.sha256`, `${sha256(json)}  packages.json\n`)
const popularJson = `${JSON.stringify(broadPopular)}\n`
await writeFile(`${outDir}/popular.json`, popularJson)
await writeFile(`${outDir}/popular.sha256`, `${sha256(popularJson)}  popular.json\n`)
console.error(
  `wrote ${names.length} package names ` +
  `(${kept.length} popularity + ${supplement.length} transitives, ` +
  `threshold ≥${minStacks}, supplement cap ${supplementCap})`,
)
console.error(`wrote ${broadPopular.length} ranked package names to data/popular.json`)

async function fetchPopularNames(url, count) {
  const perPage = 1000
  const requiredPages = Math.ceil(count / perPage)
  // Rankings can shift between offset-paginated requests, causing a package
  // to appear on two adjacent pages. Fetch a bounded number of trailing pages
  // so deduplication can still produce the requested corpus size.
  const maxPages = requiredPages + Math.max(10, Math.ceil(requiredPages / 10))
  const names = []
  const seen = new Set()
  let nextPage = 1

  while (names.length < count && nextPage <= maxPages) {
    const batch = []
    const lastPage = Math.min(nextPage + 9, maxPages)
    for (let page = nextPage; page <= lastPage; page++) {
      const endpoint = new URL(url)
      endpoint.searchParams.set('per_page', String(perPage))
      endpoint.searchParams.set('sort', 'downloads')
      endpoint.searchParams.set('page', String(page))
      batch.push(fetchText(endpoint).then((text) => ({ page, values: JSON.parse(text) })))
    }
    const results = await Promise.all(batch)
    results.sort((a, b) => a.page - b.page)
    for (const { page, values } of results) {
      if (!Array.isArray(values) || !values.every(isPackageName)) {
        throw new Error(`${url}: page ${page} did not contain package names`)
      }
      for (const name of values) {
        if (seen.has(name)) continue
        seen.add(name)
        names.push(name)
      }
    }
    nextPage = lastPage + 1
    console.error(`fetched ${Math.min(names.length, count)}/${count} broad popularity names`)
  }

  if (names.length < count) {
    throw new Error(
      `${url}: expected ${count} unique names, received ${names.length} after ${maxPages} pages`,
    )
  }
  return names.slice(0, count)
}

function loadTransitives(path, threshold) {
  if (!existsSync(path)) {
    console.error(`transitives file ${path} not found; emitting popularity-only list`)
    return []
  }
  const doc = JSON.parse(readFileSync(path, 'utf8'))
  const pkgs = Array.isArray(doc) ? doc : doc.packages
  if (!Array.isArray(pkgs)) {
    throw new Error(`${path}: expected array or {packages: array}`)
  }
  // Plain-string entries are an unranked override list — keep them. Object
  // entries must carry a numeric `score`; missing/non-numeric scores fail the
  // threshold (default 0, not Infinity) so a malformed transitives file
  // doesn't silently promote every entry.
  return pkgs
    .filter((p) => {
      if (typeof p === 'string') return true
      return typeof p?.score === 'number' && p.score >= threshold
    })
    .map((p) => (typeof p === 'string' ? p : p?.name))
    .filter((n) => typeof n === 'string' && n.length > 0)
}

function isTruthyEnv(value) {
  if (value === undefined) return false
  return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase())
}

function runScript(script) {
  return new Promise((res, rej) => {
    const child = spawn('node', [script], { stdio: 'inherit' })
    child.on('close', (code) => (code === 0 ? res() : rej(new Error(`${script} exited ${code}`))))
    child.on('error', rej)
  })
}

async function fetchText(url) {
  for (let attempt = 1; attempt <= 6; attempt++) {
    const res = await fetch(url, { signal: AbortSignal.timeout(30000) })
    if (res.ok) return res.text()
    if (res.status !== 429 && res.status < 500) {
      throw new Error(`${url}: HTTP ${res.status}`)
    }
    const retryAfter = Number(res.headers.get('retry-after'))
    const delay = Number.isFinite(retryAfter) && retryAfter > 0
      ? retryAfter * 1000
      : Math.min(30000, 1000 * 2 ** (attempt - 1))
    const wait = Math.max(5000, delay)
    console.error(`${url}: HTTP ${res.status}; retrying in ${Math.round(wait / 1000)}s`)
    await sleep(wait)
  }
  throw new Error(`${url}: retry limit exceeded`)
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function parsePackageNames(text) {
  const trimmed = text.trim()
  if (trimmed.startsWith('[')) {
    return JSON.parse(trimmed).filter(isPackageName)
  }
  const names = []
  const seen = new Set()
  for (const match of trimmed.matchAll(/https:\/\/www\.npmjs\.com\/package\/([^"'<>?#\s]+)/g)) {
    const name = decodeURIComponent(match[1])
    if (isPackageName(name) && !seen.has(name)) {
      seen.add(name)
      names.push(name)
    }
  }
  if (names.length) return names
  const lines = trimmed
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#') && isPackageName(line))
  if (lines.length) return lines
  throw new Error('package source did not contain package names')
}

function isPackageName(name) {
  if (/\s/.test(name)) return false
  if (name.startsWith('@')) return /^@[^/]+\/[^/]+$/.test(name)
  return !name.includes('/') && name.length > 0
}

function sha256(input) {
  return createHash('sha256').update(input).digest('hex')
}
