# SUQO embedded checkout

A drop-in `<script>` that renders the SUQO payment block **inline** on a merchant's own
page, where they put a `<div>`. No modal, no overlay, no page takeover — a payment
element in their layout, like any other field.

One file, `public/suqo-checkout.js`. No build step, no dependencies, ES5, one global
(`SuqoCheckout`). Every style is inlined on the elements it creates, so a host page's CSS
cannot restyle the block's chrome and the chrome cannot leak styles out.

**Reimplementing or changing either half? Read [docs/protocol.md](./docs/protocol.md) first.** It is the
full contract — every message, every invariant, and why each one exists. The two halves ship
from different repos, so a change to one that is not mirrored in the other fails silently.

New to this repo? [docs/development.md](./docs/development.md) is the orientation doc — repo
layout, how the code is organized, and the edit/check/sync workflow.

The app side lives in the `frontend` project — `src/lib/embed/`, `src/components/embed/`, and
the page at `/c/[id]`.

## What it is for

The merchant's own backend creates a **checkout session** through the API and hands the buyer
its id. This collects the payment for it — nothing else. There is no phone step and no billing
form in the block, because by the time it renders there is nothing left to ask: the session
already knows who the buyer is and what they are buying.

So the block shows exactly what is still undecided — which gateway, and consent — and the
merchant keeps their own product page, their own summary, and their own layout.

## Quick start

```html
<script src="https://test.suqo.ai/suqo-checkout.js"></script>

<div id="my-payment-area" data-suqo-checkout-session-id="cks_9f2c41a8"></div>

<script>
  SuqoCheckout.configure({
    elementId: 'my-payment-area',
    onSuccess: function (params, message) { /* fulfil the order */ },
    onFailure: function (status, params, message) { /* tell the buyer */ },
  })
</script>
```

One id, and no buyer details on the page at all — the session carries them, created server-side
with your API key. Nothing about the customer touches the DOM, the URL, or anything a third-party
script on your page could read.

