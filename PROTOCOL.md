# SUQO embedded checkout — protocol and implementation spec

This is the contract between the **host** (`public/suqo-checkout.js`, on a merchant's page) and
the **frame** (the SUQO app's `/external-checkout/[id]` route). It documents what exists today
and *why*, in enough detail to reimplement either half from scratch.

Read this before changing either side. The two halves ship from different repos, so a change to
one that is not reflected in the other fails silently — usually as a blank block or a payment
whose outcome never reaches the merchant.

- Host: `js-checkout/public/suqo-checkout.js` (this repo — the source of truth)
- Frame: `frontend/src/lib/external-checkout/`, `frontend/src/components/external-checkout/`,
  `frontend/src/app/external-checkout/[id]/`
- The served copy of the host is `frontend/public/suqo-checkout.js`; see **Sync** in README.md.

---

## 1. The concept

A merchant already has a product page, a customer record, and a subscription created through
SUQO's external API. What they lack is a way to take the payment without sending the buyer to
someone else's site.

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
├─ <script src="https://test.suqo.ai/suqo-checkout.js">
│  └─ on DOMContentLoaded (+ MutationObserver for later DOM):
│     find the container → read data-suqo-* off it → mount an iframe
│
└─ <div id="my-payment-area"
        data-suqo-subscription-id="<uuid>"
        data-fullname / data-email / data-address / data-phone>
   │
   └─ iframe  src = <origin>/external-checkout/<uuid>#parentOrigin=<encoded merchant origin>
      │
      │  ── frame boot ─────────────────────────────────────────────
      ├─ module import  → install the buffered 'suqo:init' listener   (§5.11)
      ├─ layout mounts  → postToHost('suqo:alive')     ── host clears its load deadline
      │                                                 ── host replies 'suqo:init' {customer}
      │
      │  ▼ EVERYTHING BELOW WAITS FOR 'suqo:init'. No handshake ⇒ blank, zero calls.
      │
      ├─ POST /api/subscriber/subscription-payment-phone/renew/  {subscription_id}
      │     → { tokens.access, product_id, plan_id, plan_billing_period_id }
      │     → tokenManager.setGuestToken(access)         (a scoped, short-lived credential)
      ├─ GET  /api/subscriptions/products/<product_id>/    (public)
      ├─ resolve the billing period, compute the price
      ├─ GET  /api/company/available-payment-methods/<company_id>/  (public)
      ├─ ResizeObserver on the card → postToHost('suqo:resize', {height})  ── host sets iframe height
      └─ block rendered  → postToHost('suqo:ready')     ── host removes its spinner, fires onReady
         │
         │  ── buyer taps Pay ────────────────────────────────────────
         ├─ openGatewayWindow()          ← SYNCHRONOUS, before any await (see §5.1)
         ├─ postToHost('suqo:gateway')
         ├─ POST /api/subscriber/subscription/  { payment_method, product_id, plan_id,
         │        billing_cycle_id, success_url, failure_url, full_name, email, address,
         │        phone?, instrument_code?, payment_mode, is_same_as_billing:true,
         │        is_different_billing:false }
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
                     ├─ BroadcastChannel('suqo:external-checkout-result')
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
| `suqo:alive` | — | The document loaded and is running scripts | Clear the load deadline; arm the ready deadline; send `suqo:init` |
| `suqo:ready` | — | The block is on screen | Remove the spinner; drop `min-height`; fire `onReady`; re-send `suqo:init` |
| `suqo:resize` | `{height}` | Content height in px | Set `iframe.style.height` (plus chrome, see §5.4) |
| `suqo:gateway` | — | A gateway window was just opened | Remember it, for `pagehide` cleanup; clear the result latch |
| `suqo:result` | `{status, params, message?}` | The payment settled | Fire `onSuccess`/`onFailure` **exactly once** |
| `suqo:unavailable` | `{reason}` | Reserved; not currently emitted | — |

`status` is `'success' | 'failed' | 'cancelled'`. See §5.6 for why `cancelled` is separate.

### host → frame

| `type` | Payload | Meaning |
|---|---|---|
| `suqo:init` | `{customer: {full_name, email, address, phone}}` | The buyer's details |

**One message, one direction, and it is the whole handshake — and the frame will not boot
without it.** No token exchange, no product fetch, no gateway list, nothing rendered until it
arrives. Opened directly, or framed by anything that does not send it, the page stays blank and
the backend never hears about the visit.

Sent on `suqo:alive` and again on `suqo:ready` — the frame acknowledges nothing, and a listener
that re-attached between the two would otherwise miss the first copy. A duplicate simply
overwrites, so re-sending is free.

**A host implementation that does not send `suqo:init` produces a permanently blank frame.**
That is the intended failure, not a bug — but it is why `sync:check` matters: a merchant serving
a stale loader against a newer app gets a dead block. The frame logs a console warning after 5s
naming the cause, and the host's own ready deadline then draws its failure panel.

This is a **boot contract, not access control.** Any page can frame the URL and post the same
message, so the handshake cannot authenticate a merchant. What it buys is a single entry path
and no work — in particular no minted payment credential — from a stray direct hit. Restricting
*who* may embed still needs the `frame-ancestors` allowlist in §8.

### Targeting and validation

| | Target origin | Validation on receipt |
|---|---|---|
| frame → host | `getHostOrigin()` from `#parentOrigin`, else `'*'` | Host checks `event.origin === session.origin`, and `event.source === iframe.contentWindow` for **everything except `suqo:result`** |
| host → frame | `session.origin` (never `'*'` — it carries personal data) | Frame checks `event.source === window.parent` and, when `#parentOrigin` is present, `event.origin` |
| return page → frame/host | `'*'` — **deliberately**, see §5.3 | Origin-checked on receipt |

`suqo:result` is the one message not matched by `event.source`: it legitimately arrives from the
**gateway window**, not the frame. Pinning the source would drop it. The host instead routes it
to whichever session has a gateway open.

---

## 4. Frame-side implementation inventory

### `src/lib/external-checkout/embed.ts` — the bridge

| Export | Purpose |
|---|---|
| `GATEWAY_WINDOW_NAME = 'suqo_gateway'` | Both sides must agree; the host takes a handle **by name** |
| `RESULT_CHANNEL = 'suqo:external-checkout-result'` | Same-origin fallback channel |
| `ResultStatus` | `'success' \| 'failed' \| 'cancelled'` |
| `ResultParams` | `Record<string, string>` — the gateway's params, verbatim |
| `ResultMessage` | The `suqo:result` envelope |
| `EmbedCustomer`, `REQUIRED_CUSTOMER_FIELDS` | Buyer details; `['full_name','email','address']` |
| `isFramed()` / `useIsFramed()` | `window.self !== window.top`; throwing cross-origin ⇒ framed ⇒ `true` |
| `getHostOrigin()` | Parses `#parentOrigin`, http(s) only, else `null` |
| `postToHost(msg)` | No-op when not framed |
| `openGatewayWindow()` | `window.open('', GATEWAY_WINDOW_NAME, 'popup=yes,…')` |
| `navigateGatewayWindow(win, url)` | |
| `watchGatewayWindow(win, onClosed)` | Polls `win.closed` every 700ms; returns an unsubscribe |
| `subscribeToCustomer(handler)` | Listens for `suqo:init`; trims and caps each field at 512 chars |
| `subscribeToResult(handler)` | Both delivery paths; fires **at most once** |
| `publishResult(status, params, message?)` | Called from the return page; fires all three paths |
| `isGatewayWindow()` | `window.name === GATEWAY_WINDOW_NAME`, else `!!window.opener` |
| `isCancelledReturn(params)` | `status` is `cancelled`/`canceled`, case-insensitive |
| `readBackendMessage(data)` | `message`/`detail`/`error` off a 2xx body; `undefined` if none |
| `collectReturnParams(params)` | `Object.fromEntries` — no renaming, no filtering |

### `src/lib/external-checkout/gateway.ts` — the hand-off

Deliberately **separate from `src/lib/utils/payment.ts`**. That module navigates *this* window,
which is right for the hosted checkout and wrong here. Do not merge them behind a flag.

| Export | Purpose |
|---|---|
| `returnUrlOnThisOrigin(configured, fallbackPath)` | Keeps the configured **path**, replaces the origin with `window.location.origin` (§5.5) |
| `GatewayHandoff` | `{sent:true}` \| `{sent:false, reason:'no-gateway'\|'no-window'\|'unsafe-url'}` |
| `sendToGateway(gateway, response, extraFields, win)` | Form-POST (`esewa`, `connectips`, `nps`) targeted **by window name**; or navigate (`khalti`, `suqo_uat`) |

Both paths run every URL through an http(s)-only guard, so a `javascript:` or `data:` value from
the backend can never reach a navigation sink.

### Components and route

| File | Responsibility |
|---|---|
| `app/external-checkout/[id]/layout.tsx` | Wraps in the shell; `robots: noindex` |
| `components/external-checkout/ExternalCheckoutShell.tsx` | Posts `suqo:alive`; `ResizeObserver` → `suqo:resize`; sets `data-suqo-embed` on `<html>`/`<body>` for the transparent, non-scrolling ground |
| `app/external-checkout/[id]/page.tsx` | Token exchange → product → period → price; subscribes to `suqo:init`; posts `suqo:ready` |
| `components/external-checkout/ExternalPaymentBlock.tsx` | Gateway list, NPS picker, T&C, Pay; phases `choosing → creating → awaiting → settled` |
| `components/external-checkout/PaymentMethodOption.tsx` | One gateway row, with the NPS bank picker nested |
| `components/external-checkout/GatewayWaiting.tsx` | The `awaiting` panel; focuses the gateway window |
| `components/external-checkout/PaymentMethodsSkeleton.tsx` | Loading placeholder |

**The `settled` phase renders a spinner and nothing else.** The block announces no outcome: it
sits inside the merchant's layout, does not know what happens next, and any verdict it drew
would compete with theirs. Both callbacks are therefore effectively required — a merchant who
handles neither leaves the buyer on that spinner.

---

## 5. Invariants — each of these was a bug first

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

### 5.8 Two load deadlines, armed by real signals

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

### 5.9 Match the billing period by `public_id`, never the plan by `plan_id`

`renew` returns `plan_id` as the string `"257"`; the product endpoint returns `112` as a
**number**. `Plan.id` is declared `string` in `src/types/product.ts`, so TypeScript waves the
mismatch through and the strict compare silently fails. Resolve the period by its `public_id`
across all the product's *visible* cycles, then derive the plan from that match.

### 5.10 `window.name` survives the round trip; `window.opener` may not

Measured, because the reasonable guess is the opposite. Chrome does clear `window.name` on
cross-origin navigation, but by the time the buyer is back on the checkout origin it reads
correctly again. `window.opener` was observed **severed** after a browser-initiated navigation.
So `isGatewayWindow()` leads with the name and keeps the opener as a fallback only.

### 5.11 Buffer the handshake at module scope, never in a component

The host answers `suqo:alive` immediately, and the frame does not boot without that answer. A
listener attached even slightly later misses the reply, and the frame then waits forever on a
message that already came and went — a blank block, permanently.

So the listener is installed at **import time** and the payload is kept; whoever subscribes
later is replayed it. Effect ordering (children mount before parents) happens to deliver the
same result today and is **not good enough**: it makes React's scheduling decide whether the
checkout works, and it silently stops being true if the component tree is rearranged.

Verified under a 6× CPU throttle, where the reply lands well before React mounts.

Two related rules:

- Gate on the handshake having **arrived**, not on its fields being complete. An
  arrived-but-empty init boots and lets the missing-details error name the fields at Pay; only
  an absent handshake stays blank. `hasHandshake()` is that distinction.
- Keep `suqo:alive` **outside** the gate — it is what prompts the reply — and do not post
  `suqo:ready` while awaiting, or the host's ready deadline never trips and its failure panel
  never appears.

---

## 6. Backend contract

| Call | Endpoint | Client | Notes |
|---|---|---|---|
| Token exchange | `POST /api/subscriber/subscription-payment-phone/renew/` | public | `{subscription_id}` → `{tokens.access, product_id, plan_id, plan_billing_period_id}`. 400/404 ⇒ invalid link. Rejects a non-UUID id, and a one-time product that is already paid |
| Product | `GET /api/subscriptions/products/<id>/` | public | |
| Gateways | `GET /api/company/available-payment-methods/<company_id>/` | public | `company_id` is `product.user.user_id` |
| NPS banks | `GET /api/company/nps-instruments/` | public | Lazy; only for bare `nps` |
| Create payment | `POST /api/subscriber/subscription/` | guest token | Body in §2. **Requires `full_name`, `email`, `address`** |
| Verify | `POST /api/subscriber/subscription-payment-verify/` | public | Body from `buildVerificationPayload` |

### The one thing worth changing on the backend

`POST /api/subscriber/subscription/` requires `full_name`, `email` and `address` from the
client — **even though the subscription already exists** and the merchant's backend created it
with exactly those details. That single requirement is the entire reason the `suqo:init`
customer channel exists.

If the backend read them off the subscription instead, `suqo:init` could be deleted, the
handshake would carry no personal data, and a React Native WebView integration would become
"open a URL" rather than needing an injection shim. This is the highest-value simplification
available to this design.

---

## 7. Reimplementation checklist

Building either half again, in order:

**Frame**
1. Route at `/external-checkout/[id]`, no auth, exempt from any deployment route gate.
2. Post `suqo:alive` from the **layout**, not the block — from inside the block it fires at the
   same moment as `ready`, collapsing the two deadlines into one.
3. **Buffer `suqo:init` at module scope, not in a component.** The host answers `alive`
   immediately, so a listener attached even slightly later misses the reply and the frame then
   waits forever on a message that already came and went. Install one listener at import time,
   keep the payload, and replay it to whoever subscribes afterwards. Relying on effect ordering
   (children mount before parents) happens to work and is not good enough — it makes React's
   scheduling decide whether the checkout functions.
4. Gate the boot on the handshake having *arrived*, not on its fields being complete. An
   arrived-but-empty init must boot and let the missing-details error name the fields at Pay;
   only a missing handshake stays blank. `hasHandshake()` is that distinction.
5. Keep `suqo:alive` **outside** the gate — it is what prompts the reply. And do not post
   `suqo:ready` while still awaiting, or the host's ready deadline never trips and its failure
   panel never appears.
6. Token exchange → product → period by `public_id` (§5.9) → price → gateways.
7. `ResizeObserver` on the card only (§5.4).
8. Pay: open the window first (§5.1), then POST, then hand off; guard URLs to http(s).
9. Return page: cancellation short-circuit (§5.6) → verify → `publishResult` on all three
   paths → skip `return_url` when `isGatewayWindow()`.
10. `settled` renders a spinner and no verdict.

**Host**
1. ES5, one IIFE, one global, all styles inline — it runs on whatever the merchant's site is.
2. Resolve the element: `mount()` → `configure({elementId})` → `data-suqo-element-id` →
   `[data-suqo-checkout-block]` → `#suqo-checkout-block`.
3. `DOMContentLoaded` + `MutationObserver`, so SPA-rendered blocks mount with no extra step.
4. Per-container session state — a page may carry several blocks.
5. One `message` listener; route by `contentWindow` except `suqo:result` (§3).
6. Resolve callbacks **when they fire**, not at mount, so `configure()` after an auto-mount
   still works.
7. Latch the result per attempt; release on `suqo:gateway` (§5.7).
8. Close the gateway window on `pagehide` — `pagehide`, never `unload`, which
   Permissions-Policy blocks in current Chrome.

---

## 8. Known limits

Documented, not solved.

- **Third-party cookies.** The token exchange runs in a third-party frame, so Safari — and
  Chrome after phase-out — can break it.
- **No `frame-ancestors` allowlist.** Framing works precisely because no such header exists,
  which also means any site can frame the checkout. `parentOrigin` narrows who the frame's
  messages are addressed to but enforces nothing. **This should block publicising the embed.**
- ~~Opening the frame URL directly renders a working page.~~ **Fixed.** The frame is inert
  without `suqo:init`: blank, zero backend calls, no token minted. `/pay/<subscription_id>` is
  the route for a shareable standalone payment link.
- **`Plan.id` is typed `string` but the API returns a number** (§5.9). Worked around locally
  rather than corrected, because the shared type ripples into the seller dashboard.
- **No automated tests yet.** The whole surface has been verified by driving a real browser
  against the real backend and the real UAT gateway; nothing is covered by the Vitest suite.
