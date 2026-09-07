# SUQO embedded checkout

A drop-in `<script>` that renders the SUQO payment block **inline** on a merchant's own
page, where they put a `<div>`. No modal, no overlay, no page takeover — a payment
element in their layout, like any other field.

One file, `public/suqo-checkout.js`. No build step, no dependencies, ES5, one global
(`SuqoCheckout`). Every style is inlined on the elements it creates, so a host page's CSS
cannot restyle the block's chrome and the chrome cannot leak styles out.

**Reimplementing or changing either half? Read [PROTOCOL.md](./PROTOCOL.md) first.** It is the
full contract — every message, every invariant, and why each one exists. The two halves ship
from different repos, so a change to one that is not mirrored in the other fails silently.

The app side lives in the `frontend` project — `src/lib/external-checkout/`,
`src/components/external-checkout/`, and the page at `/external-checkout/[id]`.

## What it is for

The merchant's own backend creates the subscription through the external API and hands the
buyer its id. This collects the payment for it — nothing else. There is no phone step and
no billing form in the block, because by the time it renders there is nothing left to ask:
the subscription already knows who the buyer is and what they are buying.

So the block shows exactly what is still undecided — which gateway, and consent — and the
merchant keeps their own product page, their own summary, and their own layout.

## Quick start

```html
<script src="https://test.suqo.ai/suqo-checkout.js"></script>

<div
  id="my-payment-area"
  data-suqo-subscription-id="4d7edf60-caef-427d-bcdc-b621e6c1ef85"
  data-fullname="Nabin Shrestha"
  data-email="nabin.shrestha@example.com"
  data-address="Jhamsikhel, Lalitpur, Nepal"
></div>

<script>
  SuqoCheckout.configure({
    elementId: 'my-payment-area',
    onSuccess: function (params, message) { /* fulfil the order */ },
    onFailure: function (status, params, message) { /* tell the buyer */ },
  })
</script>
```

That's the whole integration — attributes, and the callbacks that are the merchant's own
business logic. The block mounts on load; nothing needs to call `mount()`. Discovery is
re-run on DOM mutations, so a block rendered after the script runs (SPA views, lazy sections,
CMS widgets) mounts with no re-initialisation step.

`configure()` may run before or after the block mounts — callbacks are resolved when they
fire, not when the block is created, so script order does not decide whether a merchant hears
about a payment.

### The frame is inert without the SDK

`/external-checkout/<id>` does nothing on its own. Opened directly, or framed by anything that
does not send the initialisation message, it renders **blank** and makes no backend calls at
all — the payment element only starts once the SDK on the parent page initialises it.

For a **shareable standalone payment link**, use `/pay/<subscription_id>` instead: same
subscription id, full hosted checkout, collects the buyer's details itself.

### Why the buyer's details are required

The create-subscription call needs `full_name`, `email` and `address`. The hosted checkout
collects them in a form; the embedded block has no form, because the merchant already holds
them — the subscription is theirs, created by their own backend. So they pass them in, and the
block sends them with the payment.

Miss one and the block says which, before it opens any window or posts anything:

> This payment is missing buyer details the merchant must supply on the checkout block —
> full_name, email, address

**They never travel in the frame URL.** They are handed over by `postMessage`, targeted at the
checkout origin, once the frame reports itself alive. A URL ends up in server logs, browser
history and any `Referer` that leaks, and none of those are places to put a buyer's name,
email and address.

### Choosing where it renders

Name your own element — a fixed id cannot be assumed free on your page. Most specific wins:

| How | When to use it |
| --- | --- |
| `SuqoCheckout.mount(elOrId, opts)` | Explicit. Skips discovery entirely. |
| `SuqoCheckout.configure({ elementId: 'my-div' })`<br>or `<script … data-suqo-element-id="my-div">` | **The normal path.** |
| `<div data-suqo-checkout-block>` | Any element, and **any number of them** on one page. |
| `<div id="suqo-checkout-block">` | The zero-config fallback, if you name nothing. |

`container` is still accepted as an alias for `elementId`.

Two blocks on one page is a supported case: each keeps its own session, its own height, and
its own callbacks.

### Declarative attributes

Read off the container, so each one carries its own subscription.