**Read ["When the callbacks don't fire"](#when-the-callbacks-dont-fire) before you build against
`onSuccess`.** On some surfaces it cannot fire, and fulfilment has to come from the webhook.

That's the whole integration — one attribute, and the callbacks that are the merchant's own
business logic. The block mounts on load; nothing needs to call `mount()`. Discovery is
re-run on DOM mutations, so a block rendered after the script runs (SPA views, lazy sections,
CMS widgets) mounts with no re-initialisation step.

`configure()` may run before or after the block mounts — callbacks are resolved when they
fire, not when the block is created, so script order does not decide whether a merchant hears
about a payment.

### The session is the credential

`/c/<sessionId>` renders from one public GET, so the id in that URL is the whole of what a
visitor needs. That is deliberate — it is what removes the handshake, and with it the whole
class of "the block is blank and I can't see why" failures.

It is safe on the same grounds the hosted `/checkout/<sessionId>` already stands on, and those
are conditions on the session rather than on this file: **single-use, short TTL, no PII in the
payload, and a uniform 404 for expired, paid or unknown.** The id is semi-public by nature — it
sits in your DOM — and nothing about it is a secret worth protecting beyond its lifetime.

For a **shareable standalone payment link**, use `/checkout/<sessionId>`: same id, full hosted
checkout, its own chrome.

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

Read off the container, so each block carries its own session.

| Attribute | Meaning |
| --- | --- |
| `data-suqo-checkout-session-id="cks_…"` | **The checkout session to pay.** The canonical spelling |
| `data-suqo-session-id="cks_…"` | Short alias for the above |
| `data-suqo-flow="redirect"` | Skip the iframe; render a link to the hosted checkout instead |
| `data-suqo-flow-label="…"` | Label for that link. Default: "Continue to payment" |
| `data-suqo-checkout="https://…"` | Full URL, used verbatim — the escape hatch for a non-standard path |
| `data-suqo-origin="https://…"` | Per-element base URL override |
| `data-suqo-checkout-block` | Marks the element as a container |

That is the whole surface. There are no attributes for the buyer, because there is nothing for
you to tell us about them — the session already carries the customer.

### Programmatic

```js
SuqoCheckout.mount('suqo-checkout-block', {
  sessionId: 'cks_9f2c41a8',        // or checkoutSessionId
  flow: 'redirect',                 // optional — link instead of an iframe
  flowLabel: 'Continue to payment', // optional label for that link
  origin: 'https://test.suqo.ai',   // optional per-mount override
  onReady:   function () {},
  onSuccess: function (params, message) {},          // gateway params + the backend's message
  onFailure: function (status, params, message) {},  // 'cancelled' | 'failed'
  onUnavailable: function (reason) {},               // the session cannot be paid at all
})

SuqoCheckout.unmount('suqo-checkout-block')
SuqoCheckout.configure({
  origin, elementId, sessionId, flow, onReady, onSuccess, onFailure, onUnavailable,
})
SuqoCheckout.origin   // getter — the currently resolved base URL
```

`configure({ sessionId })` is a convenience for the single-block case and is **consumed once**:
the first block without an id of its own takes it, and it is then cleared. Ids belong on the
container, because a page may carry several blocks — without the latch, a block rendered later
by an SPA route change would mount the same session again.

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

The frame URL is then built from the session id on the block — `/c/<id>` — unless
`data-suqo-checkout` gave a URL outright, which is used verbatim. The
merchant's own origin rides in the URL **hash**, never the query string — see "The gateway
window" below for why that distinction is not cosmetic.

Step 4 means the common case needs no configuration at all: load the script from the
checkout host and it targets that host.

### Which host to load it from

Sandbox and live are two deployments of the same build, and each serves its own copy of the
loader. Point the `<script>` at the one you are on and everything else follows from step 4:

| You are testing against | Script tag |
|---|---|
| Sandbox data | `https://test.suqo.ai/suqo-checkout.js` |
| Live data | `https://app.suqo.ai/suqo-checkout.js` |

Going live is that one-word change to the `src`. There is no separate CDN host, and
`data-suqo-origin` stays an escape hatch rather than something you have to set — if you do set
it, make sure it names the same deployment as the script tag, or the block will build its frame
on one environment while your session lives on the other.

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

| `suqo:redirect` `{url, reason}` | no popup is available — the host navigates the top-level page to the hosted checkout |
| `suqo:unavailable` `{reason}` | the session cannot be paid at all. Not a payment outcome, so no callback fires |

**Nothing travels the other way.** The host never posts to the frame: the session carries the
buyer, so there is nothing you hold that the frame needs.

The host validates `event.origin` on everything. It matches `event.source` against the
frame for every message **except** `suqo:result`, which legitimately arrives from the
gateway window rather than the frame — that one is routed by which block has a gateway open.

## Three load deadlines

They are separate because "nothing came back", "something came back but it wasn't ours" and
"ours came back and is slow" need different handling — and each is armed by a real signal
rather than by a guess about how long the previous stage should take.

- **20s for `load`**, armed at mount, disarmed by the iframe's own `load` event. Nothing came
  back at all.
- **8s for `alive`**, armed only once `load` has fired. A document came back but never ran our
  script — a CSP `frame-ancestors` block, an extension, someone else's error page at that URL.
- **25s for `ready`**, armed when `alive` arrives. Our script ran but the block never mounted,
  so this is the most patient of the three.

On any of them the spinner is replaced with an explanatory panel and an "open in a new tab"
link, and a `console.warn` names the likely cause — including a `no-cors` probe of the origin,
so the console can tell *connection refused* from *frame blocked*, which look identical from
outside and need opposite fixes.

Do not shorten these. An earlier version used a blind 4s `alive` timer and failed a cold
Next.js compile measured at 4.8s as "blocked" — the failure panel appeared before the document
had even arrived. `alive` is posted from the route's **layout**, not from the block; posted
from inside the block it would fire at the same moment as `ready` and make the split
decorative.

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

### The block states the outcome — you decide what happens next

When a payment settles, the block calls `onSuccess` / `onFailure` and shows a short line of its
own: "Payment successful.", "The payment did not go through.", or "Payment was cancelled before
it completed." — or the gateway's own wording, when it sent any.

It is a statement of fact, not a next step. It is sitting inside your layout and does not know
what comes after — an order page, a receipt, your own error screen — so it says what happened
and stops. **It never offers the buyer a second attempt**: one block, one attempt, one outcome.
A buyer who wants to try again does so from your page, with a new checkout session.

The callbacks are still where the work happens, but a merchant who writes neither no longer
strands the buyer on a spinner forever, which is what used to happen.

The buyer's payment is unaffected either way — it is already settled and your backend will have
the webhook regardless of what the page does.

### `cancelled` is not `failed`

`onFailure` also fires when the buyer closes the gateway window without paying — `'cancelled'`,
with empty `params`, because there was no transaction to report.

`onUnavailable(reason)` is separate from both, and fires when the session cannot be paid at
all: `'not-found'`, `'expired'`, `'spent'`, `'no-customer'`, `'no-methods'` or `'load-failed'`.
It is **not** a payment failure — nothing was attempted — so it does not go through
`onFailure`, which would tell you a payment was tried and rejected. The block shows the buyer
its own explanation; this is so your page can react to a session your integration created
wrong, which is the most common thing to get wrong.

`onFailure` receives `'cancelled'` when the buyer backed out at the gateway, and `'failed'`
when a payment was attempted and rejected. Check `status` rather than treating everything that
is not a success the same way: a buyer who changed their mind wants the basket offered again,
while a rejected payment is worth looking into. Nothing is charged in either case.

Cancellation is read from the gateway's return URL, not from the verify endpoint, because that
is the only place it exists — there was never a transaction for the backend to have an opinion
about, so asking it yields "Transaction not found."

To let a buyer try again, re-`mount()` the container: a fresh attempt opens a new gateway window
and delivers a new result, while duplicates within one attempt stay suppressed.

### `return_url`, and when it is followed

| Surface | `return_url` followed? | Why |
|---|---|---|
| Popup path (the usual one) | **No** | The buyer never left the merchant's page. The outcome arrives there through `onSuccess` / `onFailure`, and following it would render the seller's return page inside a window that is about to close |
| Redirect path (`suqo:redirect`, `data-suqo-flow="redirect"`) | **Yes** | The buyer *is* on SUQO's hosted page. It is the only way back |
| Hosted checkout opened directly | **Yes** | Unchanged, and always has been |

So the same seller setting behaves differently depending on which surface the buyer got, which
is why it is worth stating rather than leaving to be discovered.

The return page tells the two cases apart with `isGatewayWindow()`. `window.name` is the signal
that carries — it survives the whole cross-origin round trip, which is worth stating because the
opposite is the reasonable guess (Chrome does clear `window.name` on cross-origin navigation,
but the name is intact again by the time the buyer is back on the checkout origin).
There is deliberately **no `window.opener` fallback**. It looks like free redundancy and is not:
the hosted checkout is sometimes opened with `window.open('', '_blank')`, so that tab carries an
opener for its whole life — and treating one as proof of the embed would silently drop the
seller's `return_url` on a flow that has nothing to do with this SDK. It buys nothing either: if
the opener were severed, the result could not be posted over it regardless.

### When the callbacks don't fire

`onSuccess` and `onFailure` reach you over `postMessage`, which needs your page to still be
open. On two surfaces it will not be:

| Surface | Path | You hear about it via |
|---|---|---|
| Desktop or mobile browser | iframe + popup | `onSuccess` / `onFailure` |
| WebView with multiple windows enabled | iframe + popup | `onSuccess` / `onFailure` |
| WebView without it; in-app browsers (Instagram, Facebook, LINE) | the frame hands the page to SUQO's hosted checkout | **`return_url` + webhook only** |
| You opted out with `data-suqo-flow="redirect"` | a link to SUQO's hosted checkout | **`return_url` + webhook only** |

On the last two your page is gone before the payment settles, so nothing can call back into it.
You cannot tell in advance which row a given buyer will land on — a buyer opening your link from
Instagram's in-app browser gets a different row than the same buyer on desktop.

> **If your page might ever be opened inside an app, the session you create must carry a
> `return_url`.** It is the only way the buyer gets back to you.
>
> **Fulfil from the webhook, not from `onSuccess`.** Treat the callbacks as a desktop-case
> convenience. A merchant who ships orders from `onSuccess` has no fulfilment path at all on the
> redirect surfaces.

### Opting out of the embed

If you already know you are inside your own WebView and would rather not render a payment block
the buyer cannot complete, say so and the SDK renders a link to the hosted checkout instead:

```html
<div
  data-suqo-checkout-block
  data-suqo-checkout-session-id="cks_9f2c41a8"
  data-suqo-flow="redirect"
  data-suqo-flow-label="Continue to payment"
></div>
```

A link, not an automatic navigation — a block that took the page over on mount would fire from
your own router on an SPA, and Back would re-trigger it and trap the buyer.

**Nothing may be appended to the gateway's return URL query string.** NPS appends its own
parameters with a literal `?` rather than `&`, so an added `?embed=1` comes back as
`?embed=1?MerchantTxnId=…`, swallowing the gateway's id and breaking verification outright.
This is why `parentOrigin` rides in the hash and why embedding is detected from the frame
relationship rather than a URL flag.

## Known limits

These are documented, not solved.

- **Third-party cookies.** Anything the frame stores runs in a third-party context, so
  Safari — and Chrome after third-party cookie phase-out — can break it. The inline shape does
  not change this.
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

**Do not move this file to a CDN without doing one of two things first.** Resolution step 4
would then resolve to the CDN's origin rather than the checkout's, so every block would build
its frame URL on the wrong host. Either stamp `FALLBACK_ORIGIN` into the served copy at deploy
time, or make `data-suqo-origin` mandatory in the documented snippet — neither is implemented,
and this is a precondition rather than a caveat.

Note `ownScriptTag()` matches on filename, so it survives a CDN move; only the origin it
yields is wrong. Everything else about the protocol is origin-agnostic already: the host
validates messages against the origin of the iframe URL it opened, not against where the
script came from.
