# Developer guide

Orientation doc. For the integration contract read [README.md](../README.md); for the full
wire protocol and every invariant read [protocol.md](./protocol.md). This file is the map
between them and the code.

## What this repo is

One file: `public/suqo-checkout.js`. A drop-in `<script>` (ES5, zero deps, one global
`SuqoCheckout`) that a merchant embeds on their page. It finds a `<div>`, mounts a sandboxed
iframe pointed at the SUQO app's `/c/<sessionId>` route, and relays a small `postMessage`
protocol between that frame and the merchant's `onSuccess`/`onFailure` callbacks.

The other half — the frame, the gateway hand-off, the backend routes — lives in the
`frontend` repo (sibling directory, not here). This repo is the **source of truth for the
loader only**; `frontend/public/suqo-checkout.js` is a synced copy that actually gets served.

```
merchant page  →  public/suqo-checkout.js (this repo, "the host")
                        │ iframe + postMessage
                        ▼
                   frontend: /c/[id] route (the "frame")
                        │ opens
                        ▼
                   gateway window (bank/eSewa/Khalti/etc.)
```

## Repo layout

| Path | What |
|---|---|
| `public/suqo-checkout.js` | The whole loader. Everything lives in one IIFE. |
| `demo/index.html`, `demo/failed.html` | A hostile host page for manual testing, served from repo root so `../public/suqo-checkout.js` resolves. |
| `scripts/sync-to-frontend.mjs` | Copies the loader into `frontend/public/`; `--check` mode diffs instead of writing. |
| `README.md` | Integration-facing contract: attributes, callbacks, message table, timeouts. |
| `docs/protocol.md` | Implementation spec: full sequence diagram, every invariant (§5), backend contract, reimplementation checklist. |

There is no `src/`, no bundler, no `node_modules` — `public/suqo-checkout.js` is shipped
byte-for-byte.

## Reading the code

`public/suqo-checkout.js` is organized into commented sections, top to bottom:

1. **Origin resolution** (`resolveOrigin`, `buildUrl`) — where the frame URL comes from and
   why `parentOrigin` rides in the hash, not the query string.
2. **DOM helpers / chrome** — spinner, failure panel, the one `<a>` it ever draws.
3. **Sessions** (`sessions` array) — one entry per mounted container; a page can carry
   several checkout blocks at once, so nothing is a module-level singleton.
4. **`mount` / `mountRedirect` / `unmount`** — builds the iframe (or the redirect link),
   arms the three load deadlines.
5. **The `message` listener** — the whole frame → host protocol, one `switch` on
   `data.type`.
6. **Discovery** — `DOMContentLoaded` + `MutationObserver`, so blocks rendered later (SPA
   routes, CMS widgets) mount without a re-init call.
7. **Public API** — `mount`, `unmount`, `configure`, the `origin` getter.

Comments in the file explain *why*, not *what* — read them before "simplifying" anything;
several exist because an earlier version shipped the more obvious version and it broke in
production (see protocol.md §5 for the incident behind each one).

## Making a change

1. Edit `public/suqo-checkout.js` only. ES5 — no `const`/`let`/arrow functions/template
   literals, since this runs on arbitrary merchant sites with no transpiler.
2. If the change touches the message protocol, timeouts, or anything the frame side
   depends on, update `docs/protocol.md` in the same change — the two repos ship separately,
   so a mismatch fails silently (blank block, or a payment whose result never reaches the
   merchant).
3. Run the checks:

   ```bash
   npm run check        # node --check public/suqo-checkout.js — proves it parses
   npm run demo          # http://localhost:4500/demo/ — exercise it in a browser
   ```

4. Sync into `frontend` and commit both:

   ```bash
   npm run sync          # copies public/suqo-checkout.js -> ../frontend/public/
   npm run sync:check    # CI-style: exits 1 if they've drifted
   ```

There is no test suite in this repo (see protocol.md §9) — `npm run check` only proves the
file parses. Verify behavior manually via the demo, against a running `frontend` dev server.

## Local demo

```bash
npm run demo   # serves the project ROOT on :4500 — open http://localhost:4500/demo/
```

Must serve from the repo root, not `demo/`, because the page loads
`../public/suqo-checkout.js`. Point `data-suqo-origin` in `demo/index.html` at a `frontend`
dev server port that's in its CORS allowlist (commonly `:3000`) — a wrong port and a wrong
origin fail identically (block never renders, no useful error).

## Where to look next

- Adding/changing an attribute or callback → README.md ("Declarative attributes",
  "Programmatic").
- Anything about message ordering, deadlines, the gateway window, or "why does this exist"
  → protocol.md §5 (invariants) first — the answer is usually already written down.
- Reimplementing either half from scratch → protocol.md §7 (checklist).