| Attribute | Meaning |
| --- | --- |
| `data-suqo-subscription-id="ID"` | The subscription to pay for |
| `data-suqo-pay-id` / `data-suqo-renew-id` | Accepted aliases — both were subscription ids all along |
| `data-fullname` | Buyer's name — **required** |
| `data-email` | Buyer's email — **required** |
| `data-address` | Buyer's address — **required** |
| `data-phone` | Buyer's phone — optional |
| `data-suqo-checkout="https://…"` | Full URL, used verbatim |
| `data-suqo-origin="https://…"` | Per-element base URL override |
| `data-suqo-checkout-block` | Marks the element as a container |

Each of the four buyer fields also accepts a `data-suqo-`-prefixed spelling
(`data-suqo-email`, …), which takes precedence. Prefer it if the host page already uses those
bare attribute names for something of its own; otherwise the short spelling is fine.

### Programmatic

```js
SuqoCheckout.mount('suqo-checkout-block', {
  subscriptionId: '4d7edf60-caef-427d-bcdc-b621e6c1ef85',
  fullName: 'Nabin Shrestha',       // required, or the attribute equivalent
  email: 'nabin.shrestha@example.com',
  address: 'Jhamsikhel, Lalitpur, Nepal',
  phone: '9800000000',              // optional
  origin: 'https://test.suqo.ai',   // optional per-mount override
  onReady:   function () {},
  onSuccess: function (params, message) {},          // gateway params + the backend's message
  onFailure: function (status, params, message) {},  // 'cancelled' | 'failed'
})

SuqoCheckout.unmount('suqo-checkout-block')
SuqoCheckout.configure({ origin, elementId, onReady, onSuccess, onFailure })
SuqoCheckout.origin   // getter — the currently resolved base URL
```

`configure()` names the element and sets defaults for auto-discovered blocks; per-element
`data-suqo-*` attributes and per-mount options beat it.

Mounting the same container twice tears the first frame down rather than stacking a second.

`params` is the gateway's return parameters **exactly as the gateway sent them**, with no
renaming or filtering. Every gateway names its transaction id differently (`data`, `pidx`,
`TXNID`, `MerchantTxnId`, …) and you reconcile against whatever your own backend recorded —
normalising here would throw away the only field you can match on.

`message` is what SUQO's backend said when it settled the payment, and it is a separate
argument for a reason: `params` belongs to the gateway, and mixing our own keys into it would
break exactly that reconciliation. It is `undefined` when the backend said nothing, so it is
never copy the SDK invented — on a failure it is usually the only place the reason exists.

### Base URL resolution

Most specific wins:

1. `origin` passed to `mount()`
2. `data-suqo-origin` on the container
3. `SuqoCheckout.configure({ origin })` or `window.SUQO_CHECKOUT_ORIGIN`
4. the origin the `<script>` itself was served from
5. a hardcoded fallback constant

Step 4 means the common case needs no configuration at all: load the script from the
checkout host and it targets that host.

## The frame

```html
<iframe
  title="SUQO — Secure payment"
  allow="payment 'src'"
  sandbox="allow-scripts allow-forms allow-same-origin
           allow-popups allow-popups-to-escape-sandbox"
  allowtransparency="true"
  scrolling="no"
  style="width:100%; height:<reported>; border:0;
         overflow:hidden; background-color:transparent"
></iframe>
```

**Transparent, and sized by the content.** The frame has no fixed height and no internal
scrollbar; the page inside reports its height and the host applies it, so selecting NPS and
opening the bank picker grows the block in the merchant's own flow. The app drops its page
background on this route (`body[data-suqo-embed]`) so the merchant's background shows
through.

**Sandboxed** — which the modal version could not be. The gateway never loads in this
frame, only ever in a separate window, and `allow-popups-to-escape-sandbox` leaves that
window unsandboxed, so the banks' custom-protocol deeplinks still work. `allow-forms` is
required: the form-post gateways submit a real `<form>` into that window.

