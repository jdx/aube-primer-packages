# aube-primer-packages

Ranked npm package-name inputs for aube's bundled resolver primer.

The generated files live in `data/`:

- `packages.json` — JSON array of 2,000 package names. aube fetches this
  verbatim and embeds metadata for every entry into its release binary.
- `packages.txt` — newline-delimited names for quick inspection / diff.
- `packages.sha256` — SHA-256 checksum for `packages.json`.
- `popular.json` — JSON array of the top 100,000 npm package names by
  last-month downloads. This broad typo- and squatting reference corpus stays
  separate so it does not expand the resolver metadata primer.
- `popular.sha256` — SHA-256 checksum for `popular.json`.
- `transitives.json` — intermediate output from the mining step
  (`{ packages: [{ name, score, stacks }, ...] }`); checked in for
  reviewability and to make `SKIP_MINER=1` regenerations deterministic.
- `seeds.json` — hand-curated "typical project" stacks used by the miner.

The list refreshes monthly via GitHub Actions. Two inputs feed `packages.json`:

1. **Direct-install popularity** from
   [npm-rank](https://tristan-f-r.github.io/npm-rank/PACKAGES.html). Captures
   what users `npm install` directly.
2. **Cross-stack transitive popularity** mined from `data/seeds.json`. For
   each stack (vite-react-ts, next-react-ts, sveltekit-ts, …), the miner
   runs `npm install --package-lock-only` and counts how many stacks pull
   each transitive package. This surfaces deeply-transitive packages
   (`fdir`, `tinyglobby`, `dunder-proto`, `side-channel-*`,
   `@csstools/css-parser-algorithms`, the @esbuild/@rolldown platform
   variants, …) that no popularity ranking can catch because nobody
   installs them directly.

The broader `popular.json` ranking comes from the continuously updated
[ecosyste.ms Packages API](https://packages.ecosyste.ms/). It contains names
only, allowing aube to embed far wider coverage without fetching packuments
for all 100,000 entries.

`scripts/generate.mjs` merges both resolver inputs, keeping the output at exactly
`TOP_N=2000` entries: the most-popular `(2000 - K)` packages plus every
transitive with score `≥ MIN_STACKS` (default 5) that isn't already in
the popularity list. The lowest-rank popularity entries are displaced.

## Refreshing locally

```sh
# Full refresh: mines transitives, fetches popularity, writes packages.json
npm run generate

# Reuse the existing transitives.json without re-mining (fast path):
SKIP_MINER=1 npm run generate

# Override defaults:
TOP_N=2000 POPULAR_TOP_N=100000 MIN_STACKS=5 npm run generate
```

Add a stack in `data/seeds.json` when a major framework lands or an
existing tree changes substantially. Keep each stack lean — 4-8 top-level
deps is plenty, the miner walks the full transitive tree from there.
