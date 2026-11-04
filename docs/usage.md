# Using the SUQO embedded checkout

A guide for merchants embedding the SUQO payment block on their own page. For the repo's own
contributor docs see [development.md](./development.md) (orientation) and
[protocol.md](./protocol.md) (full wire protocol) — neither is needed to integrate.

## What it is

One `<script>` tag and one `<div>`. The buyer pays **inline**, in your page's own layout — no
modal, no page takeover.

Your backend creates a **checkout session** through SUQO's API and hands the buyer its id.
This block collects the payment for that session — nothing else. There's no phone step and no
billing form in the block, because by the time it renders there's nothing left to ask: the
session already knows who the buyer is and what they're buying. You keep your own product page,
your own order summary, your own layout; the block only shows what's still undecided — which
gateway, and consent.

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

One id, and no buyer details anywhere on the page — the session already carries them, created
server-side with your API key. Nothing about the customer touches the DOM, the URL, or anything
a third-party script on your page could read.

The block mounts on load; nothing needs to call `mount()`. It also re-scans the page on DOM
changes, so a block rendered later — an SPA route, a lazy section, a CMS widget — mounts with no
extra step. `configure()` can run before or after the block mounts: its callbacks attach
whenever they're given, not only at mount time, so script order never decides whether you hear
about a payment.

