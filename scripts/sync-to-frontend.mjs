// Copies the loader into the Next.js app's public/, which is what actually serves
// it at https://<checkout-host>/suqo-checkout.js today.
//
// Why a copy and not a build step: the frontend's Docker build context is the
// frontend directory alone, so a prebuild hook reaching ../js-checkout would work
// on a laptop and fail in the image. Until the serving story is settled (a CDN, or
// a shared build context), the served file is a committed copy and this script
// keeps it honest.
//
//   node scripts/sync-to-frontend.mjs           # copy source -> frontend/public
//   node scripts/sync-to-frontend.mjs --check   # exit 1 if they differ
//
// The --check mode is the point: two copies of a file in two projects drift
// silently, and the failure mode is a merchant loading a stale loader that no
// longer matches the protocol the app speaks.
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const SOURCE = join(here, '..', 'public', 'suqo-checkout.js')
const TARGET = resolve(here, '..', '..', 'frontend', 'public', 'suqo-checkout.js')

const checkOnly = process.argv.includes('--check')

let source
try {
  source = readFileSync(SOURCE, 'utf8')
} catch {
  console.error(`[sync] cannot read source: ${SOURCE}`)
  process.exit(1)
}

let target = null
try {
  target = readFileSync(TARGET, 'utf8')
} catch {
  /* not there yet */
}

if (source === target) {
  console.log('[sync] frontend/public/suqo-checkout.js is up to date')
  process.exit(0)
}

if (checkOnly) {
  console.error(
    '[sync] frontend/public/suqo-checkout.js differs from js-checkout/public/suqo-checkout.js.\n' +
      '       js-checkout is the source of truth — run `node scripts/sync-to-frontend.mjs`\n' +
      '       and commit the result.'
  )
  process.exit(1)
}

try {
  writeFileSync(TARGET, source)
  console.log(`[sync] wrote ${TARGET}`)
} catch (err) {
  console.error(`[sync] cannot write target: ${TARGET}`)
  console.error(`       ${err.message}`)
  process.exit(1)
}
