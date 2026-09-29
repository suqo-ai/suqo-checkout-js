# SUQO embedded checkout — protocol and implementation spec

This is the contract between the **host** (`public/suqo-checkout.js`, on a merchant's page) and
the **frame** (the SUQO app's `/c/[id]` route). It documents what exists today
and *why*, in enough detail to reimplement either half from scratch.

Read this before changing either side. The two halves ship from different repos, so a change to
one that is not reflected in the other fails silently — usually as a blank block or a payment
whose outcome never reaches the merchant.

- Host: `js-checkout/public/suqo-checkout.js` (this repo — the source of truth)
- Frame: `frontend/src/lib/embed/`, `frontend/src/components/embed/`, `frontend/src/app/c/[id]/`
- The served copy of the host is `frontend/public/suqo-checkout.js`; see **Sync** in
  [README.md](../README.md).

---

## 1. The concept

A merchant already has a product page, a customer record, and a **checkout session** created
through SUQO's API. What they lack is a way to take the payment without sending the buyer to
someone else's site.

The session is what makes the rest of this simple. It is created server-side with the
merchant's API key and already carries the buyer and the line items, so the frame needs one
public GET and nothing from the page it is embedded in — no buyer details in the DOM, and no
host-to-frame message at all.

So the SDK renders a **payment element inline** — a gateway picker, a consent checkbox and a Pay
button, in a `<div>` the merchant chooses — and nothing else. No modal, no overlay, no product
summary, no steps. Everything the buyer has already decided stays the merchant's to display.

Three parties, three jobs:

| Party | Owns |
|---|---|
| **Merchant page** | Layout, the buyer's details, what happens after the payment |
| **Frame** (SUQO app) | The gateway list, the payment call, the hand-off to the gateway |
| **Gateway window** | The actual payment, and reporting the outcome back |

### Why an iframe at all

The block handles card and bank credentials indirectly and calls SUQO's API with a scoped
token. Neither should be reachable from the merchant's own scripts, and the merchant should not
have to hold a SUQO token in their page. A cross-origin iframe gives that boundary for free: the
merchant cannot read into it, and it cannot read out.

The cost is that an iframe cannot size itself, cannot navigate its parent, and cannot be spoken
to except by `postMessage`. Everything in §3 exists to pay that cost.

### Why the gateway opens in a separate window

The Nepali gateways (eSewa, Khalti, ConnectIPS, NPS) cannot run inside a frame:

- They set framing restrictions of their own.
- They rely on **custom-protocol deeplinks** (`fonepayApp://…`) to hand off to bank apps, and a
  sandboxed frame cannot navigate to a custom scheme.

Navigating the merchant's whole tab is the other option, and it is what the *hosted* checkout
does. For the embed it is wrong: it throws away the merchant's page mid-purchase. So the frame
opens a **named popup window**, the gateway lives there, and the merchant's page never moves.

### Why the frame is sandboxed

`sandbox="allow-scripts allow-forms allow-same-origin allow-popups
allow-popups-to-escape-sandbox"`.

This is only possible *because* the gateway lives elsewhere. `allow-popups-to-escape-sandbox`
means the popup is **not** sandboxed, so the bank deeplinks still work in the window that
actually needs them. `allow-forms` is required because the form-post gateways submit a real
`<form>` into that window.

An earlier design framed the gateway directly and therefore could not sandbox at all. If anyone
proposes moving the gateway back into the frame, the sandbox has to come off with it.

---

## 2. The full sequence

```
merchant.com/checkout
│
├─ merchant's backend: POST /api/payment/checkout-sessions/   (their API key)
│     → { public_id: "cks_…" }    ← carries the buyer and the line items
│
├─ <script src="https://test.suqo.ai/suqo-checkout.js">
│  └─ on DOMContentLoaded (+ MutationObserver for later DOM):
│     find the container → read its session id → mount an iframe
│
└─ <div id="my-payment-area" data-suqo-checkout-session-id="cks_…">
   │
   └─ iframe  src = <origin>/c/cks_…#parentOrigin=<encoded merchant origin>
      │
      │  ── frame boot ─────────────────────────────────────────────
      ├─ layout mounts  → postToHost('suqo:alive')     ── host clears its load deadline
      │                                                 ── host replies with NOTHING (§3)
      ├─ GET /api/payment/checkout-sessions/cks_…/       (public)
      │     → { line_items, customer_id, seller_details, expires_at, completed_at, is_expired }
      │     → guards: paid? expired by the clock or the flag? no customer? no seller?
      │       any of them ⇒ postToHost('suqo:unavailable', {reason}) and stop
      ├─ total = Σ line_items
      ├─ GET  /api/company/available-payment-methods/<seller_details.id>/   (public)
      ├─ ResizeObserver on the card → postToHost('suqo:resize', {height})  ── host sets iframe height
      └─ block rendered  → postToHost('suqo:ready')     ── host removes its spinner, fires onReady
         │
         │  ── buyer taps Pay ────────────────────────────────────────
         ├─ openGatewayWindow()          ← SYNCHRONOUS, before any await (see §5.1)
         │
         ├─ no window?  → postToHost('suqo:redirect', {url: <origin>/checkout/cks_…})
         │                and STOP — pay is never called, the session stays open (§5.13)
         │                └─ host navigates the top-level page there. Callbacks cannot fire.
         │
         ├─ postToHost('suqo:gateway')
         ├─ POST /api/payment/checkout-sessions/cks_…/pay/   (public, no token)
         │        { payment_method, instrument_code?, payment_mode, success_url, failure_url }
         │     → { payment_url } or { form_url, form_data|fields }
         ├─ sendToGateway(...) → navigate or form-POST into the named window
         └─ phase = 'awaiting'  (spinner + "bring the window back")
            │
            └─ gateway window
               ├─ buyer pays / fails / cancels
               └─ returns to <origin>/payment-success?<gateway params>&status=…
                  ├─ status=cancelled?  → skip verify entirely (see §5.6)
                  ├─ else POST /api/subscriber/subscription-payment-verify/
                  └─ publishResult(status, params, message)
                     ├─ BroadcastChannel('suqo:embed-result')
                     ├─ window.opener.postMessage(payload, '*')
                     └─ window.opener.parent.postMessage(payload, '*')
                        │
                        └─ frame settles → closes the gateway window
                                        → postToHost('suqo:result', …)
                                          → host fires onSuccess / onFailure
                                            → MERCHANT decides what the buyer sees next
```

---

## 3. Message protocol

Every message carries `source: 'suqo-checkout'`. Anything without it is ignored — a merchant's
page is full of unrelated `postMessage` traffic (analytics, chat widgets, other embeds).

### frame → host

| `type` | Payload | Meaning | Host must |
|---|---|---|---|
| `suqo:alive` | — | The document loaded and is running scripts | Clear the load deadline; arm the ready deadline |
| `suqo:ready` | — | The block is on screen, payable or not | Remove the spinner; drop `min-height`; fire `onReady` |
| `suqo:resize` | `{height}` | Content height in px | Set `iframe.style.height` (plus chrome, see §5.4) |
| `suqo:gateway` | — | A gateway window was just opened | Remember it, for `pagehide` cleanup; clear the result latch |
| `suqo:redirect` | `{url, reason}` | No popup is available; the payment cannot happen in the frame | Validate the URL, then navigate the **top-level** page to it. See §5.12 |
| `suqo:result` | `{status, params, message?}` | The payment settled | Fire `onSuccess`/`onFailure` **exactly once** |
| `suqo:unavailable` | `{reason}` | The session cannot be paid at all | Nothing required. Not a payment outcome — do **not** fire `onFailure` |

`suqo:unavailable` carries one of `not-found`, `expired`, `spent`, `no-customer`, `no-methods`,
`load-failed`. It is finer-grained than what the buyer is shown on purpose: `spent` and `expired`
read the same to them and are opposite facts to whoever built the integration.

`status` is `'success' | 'failed' | 'cancelled'`. See §5.6 for why `cancelled` is separate.

**The protocol is one-directional.** The frame speaks; the host listens and acts. There is no
host → frame message, and none should be added — the session carries everything the frame
needs, so anything sent down would be buyer-shaped data on the wire for no reason.

### Targeting and validation

| | Target origin | Validation on receipt |
|---|---|---|
| frame → host | `getHostOrigin()` from `#parentOrigin`, else `'*'` | Host checks `event.origin === session.origin`, and `event.source === iframe.contentWindow` for **everything except `suqo:result`** |
| return page → frame/host | `'*'` — **deliberately**, see §5.3 | Origin-checked on receipt |

`suqo:result` is the one message not matched by `event.source`: it legitimately arrives from the
**gateway window**, not the frame. Pinning the source would drop it. The host instead routes it
to whichever session has a gateway open.

`suqo:redirect` is the one message whose **payload** is validated, and it is the only one that
asks the host to *act* rather than to observe. `event.origin` proves the checkout origin asked;
it does not prove the URL is safe. See §5.12.

---

## 4. Frame-side implementation inventory

### `src/lib/embed/` and `src/components/embed/`

| File | Holds |
|---|---|
| `src/lib/embed/bridge.ts` | `postToHost`, `isFramed`, `isNativeHost`, `getHostOrigin`, `openGatewayWindow`, `watchGatewayWindow`, `subscribeToResult`, `publishResult`, `isGatewayWindow` |
| `src/lib/embed/gateway.ts` | `sendToGateway`, `returnUrlOnThisOrigin` — the cross-window hand-off |
| `src/components/embed/EmbedShell.tsx` | `suqo:alive`, the resize observer, `data-suqo-embed` |
| `src/components/embed/EmbedPaymentBlock.tsx` | The gateway list, the NPS picker, Pay, and the popup-unavailable branch |
| `src/app/c/[id]/` | The route: one public GET, the terminal-state guards, `suqo:ready` / `suqo:unavailable` |

Two things are easy to get wrong when reimplementing this:

- **There is no handshake module**, and none should appear. No `subscribeToCustomer`, no
  module-scope message buffer, no boot gate — the frame renders from its own fetch.
- **`isNativeHost()` is not a WebView test.** It is true only when a native host injected a
  bridge — `window.SuqoWebView.postMessage(string)`, or `window.ReactNativeWebView` for the RN
  SDK. A plain Android WebView or WKWebView injects nothing and is false there, which is
  correct: that host cannot receive a `suqo:result` either, and it is served by `suqo:redirect`
  instead. Sniffing the user agent for it would be a guess, and a wrong guess sends a buyer
  down a path whose outcome nobody is listening for.

## 5. Invariants — each of these was a bug first

*5.9 and 5.11 are retired — they described the token exchange and the `suqo:init` boot
gate, neither of which exists any more. The numbers are left as gaps on purpose: §3 links
to §5.12, and renumbering would break that for a tidier list.*

### 5.1 Open the gateway window synchronously, in the click handler, from the frame

```ts
const gatewayWindow = openGatewayWindow()   // BEFORE any await
// ... then await the create-subscription call, then navigate the window
```

A click inside the frame is a user gesture **in that document only**. The host learns of it by
`postMessage`, asynchronously, so its own `window.open` is a popup-blocker violation. And
opening after the `await` has spent the gesture. The window is opened blank and navigated later.

### 5.2 Never put anything in the gateway's return-URL query string

NPS appends its own return parameters with a literal `?` instead of `&`. An added `?embed=1`
comes back as `?embed=1?MerchantTxnId=…`, swallowing the gateway's transaction id and breaking
verification outright.

This is why `parentOrigin` rides in the **hash**, and why "am I embedded?" is answered by the
frame relationship rather than a URL flag.

### 5.3 The return page posts with target `'*'`

The host takes a handle on the gateway window **by name** to close orphans, and *that call
reassigns the window's `opener` to the host*. Naming the checkout's own origin would then be
addressing a window on a different origin, and the browser drops the message silently. The
receiver validates origin instead.

### 5.4 Measure the card, not the document; and add the host's chrome

- The frame reports **`card.getBoundingClientRect().height`**. `documentElement` and `body`
  both stretch to the frame's own height, so reporting either feeds the host's last answer
  straight back: the block can then only grow, and collapsing a section leaves a tall gap.
- The host adds `iframe.offsetHeight - iframe.clientHeight` before setting the height, because
  a host stylesheet can put a border on the iframe (with `!important` it beats the inline
  `border: 0`), which would otherwise eat that many pixels of content.
- The frame sets `overflow: hidden` and `scrollbar-width: none` on `<html>` via
  `[data-suqo-embed]`. The app styles `::-webkit-scrollbar` globally, which replaces the
  platform's overlay scrollbar with one that takes layout space — and inside a frame sized to
  the exact content height, that gutter is reserved forever.

### 5.5 Return URLs must be built on the serving origin

`NEXT_PUBLIC_SUCCESS_URL` / `_FAILURE_URL` are absolute and baked in at build time. Serve the
app from any other host — a LAN IP, a preview deploy, a tunnel — and the gateway returns the
buyer to whatever the env names. For the embed that is worse than a dead link: the result then
arrives from an origin that does not match the frame's, the host drops it, and `onSuccess`
never fires. Silently. `returnUrlOnThisOrigin()` keeps the configured path and replaces the
origin.

### 5.6 `cancelled` is not `failed`, and cancellation must not be verified

Read it from the return URL, because that is the only place it exists — there was never a
transaction, so the verify endpoint answers `"Transaction not found."`, which reads to the buyer
as a fault and tells the merchant `failed` when nothing was attempted.

The two need opposite handling downstream: offer the basket again vs investigate the payment.

### 5.7 Deliver the result exactly once per attempt

It travels three paths on purpose, because each can be severed:

- `BroadcastChannel` — needs no window reference, so it survives a severed opener; but under
  Chrome's storage partitioning the frame's channel sits under the **merchant's** top-level
  site while the gateway window is first-party on the checkout site. Different partitions never
  see each other, so this is best-effort.
- `opener.postMessage` — the path that has to work.
- `opener.parent.postMessage` — because the frame may have re-rendered while the buyer was away.

So arriving two or three times is expected. Firing the merchant's handler twice is the worst bug
available here (double fulfilment), so the host latches on first delivery. The latch is released
only by a new `suqo:gateway` — a real second attempt, not a duplicate of the first.

### 5.8 Three load deadlines, armed by real signals

| Deadline | Armed by | Length | Means |
|---|---|---|---|
| load | mount | 20s | Nothing came back at all |
| alive | the iframe's `load` event | 8s | A document came back but never ran our script (CSP `frame-ancestors`, an extension, the wrong URL) |
| ready | `suqo:alive` | 25s | Our script ran but the block never mounted |

**Do not shorten the load deadline to a few seconds.** An earlier version used a blind 4s
`alive` timer and failed a cold Next.js compile measured at **4.8s** as "blocked" — the failure
panel appeared before the document had even arrived. On failure the host also probes the origin
with a `no-cors` fetch, so the console can distinguish *connection refused* from *frame
blocked*; those look identical from outside and need opposite fixes.

### 5.10 `window.name` is the only signal — never fall back to `window.opener`

Measured, because the reasonable guess is the opposite. Chrome does clear `window.name` on
cross-origin navigation, but by the time the buyer is back on the checkout origin it reads
correctly again, so `isGatewayWindow()` tests it and nothing else.

`window.opener` looks like free redundancy and is not. The hosted checkout is sometimes opened
with `window.open('', '_blank')`, so **that tab carries an opener for its whole life** — and a
fallback would read it as a gateway window, making the return page skip `redirectToReturnUrl`
and silently drop the seller's `return_url` on a flow that has nothing to do with the embed. It
buys nothing either: an opener severed by a browser-initiated navigation (observed) could not
carry the result back regardless.

### 5.12 The host owns top-level navigation, and validates the URL anyway

A sandboxed frame cannot navigate the page that framed it. `allow-top-navigation-by-user-activation`
is deliberately absent from the sandbox and **stays absent** — the flags in §1 are what keep the
merchant's scripts away from the payment payload, and loosening them to solve this would trade
the whole reason the frame is cross-origin for a fallback path.

So the frame asks, and the host navigates. The host re-validates the payload:

1. It must parse.
2. It must be `http:` or `https:`.
3. **Its origin must equal the frame's origin.**

Step 3 is the one that matters, and `event.origin` does not replace it: that proves the checkout
origin *asked*, not that what it asked for is safe. Without step 3, any reflected value inside
the checkout app becomes an open redirect **on every merchant page that embeds the SDK** — a
far better exploit than the same bug confined to one origin. Step 2 is subsumed by step 3
(`new URL('javascript:…').origin` is `"null"`) and kept explicit anyway, because a security
reviewer reading this file should find one line rather than a footnote.

The payload is therefore never a gateway URL. It is always **the hosted continuation of this
same session**, `<origin>/checkout/<sessionId>` — which is also why the same-origin rule costs
the legitimate path nothing.

**The merchant's callbacks cannot fire on this path.** Their document is destroyed by the
navigation. `onSuccess` / `onFailure` are a popup-path optimisation; the contract is the
session's `return_url` plus the webhook. A merchant who fulfils orders from `onSuccess` has no
fulfilment path at all here.

### 5.13 The frame must emit `suqo:redirect` before any state-changing call

`window.open` runs synchronously in the click handler (§5.1), so the frame learns whether a
popup exists **before** it has called `pay`. That ordering is what makes the fallback safe: the
session is still `open`, nothing was created, and the hosted page can start it from the
beginning.

It is true today by accident of §5.1's ordering. It is now load-bearing. A future frame version
that pre-creates the payment — to have a gateway URL in hand, say — breaks this silently: the
buyer lands on a hosted page for a session already moved to `processing`.

There is no alternative payload, either. Three of the five gateways (eSewa, ConnectIPS, NPS)
return `form_url` plus signed fields and no GET-able URL, so "send the gateway URL instead" is
not expressible. Sending the form action and its fields *would* be — and would hand the
merchant's own JavaScript a signed gateway payload on their origin, which is worse than the open
redirect §5.12 refuses.

---

## 6. Backend contract

| Call | Endpoint | Client | Notes |
|---|---|---|---|
| Session | `GET /api/payment/checkout-sessions/<id>/` | public | `{public_id, line_items, customer_id, seller_details, expires_at, completed_at, is_expired, return_url?}`. 404 ⇒ expired, paid or unknown, uniformly |
| Gateways | `GET /api/company/available-payment-methods/<company_id>/` | public | `company_id` is `seller_details.id` — the session carries no `company_id` of its own |
| NPS banks | `GET /api/company/nps-instruments/` | public | Lazy; only for bare `nps` |
| Pay | `POST /api/payment/checkout-sessions/<id>/pay/` | public, **no token** | One request pays every line. The id in the URL is the whole credential |

**One id, two routes.** The id on the block, the id in `/c/<id>`, the id in `/checkout/<id>` and
`public_id` on the session response are all the same value. This is what makes the fallback in
§5.12 free — the frame hands the host `<origin>/checkout/<sessionId>` for the session it is
already holding, with no conversion call and no second identifier. Anything that breaks the
equality breaks both `suqo:redirect` and `data-suqo-flow` at once, and silently: the buyer
lands on a 404 that looks exactly like an expired link.

Invariants the frontend assumes, and which belong in the backend's own ticket text because the
id is semi-public by nature — it sits in the merchant's DOM:

- No PII in the payload. `customer_id` is a presence signal, not a record.
- Single-use, short TTL.
- Atomic `open → processing`, so two tabs cannot both pay.
- A uniform 404 for expired, paid and unknown — no field distinguishing them, so nothing can be
  enumerated.

### Still open

**Does a `processing` state exist, and is it exposed on the session GET?** The response carries
`completed_at` and `is_expired` and nothing between them, so "attempt started, never completed"
is indistinguishable from "still payable". Both `/c/<id>` and `/checkout/<id>` therefore render
a mid-payment session as fully payable.

It matters most on the redirect path, which by design hands a buyer to the hosted page having
*not* touched the session — but the same window exists whenever a buyer closes the gateway
after `pay` succeeded and tries again. The worst case is a double charge.

Two asks, in order: expose a `status` field; and say whether `POST .../pay/` is re-callable
while `processing` — either re-issuing the un-consumed attempt idempotently, or voiding it and
starting a new one. The frontend currently has no way to tell which it does.

---

## 7. Reimplementation checklist

Building either half again, in order:

**Frame**
1. Route at `/c/[id]`, no auth, exempt from any deployment route gate.
2. Post `suqo:alive` from the **layout**, not the block — from inside the block it fires at the
   same moment as `ready`, collapsing two deadlines into one.
3. **Do not build a boot gate.** One public GET on the session is the whole of what the frame
   needs; there is no inbound message to wait for, buffer or replay. If a future change makes
   the frame wait on the host for anything, it has reintroduced the deadlock this design
   removed.
4. Guard the session before rendering anything payable: `completed_at`, then the clock *and*
   `is_expired`, then `customer_id`, then the seller id. Each is a distinct `suqo:unavailable`
   reason even where the buyer-facing sentence is the same.
5. Post `suqo:ready` on **every** settled state, errors included, or the host's ready deadline
   paints a failure panel over a message that already rendered.
6. Session GET → total from the line items → gateways by `seller_details.id`.
7. `ResizeObserver` on the card only (§5.4).
8. Pay: open the window first (§5.1), and if there is no window post `suqo:redirect` and stop
   **before** calling pay (§5.13). Otherwise POST, then hand off; guard URLs to http(s).
9. Return page: cancellation short-circuit (§5.6) → verify → `publishResult` on all three
   paths → skip `return_url` when `isGatewayWindow()`.
10. `settled` renders a spinner and no verdict.
11. Never post to the host's window. The protocol is one-directional (§3).

**Host**
1. ES5, one IIFE, one global, all styles inline — it runs on whatever the merchant's site is.
2. Resolve the element: `mount()` → `configure({elementId})` → `data-suqo-element-id` →
   `[data-suqo-checkout-block]` → `#suqo-checkout-block`.
3. `DOMContentLoaded` + `MutationObserver`, so SPA-rendered blocks mount with no extra step.
4. Per-container session state — a page may carry several blocks.
5. One `message` listener; route by `contentWindow` except `suqo:result` (§3). Guard every
   read of `session.iframe` — a redirect-flow block is a registered block with no frame, and
   one on the page otherwise breaks routing for every other block.
6. Resolve callbacks **when they fire**, not at mount, so `configure()` after an auto-mount
   still works.
7. Latch the result per attempt; release on `suqo:gateway` (§5.7).
8. Close the gateway window on `pagehide` — `pagehide`, never `unload`, which
   Permissions-Policy blocks in current Chrome.

---

## 8. Supported surfaces

The right-hand column is the point of the table: it is what the merchant's integration has to
be built against, and it is not the same everywhere.

| Surface | Path taken | Result reaches the merchant via |
|---|---|---|
| Desktop browser | iframe + popup | `onSuccess` / `onFailure` |
| Mobile browser | iframe + popup | `onSuccess` / `onFailure` |
| WebView with multiple windows enabled | iframe + popup | `onSuccess` / `onFailure` |
| WebView without it; in-app browsers (Instagram, Facebook, LINE) | iframe → `suqo:redirect` → hosted `/checkout/<id>` | **`return_url` + webhook only** |
| Merchant opts out — `data-suqo-flow="redirect"` | anchor → hosted `/checkout/<id>` | **`return_url` + webhook only** |
| Native host with a bridge (`@suqo/react-native`, or any `window.SuqoWebView`) | WebView, same-window gateway navigation | bridge `suqo:result` |

Two rows never reach a callback, and a merchant cannot tell in advance which row a given buyer
will land on. So:

> **A `return_url` on the session is mandatory for any merchant whose page might be shown
> inside an app.** Fulfilment is the webhook, always. `onSuccess` is a convenience for the
> desktop case and nothing more.

---

## 9. Known limits

Documented, not solved.

- **No `frame-ancestors` allowlist.** Framing works precisely because no such header exists,
  which also means any site can frame the checkout. `parentOrigin` narrows who the frame's
  messages are addressed to but enforces nothing. **This should block publicising the embed.**
- **Opening the frame URL directly renders a working block**, and that is intended rather than
  a hole to close. `/c/<sessionId>` is exactly as reachable as the hosted
  `/checkout/<sessionId>`, on the same grounds: the session id *is* the credential, it is
  single-use, short-TTL, and carries no PII beyond a `customer_id` presence flag. Do not file
  this as a regression — the mitigations are the session's, and there is no handshake left to
  hide behind.
- **Third-party cookies.** Anything the frame stores runs in a third-party context, so Safari —
  and Chrome after phase-out — can break it.
- **The host script has no test suite in this repo.** The frame half is covered by Vitest in
  `frontend` (`tests/lib/embed/`, `tests/components/embed/`, `tests/app/c/`). The loader is
  verified by a jsdom harness that is not checked in, because this project deliberately carries
  no dependencies. `npm run check` only proves the file parses.