**Before you build against `onSuccess`, read [When the callbacks don't fire](#when-the-callbacks-dont-fire-and-return_url).**
On some surfaces it cannot fire at all, and fulfilment has to come from your webhook instead.

## Which host to load it from

Sandbox and live are two separate deployments. Point the `<script>` at the one you're using —
everything else resolves from that automatically:

| You're testing against | Script tag |
|---|---|
| Sandbox data | `https://test.suqo.ai/suqo-checkout.js` |
| Live data | `https://app.suqo.ai/suqo-checkout.js` |

Going live is that one-word change to the `src`. The loader builds its frame URL from the host
it was loaded from, so as long as your checkout session was also created against that same
environment, nothing else needs to change.

## Choosing where it renders

Name your own element — don't assume a fixed id is free on your page. Most specific wins:

| How | When to use it |
| --- | --- |
| `SuqoCheckout.mount(elOrId, opts)` | Explicit — skips auto-discovery entirely. |
| `SuqoCheckout.configure({ elementId: 'my-div' })` or `<script … data-suqo-element-id="my-div">` | **The normal path.** |
| `<div data-suqo-checkout-block>` | Any element, and any number of them on one page. |
| `<div id="suqo-checkout-block">` | Zero-config fallback, if you name nothing. |

`container` is accepted as an alias for `elementId`.

Two blocks on one page is supported: each keeps its own session, its own height, and its own
callbacks.

## Declarative attributes

Read off the container, so each block carries its own session:

| Attribute | Meaning |
| --- | --- |
| `data-suqo-checkout-session-id="cks_…"` | **The checkout session to pay.** Canonical spelling. |
| `data-suqo-session-id="cks_…"` | Short alias for the above. |
| `data-suqo-flow="redirect"` | Skip the iframe; render a link to the hosted checkout instead. |
| `data-suqo-flow-label="…"` | Label for that link. Default: "Continue to payment". |
| `data-suqo-checkout="https://…"` | A full URL, used verbatim — an escape hatch for a non-standard path. |
| `data-suqo-origin="https://…"` | Per-element base URL override. |
| `data-suqo-checkout-block` | Marks the element as a container. |

There are no attributes for the buyer — there's nothing for you to tell the block about them,
since the session already carries the customer.

## Programmatic API

```js
SuqoCheckout.mount('suqo-checkout-block', {
  sessionId: 'cks_9f2c41a8',        // or checkoutSessionId
  flow: 'redirect',                 // optional — link instead of an iframe
  flowLabel: 'Continue to payment', // optional label for that link
  origin: 'https://test.suqo.ai',   // optional per-mount override
  onReady:   function () {},
  onSuccess: function (params, message) {},          // gateway params + the backend's message
  onFailure: function (status, params, message) {},  // 'cancelled' | 'failed'
  onUnavailable: function (reason) {},                // the session cannot be paid at all
  onIntent: function (url) {},                        // a bank-app deeplink — see below
})

SuqoCheckout.unmount('suqo-checkout-block')

SuqoCheckout.configure({
  origin, elementId, sessionId, flow, onReady, onSuccess, onFailure, onUnavailable, onIntent,
})

SuqoCheckout.origin   // getter — the currently resolved base URL
```

`configure({ sessionId })` is a convenience for the single-block case, and it's **consumed
once**: the first block with no id of its own takes it, then it's cleared. Put ids on the
container itself if your page might carry more than one block — otherwise a block rendered
later by an SPA route change would try to mount the same session again.

`configure()` sets defaults for auto-discovered blocks and names the element for the
single-block case; per-element `data-suqo-*` attributes and per-`mount()` options always win
over it.

Mounting the same container twice tears the first frame down rather than stacking a second.

**`params`** is the gateway's return data **exactly as the gateway sent it**, with no renaming
or filtering. Every gateway names its transaction id differently (`data`, `pidx`, `TXNID`,
`MerchantTxnId`, …) — reconcile against whatever field your own backend already recorded.

**`message`** is separate from `params` because it comes from SUQO's backend, not the gateway —
mixing the two would break that reconciliation. It's `undefined` when the backend said nothing;
on a failure, it's often the only place the reason is stated.

## How a payment settles

When a payment settles, the block calls `onSuccess` or `onFailure` and shows a short line of its
own — "Payment successful.", "The payment did not go through.", "Payment was cancelled before it
completed." — or the gateway's own wording, when it sent one.

That line is a statement of fact, not a next step: the block sits inside your layout and has no
idea what comes after — an order page, a receipt, your own error screen. **It never offers the
buyer a second attempt.** One block, one attempt, one outcome. A buyer who wants to try again
does so from your own page, with a new checkout session — re-`mount()` the container to start
one.

The buyer's payment itself is unaffected by any of this: it's already settled, and your backend
will get the webhook regardless of what your page does.

### `cancelled` is not `failed`

`onFailure` also fires when the buyer closes the payment window without paying —
status `'cancelled'`, with empty `params`, since there was never a transaction to report.

Check `status` rather than treating every non-success the same way:

- **`'cancelled'`** — the buyer backed out. Offer the basket again.
- **`'failed'`** — a payment was attempted and rejected. Worth looking into; nothing was
  charged.

`onUnavailable(reason)` is a different thing again, and fires when the session can't be paid at
all — `'not-found'`, `'expired'`, `'spent'`, `'no-customer'`, `'no-methods'`, or `'load-failed'`.
It's **not** a payment failure (nothing was attempted), so it never goes through `onFailure`.
It's usually a sign your integration created the session wrong — an expired or already-used id,
most commonly.

### `onIntent` — a bank-app deeplink, handed to you verbatim

Some gateways hand off to a bank or wallet app through a non-`http(s)` deeplink (`intent://…`,
`fonepayApp://…`). The frame can't navigate your page to one itself — it's sandboxed so it
can't move your top-level page at all — so it only asks: `onIntent(url)` fires with the raw
deeplink, and **the SDK never navigates anywhere on it itself.** What you do next — typically
`location.href = url`, in your own page — is your own code's call.

`javascript:`, `data:`, `file:` and `blob:` are refused before they'd ever reach your handler.
Everything else passes through exactly as the gateway sent it, same as `params` does.

No `onIntent` configured? Nothing breaks — the console gets a warning and the buyer is left
exactly where they'd be without this feature, not stuck on a dead spinner.

## When the callbacks don't fire, and `return_url`

Most payments complete in a popup, on top of your own page — the buyer never leaves it, and the
outcome arrives through `onSuccess` / `onFailure`. But on two surfaces that popup can't open, and
your page is gone before the payment settles:

| Surface | What happens | You hear about it via |
|---|---|---|
| Desktop or mobile browser | Payment opens in a popup, on top of your page | `onSuccess` / `onFailure` |
| In-app browser (Instagram, Facebook, LINE, some WebViews) | The script navigates your top-level page to SUQO's hosted checkout, automatically | **`return_url` + your webhook only** |
| You opted out with `data-suqo-flow="redirect"` | A link to SUQO's hosted checkout | **`return_url` + your webhook only** |

You can't tell in advance which row a given buyer lands on — the same buyer gets a different
path on desktop than from an Instagram link.

The navigation in the in-app browser row is done by the script, not the frame: the sandboxed
frame cannot move your page, so it asks, and the script does it. It happens without the buyer
doing anything, and it replaces your document — anything held only in memory (an unsaved cart,
SPA state, form input) is lost. Persist it before the buyer reaches the block, and use
`return_url` to restore it. No callback fires on this path.

> **If your page might ever be opened inside an app, the checkout session you create must
> carry a `return_url`.** It's the only way that buyer gets back to you.
>
> **Fulfil orders from your webhook, not from `onSuccess`.** Treat the callbacks as a
> desktop-case convenience — a merchant who ships orders only from `onSuccess` has no
> fulfilment path at all on the in-app-browser / redirect surfaces.

## Opting out of the embed

If you already know your page is being rendered inside your own WebView and would rather not
show a payment block the buyer can't complete there, say so — the SDK renders a link to the
hosted checkout instead of an iframe:

```html
<div
  data-suqo-checkout-block
  data-suqo-checkout-session-id="cks_9f2c41a8"
  data-suqo-flow="redirect"
  data-suqo-flow-label="Continue to payment"
></div>
```

This renders a link, not an automatic navigation — an automatic redirect on mount would fire
again from your own router on every back-navigation and trap the buyer.

## What the frame looks like

```html
<iframe
  title="SUQO — Secure payment"
  style="width:100%; height:<reported>; border:0; overflow:hidden; background:transparent"
></iframe>
```

Transparent, and sized to its own content — there's no fixed height and no internal scrollbar.
The frame reports its height and the block applies it, so opening the bank picker inside the
block grows it in your own page's flow rather than scrolling inside a box.

The buyer pays in a separate window, not inside the frame or your page — your page does not
navigate to it. That window closes itself once the result is known, on failure as well as success,
so the buyer isn't left to go find and close a leftover tab.

If the block never finishes loading, it shows an explanatory panel with an "open in a new tab"
link rather than hanging on a spinner forever — this can take up to ~50 seconds to appear on a
very slow connection, since it waits through a few separate stages (the document loading, the
script running, the block itself mounting) before giving up.

## Known limits

- **Third-party cookies.** Anything the frame stores runs in a third-party browser context, so
  Safari — and Chrome, after third-party cookie phase-out — can restrict it. This is a platform
  constraint, not something specific to this integration.
- **Any site can frame the checkout today.** There's no `frame-ancestors` restriction yet, so
  nothing stops a different site from embedding the same block. This doesn't expose buyer data —
  the session is scoped, single-use, and carries no PII — but it's worth knowing if you were
  assuming otherwise.

## Troubleshooting

**The block never appears / stays blank.**
Open the console. A `console.warn` names the likely cause when a load deadline expires. Common
causes: the session id is wrong, expired, or already used; the script's `src` points at a
different environment (sandbox vs. live) than the one the session was created in; or the page
has a Content-Security-Policy that blocks framing.

**`SuqoCheckout is not defined`.**
The `<script>` tag didn't load — check the `src` URL and that nothing (an ad blocker, a CSP
`script-src`) is blocking it.

**It worked in testing but a specific buyer says nothing happened.**
Likely an in-app browser (see [When the callbacks don't fire](#when-the-callbacks-dont-fire-and-return_url))
with no `return_url` set on the session — check the webhook log for that buyer's session instead
of relying on the callback having fired.

**Two blocks on one page are interfering with each other.**
Give each container its own `data-suqo-checkout-session-id` rather than relying on
`configure({ sessionId })`, which is consumed by only the first matching block.
