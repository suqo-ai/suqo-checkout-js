# SUQO embedded checkout

A drop-in `<script>` that opens the SUQO checkout in a modal iframe over a
merchant's own page, so the buyer never leaves it.

One file, `public/suqo-checkout.js`. No build step, no dependencies, ES5, one
global (`SuqoCheckout`). Every style is inlined on the elements it creates, so a
host page's CSS cannot restyle the modal and the modal cannot leak styles out.

The app side of the protocol lives in the `frontend` project — `src/lib/embed/`
and `src/components/checkout/Embed*.tsx`.

## Quick start

```html
<script src="https://test.suqo.ai/suqo-checkout.js"></script>

<button data-suqo-pay-id="SUB123">Pay now</button>
```

That's the whole integration. Binding is delegated from `document`, so buttons
rendered after the script runs (SPA views, lazy sections, CMS widgets) work with
no re-initialisation.

### Declarative attributes

| Attribute | Meaning |
| --- | --- |
| `data-suqo-checkout="https://…"` | Full checkout URL, used verbatim |
| `data-suqo-pay-id="ID"` | Payment-link id → `/pay/:id` |
| `data-suqo-renew-id="ID"` | Renewal id → `/renew/:id` |
| `data-suqo-origin="https://…"` | Per-element base URL override |

### Programmatic

```js
SuqoCheckout.open({
  payId: 'SUB123',           // or renewId, or url (used verbatim)
  origin: 'https://test.suqo.ai',   // optional per-call override
  showResult: true,          // false = close as soon as the result arrives
  onReady:   function () {},
  onSuccess: function (params) {},          // gateway return params, unnormalised
  onFailure: function (status, params) {},  // 'failed' | 'cancelled'
  onClose:   function () {},
})

SuqoCheckout.close()
SuqoCheckout.configure({ origin: 'https://test.suqo.ai' })
SuqoCheckout.origin   // getter — the currently resolved base URL
```

`onSuccess` receives the gateway's return parameters **exactly as the gateway sent
them**, with no renaming or filtering. Every gateway names its transaction id
differently (`data`, `pidx`, `TXNID`, `MerchantTxnId`, …) and you reconcile
against whatever your own backend recorded — normalising here would throw away the
only field you can match on.

### Base URL resolution

Most specific wins:

1. `origin` passed to `open()`
2. `data-suqo-origin` on the clicked element
3. `SuqoCheckout.configure({ origin })` or `window.SUQO_CHECKOUT_ORIGIN`
4. the origin the `<script>` itself was served from
5. a hardcoded fallback constant

Step 4 means the common case needs no configuration at all: load the script from
the checkout host and it targets that host.

## Modal behaviour

Fixed overlay, centred card (max 520px), rounded, close button, spinner while
loading, fade/scale in. Closes on: the close button, a backdrop click, Escape, or
the browser Back button.

Scroll is locked on the host `<body>` while open. The scrollbar's width is added
as padding so the page doesn't shift, and the host's previous `overflow` and
`padding-right` are saved and restored rather than cleared — the page may set
those for its own reasons.

## Message protocol

iframe → host, all tagged `{ source: 'suqo-checkout' }`:

| Message | Meaning |
| --- | --- |
| `suqo:alive` | document loaded and running scripts (posted from the app's root layout) |
| `suqo:ready` | checkout mounted |
| `suqo:resize` `{height}` | content height; the host animates the card to match |
| `suqo:gateway` | a gateway popup was just opened |
| `suqo:result` `{status, params}` | `success` \| `failed` \| `cancelled` |
| `suqo:close` | dismissed from inside the frame |

The host validates `event.origin` and ignores `event.source`. The payment result
legitimately arrives from the gateway popup rather than the iframe, so pinning the
source would drop it.

## Two load deadlines

`alive` and `ready` are separate messages because "nothing loaded" and "loading
slowly" need different handling.

- **4s for `alive`.** Nothing ran at all — a CSP `frame-ancestors` block, a dead
  link, an extension blocking frames. Not worth waiting on.
- **~25s for `ready`, starting when `alive` arrives.** The frame exists and is
  merely slow, so be patient.

On either timeout the spinner is replaced with an explanatory panel and an "open in
a new tab" link, and a `console.warn` names the likely cause. `alive` is posted
from the app's **root layout**, not the checkout tree — from inside the checkout it
would fire at the same moment as `ready`, making the split decorative and tripping
the 4s failure path on any genuinely slow load.

## The gateway popup

The buyer pays in a popup window, not in the frame. The sequence is fiddly and each
step is load-bearing:

1. The **iframe** opens the popup, not the host. A click inside the frame is a user
   gesture *there*; the host only learns of it via `postMessage`, asynchronously, by
   which point its own `window.open` is blocked.
2. The popup is opened **blank and synchronously** in the click handler, then
   navigated once the payment URL comes back. Opening it after the `await` has lost
   the gesture.
3. Form-post gateways (eSewa, ConnectIPS, NPS) target the popup **by name**, so the
   browser reuses that window instead of opening a second one.
4. The return page posts the result to `window.opener` **and** `window.opener.parent`
   with target `'*'`. Both hops, because one is fragile — the frame may have
   re-rendered. And `'*'` because the host takes a handle on the popup by name to
   close orphans, and *that call reassigns the popup's opener to the host*; naming
   the checkout origin would then address a window on a different origin and the
   browser would drop the message silently.
5. The host holds a handle on the popup and closes it on `pagehide`. A gateway
   window that outlives the page is still payable with nothing left to report to.
   `pagehide`, never `unload` — the latter is blocked by Permissions-Policy.

**Nothing may be appended to the gateway's return URL query string.** NPS appends
its own parameters with a literal `?` rather than `&`, so an added `?embed=1` comes
back as `?embed=1?MerchantTxnId=…`, swallowing the gateway's id and breaking
verification outright. This is why the embed is detected from the frame
relationship rather than a URL flag.

## Known limits

These are documented, not solved.

- **Third-party cookies.** The guest token is a cookie, so Safari — and Chrome
  after third-party cookie phase-out — will break `/renew/:id`'s token exchange
  inside the frame. `/pay/:id` has the same exposure.
- **No `frame-ancestors` CSP.** Framing works precisely because no such header
  exists, which also means *any* site can frame the checkout. A per-merchant
  allowlist is needed before this is safe to publicise.
- **The iframe is not sandboxed.** `allow-scripts allow-same-origin` on
  same-origin content is close to no sandbox anyway, and sandboxing blocks the
  custom-protocol bank deeplinks the Nepali gateways rely on. So it is left off
  deliberately rather than by omission.
- **Back-to-close leaves a history entry.** Opening pushes an entry so Back closes
  the modal; closing does not pop it. Calling `history.back()` on close would
  re-navigate an in-frame joint-session-history entry and read to the buyer as the
  whole page reloading.

## Local demo

`demo/index.html` is a bare host page. Serve it from a different origin than the
checkout so the cross-origin path is what gets exercised:

```bash
cd demo && python3 -m http.server 4500
# then open http://localhost:4500 and point it at your checkout with
# ?origin=http://localhost:3000
```

## Deployment — how the file gets served

**Today: the Next.js app serves it.** `frontend/public/suqo-checkout.js` is a
committed copy, reachable at `https://<checkout-host>/suqo-checkout.js`, and
`frontend/src/middleware.ts` exempts that exact path from auth. Because it sits on
the checkout origin, resolution step 4 does the right thing and a merchant needs no
configuration at all.

**This project stays the source of truth.** After editing
`public/suqo-checkout.js` here, run:

```bash
npm run sync         # copy into frontend/public/
npm run sync:check   # exit 1 if the two have drifted
```

A copy rather than a build step because the frontend's Docker build context is the
frontend directory alone — a prebuild hook reaching `../js-checkout` would work on a
laptop and fail in the image. `sync:check` exists so the drift is loud rather than
silent; a stale loader speaking an older protocol than the app is the failure mode
worth catching.

**If this later moves to its own host or CDN**, one thing has to change: resolution
step 4 would resolve to the CDN's origin, not the checkout's, so
`data-suqo-pay-id` would build a URL on the wrong host. Either stamp
`FALLBACK_ORIGIN` into the served copy at deploy time, or read an origin off the
script tag (`<script src="…" data-suqo-origin="https://test.suqo.ai">`) — neither is
implemented yet. Everything else about the protocol is origin-agnostic already: the
host validates messages against the origin of the iframe URL it opened, not against
where the script came from.