**The host origin travels in the hash**, `#parentOrigin=…`, never the query string — see
the NPS constraint under [The gateway window](#the-gateway-window). The frame uses it to
address its messages to one origin instead of `*`. That narrows who hears them; it is not
an access check, and cannot be while there is no `frame-ancestors` allowlist.

## Message protocol

frame → host, all tagged `{ source: 'suqo-checkout' }`:

| Message | Meaning |
| --- | --- |
| `suqo:alive` | document loaded and running scripts (posted from the route's layout) |
| `suqo:ready` | the block is on screen |
| `suqo:resize` `{height}` | content height; the host sets the iframe to it |
| `suqo:gateway` | a gateway window was just opened |
| `suqo:result` `{status, params, message?}` | `success` \| `cancelled` \| `failed`, plus the backend's own message when it sent one |

host → frame, the only message travelling that way:

| Message | Meaning |
| --- | --- |
| `suqo:init` `{customer}` | The buyer's details, sent on `alive` and again on `ready`. Targeted at the checkout origin, never `*` — it is the one message carrying personal data. Sent twice on purpose: the frame acknowledges nothing, and a duplicate just overwrites what it holds. |

The host validates `event.origin` on everything. It matches `event.source` against the
frame for every message **except** `suqo:result`, which legitimately arrives from the
gateway window rather than the frame — that one is routed by which block has a gateway open.

## Two load deadlines

`alive` and `ready` are separate messages because "nothing loaded" and "loading slowly"
need different handling.

- **4s for `alive`.** Nothing ran at all — a CSP `frame-ancestors` block, a dead link, an
  extension blocking frames. Not worth waiting on.
- **~25s for `ready`, starting when `alive` arrives.** The frame exists and is merely slow,
  so be patient.

On either timeout the spinner is replaced with an explanatory panel and an "open in a new
tab" link, and a `console.warn` names the likely cause. `alive` is posted from the route's
**layout**, not from the block — posted from inside the block it would fire at the same
moment as `ready`, making the split decorative and tripping the 4s failure path on any
genuinely slow load.

## The gateway window

The buyer pays in a separate window, not in the block. The merchant's page never navigates.
The sequence is fiddly and each step is load-bearing:

1. The **frame** opens the window, not the host. A click inside the frame is a user gesture
   *there*; the host only learns of it via `postMessage`, asynchronously, by which point its
   own `window.open` is blocked.
2. The window is opened **blank and synchronously** in the click handler, then navigated
   once the payment URL comes back. Opening it after the `await` has lost the gesture.
3. Form-post gateways (eSewa, ConnectIPS, NPS) target the window **by name**, so the browser
   reuses it instead of opening a second one.
4. The return page posts the result to `window.opener` **and** `window.opener.parent` with
   target `'*'`, plus a same-origin `BroadcastChannel`. All of them, because each is
   individually fragile — and `'*'` because the host takes a handle on the window by name to
   close orphans, and *that call reassigns the window's opener to the host*; naming the
   checkout origin would then address a window on a different origin and the browser would
   drop the message silently. The host de-duplicates.
5. The host holds a handle and closes the window on `pagehide`. A gateway window that
   outlives the page is still payable with nothing left to report to. `pagehide`, never
   `unload` — the latter is blocked by Permissions-Policy.
6. The block also polls `window.closed`, because there is no event for it cross-origin. A
   buyer who closes the gateway without paying gets a payable button back rather than a dead
   spinner.
7. **The window closes itself once the result is published** — on failure as well as success.
   The block reports the outcome on the merchant's own page, so a second "payment complete"
   screen in a window the buyer has to go and find adds nothing. Closing is safe at that point
   because the result is only published after the return page has verified the payment with the
   backend; nothing is still in flight.

### The block never announces the outcome — you do

When a payment settles the block shows a spinner and calls `onSuccess` / `onFailure`. It
displays no verdict of its own, on purpose: it is sitting inside your layout, it does not know
what happens next — an order page, a receipt, a retry, your own error screen — and anything it
declared would be a second, competing message beside yours.

**So both callbacks are effectively required.** A merchant who handles neither leaves the buyer
watching a spinner: the payment is settled and reported, but nothing moves them on. The
spinner is the gap between the result landing and your page taking over, which is why the demo
redirects from `onFailure` rather than printing anything.

The buyer's payment is unaffected either way — it is already settled and your backend will have
the webhook regardless of what the page does.

### `cancelled` is not `failed`

`onFailure` receives `'cancelled'` when the buyer backed out at the gateway, and `'failed'`
when a payment was attempted and rejected. Check `status` rather than treating everything that
is not a success the same way: a buyer who changed their mind wants the basket offered again,
while a rejected payment is worth looking into. Nothing is charged in either case.

Cancellation is read from the gateway's return URL, not from the verify endpoint, because that
is the only place it exists — there was never a transaction for the backend to have an opinion
about, so asking it yields "Transaction not found."

To let a buyer try again, re-`mount()` the container: a fresh attempt opens a new gateway window
and delivers a new result, while duplicates within one attempt stay suppressed.

### `return_url` is not followed inside the embed

A seller who has configured a `return_url` will find it **does not fire for embedded payments**,
and that is deliberate rather than an oversight.

The `return_url` exists to bring a buyer back to the seller's own site after the gateway took
them away from it. An embedded buyer never left: they are on the merchant's page the whole time,
and the merchant gets the outcome there through `onSuccess` / `onFailure`. Following it would
only render the seller's return page inside a window that is about to close.

The return page tells the two cases apart with `isGatewayWindow()`. `window.name` is the signal
that carries — it survives the whole cross-origin round trip, which is worth stating because the
opposite is the reasonable guess (Chrome does clear `window.name` on cross-origin navigation,
but the name is intact again by the time the buyer is back on the checkout origin).
`window.opener` is a fallback only: it survives a navigation the opener drives, but not
necessarily a browser-initiated one, and a gateway serving `Cross-Origin-Opener-Policy:
same-origin` severs it. The hosted checkout has neither signal, so it redirects exactly as it
always did.

**Nothing may be appended to the gateway's return URL query string.** NPS appends its own
parameters with a literal `?` rather than `&`, so an added `?embed=1` comes back as
`?embed=1?MerchantTxnId=…`, swallowing the gateway's id and breaking verification outright.
This is why `parentOrigin` rides in the hash and why embedding is detected from the frame
relationship rather than a URL flag.

## Known limits

These are documented, not solved.

- **Third-party cookies.** The subscription-id exchange happens inside a third-party frame,
  so Safari — and Chrome after third-party cookie phase-out — can break it. The inline shape
  does not change this.
- **No `frame-ancestors` CSP.** Framing works precisely because no such header exists, which
  also means *any* site can frame the checkout. `parentOrigin` narrows who the frame's own
  messages are addressed to, but enforces nothing. A per-merchant allowlist is needed before
  this is safe to publicise.
- **`BroadcastChannel` is partitioned.** Under Chrome's storage partitioning the frame's
  channel sits under the *merchant's* top-level site while the gateway window is first-party
  on the checkout site — different partitions never see each other. The channel helps when
  they happen to coincide and is silent otherwise; the opener post is the path that has to
  work.

## Local demo

`demo/index.html` is a bare host page with deliberately hostile CSS. Serve it from a
different origin than the checkout so the cross-origin path is what gets exercised:

```bash
npm run demo   # then open http://localhost:4500/demo/
```

It serves the **project root**, not `demo/`, because the page loads the loader from
`../public/suqo-checkout.js` — served out of `demo/` alone that path is outside the root and
404s, and the only symptom is a page where nothing renders and `SuqoCheckout is not defined`
in the console.

Point it at your checkout with the origin field. Note the origin must be a port the
backend's CORS allowlist accepts — `:3000` is, `:3001` is not, and that failure looks
exactly like a broken embed.

## Deployment — how the file gets served

**Today: the Next.js app serves it.** `frontend/public/suqo-checkout.js` is a committed
copy, reachable at `https://<checkout-host>/suqo-checkout.js`, and
`frontend/src/middleware.ts` exempts that exact path from auth — before the test-deployment
route gate, so `test.suqo.ai` serves its own loader rather than 404ing it. Because the file
sits on the checkout origin, resolution step 4 does the right thing and a merchant needs no
configuration at all.

**This project stays the source of truth.** After editing `public/suqo-checkout.js` here:

```bash
npm run check        # node --check
npm run sync         # copy into frontend/public/
npm run sync:check   # exit 1 if the two have drifted
```

A copy rather than a build step because the frontend's Docker build context is the frontend
directory alone — a prebuild hook reaching `../js-checkout` would work on a laptop and fail
in the image. `sync:check` exists so the drift is loud rather than silent; a stale loader
speaking an older protocol than the app is the failure mode worth catching.

**If this later moves to its own host or CDN**, one thing has to change: resolution step 4
would resolve to the CDN's origin, not the checkout's, so `data-suqo-subscription-id` would
build a URL on the wrong host. Either stamp `FALLBACK_ORIGIN` into the served copy at deploy
time, or read an origin off the script tag — neither is implemented yet. Everything else
about the protocol is origin-agnostic already: the host validates messages against the
origin of the iframe URL it opened, not against where the script came from.
