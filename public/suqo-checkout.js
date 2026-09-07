/*!
 * SUQO embedded checkout — drop-in loader.
 *
 *   <script src="https://test.suqo.ai/suqo-checkout.js"></script>
 *   <div id="suqo-checkout-block" data-suqo-subscription-id="SUB123"></div>
 *
 * Renders the SUQO payment block *inline*, where the merchant put the div. No overlay, no
 * modal, no page takeover: it is a payment element in their layout, like any other field.
 *
 * The subscription is created by the merchant's own backend through the external API; this
 * only collects the payment for it. So the block shows what is actually left to decide —
 * which gateway, and consent — and nothing else.
 *
 * Source of truth: the `js-checkout` project. `frontend/public/suqo-checkout.js` is a synced
 * copy — that is the one actually served. Edit here, then run `npm run sync`.
 *
 * ES5 on purpose: this runs on whatever the merchant's site happens to be, which may be an
 * old template with no transpiler in front of it. No const/let, no arrow functions, no
 * template literals.
 *
 * Every style is set inline on the elements this creates. A host page's CSS must not be able
 * to restyle the block's chrome, and nothing here may leak out — so there is no stylesheet,
 * no class names, and no <style> injection.
 */
;(function () {
  'use strict'

  if (window.SuqoCheckout) return

  /** Last-resort base URL, used when the origin cannot be derived any other way. */
  var FALLBACK_ORIGIN = 'https://test.suqo.ai'

  /** The container id looked for when the merchant names none. */
  var DEFAULT_CONTAINER_ID = 'suqo-checkout-block'

  /** Marks a container without relying on an id, so a page can carry more than one. */
  var CONTAINER_ATTR = 'data-suqo-checkout-block'

  /**
   * Shared with the app: src/lib/external-checkout/embed.ts opens the gateway window under
   * this exact name, or the host cannot take a handle on it to clean up.
   */
  var GATEWAY_WINDOW_NAME = 'suqo_gateway'

  /**
   * Envelope tag on every message, so unrelated postMessage traffic on the host page
   * (analytics, chat widgets, other embeds) is ignored cheaply.
   */
  var MESSAGE_SOURCE = 'suqo-checkout'

  var MSG = {
    alive: 'suqo:alive',
    ready: 'suqo:ready',
    resize: 'suqo:resize',
    gateway: 'suqo:gateway',
    result: 'suqo:result',
  }

  /**
   * Three deadlines, each for a distinct failure, and each armed by a real signal rather than
   * by guesswork about how long the previous stage "should" take.
   *
   *   LOAD  — nothing came back at all. Disarmed by the iframe's own `load` event, which
   *           fires cross-origin (with no detail, but it fires). This must not be a short
   *           timer: a cold Next compile or a serverless cold start legitimately takes over
   *           four seconds, and an earlier version of this file failed those as "blocked".
   *   ALIVE — a document came back but never ran our script: a CSP frame-ancestors block, an
   *           extension, or someone else's error page at that URL. Armed only once `load` has
   *           fired, so a slow round-trip can no longer trip it.
   *   READY — our script ran but the block never mounted. The frame is real and merely slow,
   *           so this is the most patient of the three.
   */
  var LOAD_DEADLINE_MS = 20000
  var ALIVE_DEADLINE_MS = 8000
  var READY_DEADLINE_MS = 25000

  /** Enough to hold the spinner without the block collapsing before the first resize. */
  var MIN_FRAME_HEIGHT = 320

  var defaults = {
    origin: null,
    /** Where the block renders. Set via configure({elementId}) or data-suqo-element-id. */
    elementId: null,
    onReady: null,
    onSuccess: null,
    onFailure: null,
  }

  // ───────────────────────── origin resolution ─────────────────────────

  function trimTrailingSlash(value) {
    // Leading/trailing whitespace too: these come from hand-typed HTML attributes, and a
    // stray space survives into the URL string even though the URL parser tolerates it.
    return String(value).replace(/^\s+|\s+$/g, '').replace(/\/+$/, '')
  }

  /** The <script> tag that loaded this file, located by filename when currentScript is null. */
  function ownScriptTag() {
    var current = document.currentScript
    if (current && current.src) return current

    var tags = document.getElementsByTagName('script')
    for (var i = tags.length - 1; i >= 0; i--) {
      if (tags[i].src && tags[i].src.indexOf('suqo-checkout.js') !== -1) return tags[i]
    }
    return null
  }

  // Captured at parse time: document.currentScript is null inside any later callback.
  var scriptTag = ownScriptTag()

  function scriptOrigin() {
    if (!scriptTag || !scriptTag.src) return null
    try {
      return new URL(scriptTag.src, window.location.href).origin
    } catch (e) {
      return null
    }
  }

  /**
   * Resolution order, most specific first:
   *   per-call origin  →  data-suqo-origin on the container  →  configure()/
   *   window.SUQO_CHECKOUT_ORIGIN  →  origin the script was served from  →  FALLBACK_ORIGIN
   */
  function resolveOrigin(perCall) {
    var candidate =
      perCall ||
      defaults.origin ||
      window.SUQO_CHECKOUT_ORIGIN ||
      scriptOrigin() ||
      FALLBACK_ORIGIN
    return trimTrailingSlash(candidate)
  }

  /**
   * Builds the frame URL.
   *
   * The host origin rides in the **hash**, never the query string. NPS appends its own return
   * params with a literal `?` instead of `&`, so anything added to a query string that reaches
   * a gateway comes back mangled and swallows the gateway's own transaction id. A hash never
   * leaves the browser.
   */
  function buildUrl(opts) {
    var base = resolveOrigin(opts.origin)
    var url = opts.url || null

    if (!url) {
      var id = opts.subscriptionId || opts.payId || opts.renewId
      if (!id) return null
      url = base + '/external-checkout/' + encodeURIComponent(id)
    }

    return url + '#parentOrigin=' + encodeURIComponent(window.location.origin)
  }

  // ───────────────────────── DOM helpers ─────────────────────────

  function applyStyle(el, style) {
    for (var key in style) {
      if (Object.prototype.hasOwnProperty.call(style, key)) el.style[key] = style[key]
    }
    return el
  }

  function make(tag, style) {
    return applyStyle(document.createElement(tag), style || {})
  }

  /** First of: explicit option, prefixed attribute, bare attribute. */
  function attr(el, prefixed, bare, override) {
    var value = override || el.getAttribute(prefixed) || el.getAttribute(bare)
    if (!value) return undefined
    value = String(value).replace(/^\s+|\s+$/g, '')
    return value || undefined
  }

  function resolveElement(target) {
    if (!target) return null
    if (typeof target === 'string') return document.getElementById(target)
    return target.nodeType === 1 ? target : null
  }

  // ───────────────────────── chrome ─────────────────────────

  function buildSpinner() {
    var wrap = make('div', {
      position: 'absolute',
      inset: '0',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      zIndex: '1',
    })

    // Keyframes cannot be inlined, so the spin is driven by setInterval on a transform. That
    // avoids injecting a <style> tag into the host document.
    var dot = make('div', {
      width: '34px',
      height: '34px',
      border: '3px solid #e9e9e9',
      borderTopColor: '#635bff',
      borderRadius: '50%',
      boxSizing: 'border-box',
    })

    var angle = 0
    var timer = window.setInterval(function () {
      angle = (angle + 30) % 360
      dot.style.transform = 'rotate(' + angle + 'deg)'
    }, 80)

    wrap.appendChild(dot)

    return {
      el: wrap,
      stop: function () {
        window.clearInterval(timer)
      },
    }
  }

  function buildFailurePanel(url, reason) {
    var wrap = make('div', {
      position: 'absolute',
      inset: '0',
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      gap: '14px',
      padding: '32px 28px',
      textAlign: 'center',
      font: '400 15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif',
      color: '#425466',
      zIndex: '2',
    })

    var title = make('div', { font: '600 17px/1.3 inherit', color: '#0d062d' })
    title.textContent = "The payment form didn't load"

    var body = make('div', { maxWidth: '340px' })
    body.textContent = reason

    var link = make('a', {
      display: 'inline-block',
      marginTop: '4px',
      padding: '11px 20px',
      borderRadius: '10px',
      background: '#635bff',
      color: '#ffffff',
      font: '600 15px/1 inherit',
      textDecoration: 'none',
    })
    link.href = url
    link.target = '_blank'
    link.rel = 'noopener noreferrer'
    link.textContent = 'Open the payment page in a new tab'

    wrap.appendChild(title)
    wrap.appendChild(body)
    wrap.appendChild(link)
    return wrap
  }

  // ───────────────────────── sessions ─────────────────────────
  //
  // One entry per mounted container. A page may carry several blocks — two subscriptions on
  // one page is an ordinary thing for a merchant to want — so nothing here may live in a
  // module-level singleton.

  var sessions = []

  function sessionFor(container) {
    for (var i = 0; i < sessions.length; i++) {
      if (sessions[i].container === container) return sessions[i]
    }
    return null
  }

  function sessionForFrame(source) {
    for (var i = 0; i < sessions.length; i++) {
      if (sessions[i].iframe.contentWindow === source) return sessions[i]
    }
    return null
  }

  /**
   * The session a payment result belongs to.
   *
   * The result arrives from the gateway window, not from a frame, so it cannot be matched by
   * `event.source` the way every other message is. It is matched by which block actually has a
   * gateway open. With exactly one block on the page that is unambiguous either way.
   */
  function sessionAwaitingResult() {
    for (var i = 0; i < sessions.length; i++) {
      if (sessions[i].gatewayOpened && !sessions[i].resultHandled) return sessions[i]
    }
    return sessions.length === 1 ? sessions[0] : null
  }

  /**
   * Closes a gateway window that outlived its block.
   *
   * A payable window with nothing left to report back to is worse than no window: the buyer
   * can complete a payment that never reaches the merchant's page.
   *
   * The handle is taken by *name*, which is the only way the host can reach a window the frame
   * opened. Note this call reassigns that window's `opener` to the host — which is why the
   * return page posts with target '*' rather than naming an origin.
   */
  function closeGatewayWindow() {
    var anyOpen = false
    for (var i = 0; i < sessions.length; i++) {
      if (sessions[i].gatewayOpened) anyOpen = true
    }
    if (!anyOpen) return

    try {
      var handle = window.open('', GATEWAY_WINDOW_NAME)
      if (handle && !handle.closed) handle.close()
    } catch (e) {
      /* cross-origin or blocked — nothing we can do */
    }
  }

  // ───────────────────────── mount / unmount ─────────────────────────

  function mount(target, options, auto) {
    var container = resolveElement(target)
    if (!container) {
      console.warn('[SuqoCheckout] mount target not found:', target)
      return api
    }

    var opts = options || {}

    // Read from the element too, so the declarative and programmatic paths agree. Explicit
    // options win: a caller naming an id meant that id.
    var config = {
      url: opts.url || container.getAttribute('data-suqo-checkout') || undefined,
      subscriptionId:
        opts.subscriptionId ||
        container.getAttribute('data-suqo-subscription-id') ||
        undefined,
      // Kept as aliases: both were subscription ids all along, and both now resolve to the
      // same page.
      payId: opts.payId || container.getAttribute('data-suqo-pay-id') || undefined,
      renewId: opts.renewId || container.getAttribute('data-suqo-renew-id') || undefined,
      origin: opts.origin || container.getAttribute('data-suqo-origin') || undefined,
    }

    // Buyer details, read off the container so a merchant needs no JavaScript for them. The
    // `data-suqo-` prefixed spelling is preferred — it cannot collide with attributes the
    // host page already uses — but the bare spelling is accepted too, because it is the
    // shorter thing to write and the collision risk is the merchant's own to take.
    var customer = {
      full_name: attr(container, 'data-suqo-fullname', 'data-fullname', opts.fullName),
      email: attr(container, 'data-suqo-email', 'data-email', opts.email),
      address: attr(container, 'data-suqo-address', 'data-address', opts.address),
      phone: attr(container, 'data-suqo-phone', 'data-phone', opts.phone),
    }

    var url = buildUrl(config)
    if (!url) {
      // Silent on the discovery path: a container the merchant will drive with mount() later
      // is an ordinary state to find on the page, not a mistake worth a console warning on
      // every mutation batch. An explicit mount() with no id is a caller error, so it speaks.
      if (!auto) {
        console.warn(
          '[SuqoCheckout] no subscription id on the block. Add data-suqo-subscription-id, or ' +
            'pass subscriptionId to mount().'
        )
      }
      return api
    }

    var frameOrigin
    try {
      frameOrigin = new URL(url, window.location.href).origin
    } catch (e) {
      console.warn('[SuqoCheckout] unparseable checkout url:', url)
      return api
    }

    // Remounting the same container replaces what is there rather than stacking a second frame.
    if (sessionFor(container)) unmount(container)

    // `relative` so the spinner and the failure panel can be absolutely positioned over the
    // frame. Set explicitly because the host's own CSS decides everything else about this
    // element, and `static` is the default it most likely has.
    var previousPosition = container.style.position
    var previousMinHeight = container.style.minHeight
    if (!container.style.position) container.style.position = 'relative'
    // Holds the block open while the spinner runs. Dropped on `ready`, when the frame's own
    // reported height takes over.
    container.style.minHeight = MIN_FRAME_HEIGHT + 'px'

    var spinner = buildSpinner()

    var iframe = make('iframe', {
      display: 'block',
      width: '100%',
      height: MIN_FRAME_HEIGHT + 'px',
      border: '0',
      overflow: 'hidden',
      backgroundColor: 'transparent',
      colorScheme: 'normal',
      transition: 'height 180ms ease',
      boxSizing: 'border-box',
    })
    iframe.setAttribute('title', 'SUQO — Secure payment')
    // `'src'` rather than `*`: the payment permission is for the checkout's own origin, and
    // nothing it might frame in turn.
    iframe.setAttribute('allow', "payment 'src'")
    // Sandboxed, which the modal version could not be. The gateway never loads in this frame
    // — it always opens in a separate window — and `allow-popups-to-escape-sandbox` leaves
    // that window unsandboxed, so the banks' custom-protocol deeplinks still work.
    // `allow-forms` is required: the form-post gateways submit a real <form> into that window.
    iframe.setAttribute(
      'sandbox',
      'allow-scripts allow-forms allow-same-origin allow-popups allow-popups-to-escape-sandbox'
    )
    iframe.setAttribute('allowtransparency', 'true')
    iframe.setAttribute('scrolling', 'no')

    container.appendChild(spinner.el)
    container.appendChild(iframe)

    var session = {
      container: container,
      iframe: iframe,
      spinner: spinner,
      url: url,
      origin: frameOrigin,
      customer: customer,
      previousPosition: previousPosition,
      previousMinHeight: previousMinHeight,
      // Stored as given, without folding in the defaults. Resolution happens when a callback
      // actually fires (see `handler`), so a merchant whose configure() runs after the block
      // has already auto-mounted still gets called — otherwise script order silently decides
      // whether they hear about a payment.
      handlers: {
        onReady: opts.onReady,
        onSuccess: opts.onSuccess,
        onFailure: opts.onFailure,
      },
      loaded: false,
      alive: false,
      ready: false,
      failed: false,
      gatewayOpened: false,
      resultHandled: false,
      loadTimer: null,
      aliveTimer: null,
      readyTimer: null,
    }
    sessions.push(session)

    session.loadTimer = window.setTimeout(function () {
      failSession(
        session,
        'We could not reach the payment form. Please check your connection and try again.',
        'Nothing came back from ' +
          session.url +
          ' within ' +
          LOAD_DEADLINE_MS / 1000 +
          's — the request never even completed. Check the checkout origin is reachable ' +
          'and, in development, that the dev server is running on it.'
      )
    }, LOAD_DEADLINE_MS)

    // The round-trip finished. Whether it was *our* document is a separate question, and the
    // ALIVE deadline is what answers it — so only arm that one now, once slowness is ruled out.
    iframe.addEventListener('load', function () {
      if (!session.loaded) {
        session.loaded = true
        if (session.loadTimer) window.clearTimeout(session.loadTimer)
        session.loadTimer = null
        // `alive` can beat the load event — scripts run during parse — so only start waiting
        // if it has not already arrived.
        if (!session.alive) armAliveDeadline(session)
      }
    })

    iframe.src = url
    return api
  }

  function unmount(target) {
    var container = resolveElement(target)
    var session = container ? sessionFor(container) : null
    if (!session) return api

    clearTimers(session)
    session.spinner.stop()

    for (var i = 0; i < sessions.length; i++) {
      if (sessions[i] === session) {
        sessions.splice(i, 1)
        break
      }
    }

    if (session.iframe.parentNode) session.iframe.parentNode.removeChild(session.iframe)
    if (session.spinner.el.parentNode) {
      session.spinner.el.parentNode.removeChild(session.spinner.el)
    }
    if (session.panel && session.panel.parentNode) {
      session.panel.parentNode.removeChild(session.panel)
    }

    // Restore what the host had, rather than clearing: the page may set these itself.
    container.style.position = session.previousPosition
    container.style.minHeight = session.previousMinHeight

    return api
  }

  function clearTimers(session) {
    if (session.loadTimer) window.clearTimeout(session.loadTimer)
    if (session.aliveTimer) window.clearTimeout(session.aliveTimer)
    if (session.readyTimer) window.clearTimeout(session.readyTimer)
    session.loadTimer = null
    session.aliveTimer = null
    session.readyTimer = null
  }

  /**
   * A network error and a framing block are indistinguishable from out here: both give a
   * `load` event and a frame we cannot read across origins. They need opposite fixes, so
   * rather than guess in the console hint, ask the network which one it is.
   *
   * `no-cors` resolves opaquely whenever *something* answered, and rejects when nothing did.
   * That is exactly the distinction wanted, and an opaque response is all it needs to be.
   */
  function diagnoseAndFail(session) {
    var reported = false

    function report(hint) {
      if (reported) return
      reported = true
      failSession(
        session,
        'We could not load the payment form here. Your browser or this site may be blocking it.',
        hint
      )
    }

    var blocked =
      'The document at ' +
      session.url +
      ' answered but never identified itself within ' +
      ALIVE_DEADLINE_MS / 1000 +
      's. The origin is reachable, so the likely causes are a Content-Security-Policy ' +
      'frame-ancestors directive on it, an extension blocking frames, or that URL serving ' +
      'something other than the checkout. Open it directly to see what comes back.'

    var unreachable =
      'Nothing is answering at ' +
      session.origin +
      ' (connection refused). This is not a framing problem — the checkout origin is down or ' +
      'wrong. In development, check the dev server is running on that exact origin and port.'

    if (!window.fetch) {
      report(blocked)
      return
    }

    // Never let the probe be the reason the buyer sees nothing.
    var giveUp = window.setTimeout(function () {
      report(blocked)
    }, 3000)

    window
      .fetch(session.url, { mode: 'no-cors', cache: 'no-store' })
      .then(function () {
        window.clearTimeout(giveUp)
        report(blocked)
      })
      .catch(function () {
        window.clearTimeout(giveUp)
        report(unreachable)
      })
  }

  function armAliveDeadline(session) {
    session.aliveTimer = window.setTimeout(function () {
      diagnoseAndFail(session)
    }, ALIVE_DEADLINE_MS)
  }

  function removeSpinner(session) {
    session.spinner.stop()
    if (session.spinner.el.parentNode) {
      session.spinner.el.parentNode.removeChild(session.spinner.el)
    }
  }

  function failSession(session, reason, consoleHint) {
    if (session.failed || session.ready) return
    session.failed = true
    clearTimers(session)
    removeSpinner(session)

    session.panel = buildFailurePanel(session.url, reason)
    session.container.appendChild(session.panel)
    if (consoleHint) console.warn('[SuqoCheckout] ' + consoleHint)
  }

  /** The per-mount callback if there is one, else the configured default. */
  function handler(session, name) {
    var fn = session.handlers[name] || defaults[name]
    return typeof fn === 'function' ? fn : null
  }

  function sendCustomer(session) {
    var frame = session.iframe.contentWindow
    if (!frame) return
    try {
      frame.postMessage(
        { source: MESSAGE_SOURCE, type: 'suqo:init', customer: session.customer },
        session.origin
      )
    } catch (e) {
      /* frame went away mid-flight */
    }
  }

  // ───────────────────────── messages ─────────────────────────

  window.addEventListener('message', function (event) {
    var data = event.data
    if (!data || typeof data !== 'object') return
    if (data.source !== MESSAGE_SOURCE) return

    // The result is the one message that does not come from a frame — it is posted by the
    // gateway window — so it is routed by which block is waiting, not by event.source.
    var session =
      data.type === MSG.result ? sessionAwaitingResult() : sessionForFrame(event.source)
    if (!session) return
    if (event.origin !== session.origin) return

    switch (data.type) {
      case MSG.alive:
        if (session.alive) return
        session.alive = true
        // Either deadline may still be outstanding: `alive` can arrive before the load event.
        if (session.loadTimer) window.clearTimeout(session.loadTimer)
        if (session.aliveTimer) window.clearTimeout(session.aliveTimer)
        session.loadTimer = null
        session.aliveTimer = null

        // The frame is listening now, so hand over the buyer details. Targeted at the frame's
        // own origin rather than '*': this is the one message that carries personal data, and
        // it must not be readable by anything else that happens to be framed here.
        sendCustomer(session)
        // The frame is real, just not mounted yet — extend the budget.
        session.readyTimer = window.setTimeout(function () {
          failSession(
            session,
            'The payment form is taking longer than expected. You can continue in a new tab.',
            'Checkout loaded but never became ready within ' +
              READY_DEADLINE_MS / 1000 +
              's. The page is reachable, so this is slowness rather than a framing block.'
          )
        }, READY_DEADLINE_MS)
        break

      case MSG.ready:
        session.ready = true
        // Sent again, deliberately. The frame acknowledges nothing, and a listener that
        // re-attached between `alive` and `ready` would otherwise have missed the first copy.
        // The frame just overwrites what it holds, so a duplicate costs nothing.
        sendCustomer(session)
        clearTimers(session)
        removeSpinner(session)
        session.container.style.minHeight = session.previousMinHeight
        var onReady = handler(session, 'onReady')
        if (onReady) onReady()
        break

      case MSG.resize:
        var height = Number(data.height)
        if (!height || isNaN(height)) return
        // The frame reports the height of its *content*, but `style.height` sets the border
        // box. A host stylesheet can put a border on the iframe — and with `!important` it
        // beats the inline `border: 0` set at mount — which would then eat that much content
        // and leave a scrollbar inside. Add whatever chrome the element actually has.
        var chrome = session.iframe.offsetHeight - session.iframe.clientHeight
        session.iframe.style.height = height + (chrome > 0 ? chrome : 0) + 'px'
        break

      case MSG.gateway:
        // Remember a window exists, so it can be closed if this page goes away.
        session.gatewayOpened = true
        // A fresh attempt: whatever the previous one resolved to is spent, so the next
        // result is a new one and must be delivered.
        session.resultHandled = false
        break

      case MSG.result:
        // The result deliberately travels more than one path — a same-origin channel from the
        // return page, plus a post to the opener and to the opener's parent — because any
        // single one can be severed. Arriving twice is expected; the merchant's onSuccess
        // firing twice is not. Charging or fulfilling twice is the worst bug available here.
        if (session.resultHandled) return
        session.gatewayOpened = false
        // Always latched, including for a cancellation. The result arrives by more than one
        // path on purpose, so a second copy is expected and must not reach the merchant —
        // firing their handler twice for one payment is the worst bug available here. A retry
        // is unlatched by the new gateway window instead (see MSG.gateway), which is a real
        // second attempt rather than a duplicate of the first.
        session.resultHandled = true

        var params = data.params || {}
        // The backend's own wording about this payment, when it sent any. Passed separately
        // from `params` rather than folded into it: params are the gateway's, verbatim, and
        // mixing our own keys into them would break the merchant's reconciliation.
        var message = typeof data.message === 'string' ? data.message : undefined

        if (data.status === 'success') {
          // Params are passed through exactly as the gateway returned them. Every gateway
          // names its ids differently and the merchant reconciles against what their own
          // backend knows — normalising here would throw away the only field they can match on.
          var onSuccess = handler(session, 'onSuccess')
          if (onSuccess) onSuccess(params, message)
        } else {
          // `status` distinguishes 'cancelled' from 'failed', and the merchant needs it to:
          // a buyer who backed out should be offered the basket again, whereas a rejected
          // payment wants looking into. Collapsing the two loses that.
          var onFailure = handler(session, 'onFailure')
          if (onFailure) onFailure(data.status, params, message)
        }
        break
    }
  })

  // pagehide, not unload: unload is blocked by Permissions-Policy in current Chrome and would
  // never fire.
  window.addEventListener('pagehide', closeGatewayWindow)

  // ───────────────────────── discovery ─────────────────────────

  /**
   * The id the block renders into. Most specific first:
   *   configure({elementId})  →  data-suqo-element-id on the script tag  →  the default.
   *
   * The default exists only so the zero-config case works; a merchant naming their own element
   * is the expected path, since a fixed id cannot be assumed free on someone else's page.
   */
  function containerId() {
    return (
      defaults.elementId ||
      (scriptTag &&
        (scriptTag.getAttribute('data-suqo-element-id') ||
          scriptTag.getAttribute('data-suqo-container'))) ||
      DEFAULT_CONTAINER_ID
    )
  }

  function isContainer(node) {
    if (!node || node.nodeType !== 1) return false
    return node.hasAttribute(CONTAINER_ATTR) || node.id === containerId()
  }

  function mountContainer(el) {
    if (el && !sessionFor(el)) mount(el, {}, true)
  }

  /** Mounts `root` itself and any marked container inside it. */
  function mountWithin(root) {
    if (isContainer(root)) mountContainer(root)
    if (!root.querySelectorAll) return

    var marked = root.querySelectorAll('[' + CONTAINER_ATTR + ']')
    for (var i = 0; i < marked.length; i++) mountContainer(marked[i])
  }

  function discover() {
    // getElementById is a hash lookup rather than a tree walk, so this is cheap enough to
    // repeat on every mutation batch — which is what makes the named-container path work on
    // an SPA that renders the block after this script runs.
    mountContainer(document.getElementById(containerId()))
    mountWithin(document)
  }

  // Delegated from the document rather than bound once, so blocks rendered after this script
  // runs (SPA views, lazy sections, CMS widgets) work with no re-initialisation step.
  function watchForContainers() {
    if (typeof MutationObserver === 'undefined') return

    new MutationObserver(function (records) {
      var sawElement = false

      for (var i = 0; i < records.length; i++) {
        var added = records[i].addedNodes
        for (var j = 0; j < added.length; j++) {
          if (added[j].nodeType === 1) {
            mountWithin(added[j])
            sawElement = true
          }
        }
      }

      // Once per batch, not once per node: the id lookup is document-wide, and a busy SPA
      // can add hundreds of nodes in a single record set.
      if (sawElement) mountContainer(document.getElementById(containerId()))
    }).observe(document.documentElement, { childList: true, subtree: true })
  }

  // ───────────────────────── public API ─────────────────────────

  var api = {
    mount: mount,
    unmount: unmount,
    configure: function (options) {
      if (!options) return api
      if (options.origin) defaults.origin = trimTrailingSlash(options.origin)
      // `container` is accepted as an alias so an earlier integration keeps working.
      var el = options.elementId || options.container
      if (el) defaults.elementId = String(el).replace(/^#/, '')
      if (options.onReady) defaults.onReady = options.onReady
      if (options.onSuccess) defaults.onSuccess = options.onSuccess
      if (options.onFailure) defaults.onFailure = options.onFailure
      // A merchant who configures after the block is already in the DOM still gets it mounted.
      discover()
      return api
    },
  }

  Object.defineProperty(api, 'origin', {
    get: function () {
      return resolveOrigin(null)
    },
  })

  window.SuqoCheckout = api

  // Last: `mount` returns `api`, so nothing may mount before it exists.
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () {
      discover()
      watchForContainers()
    })
  } else {
    discover()
    watchForContainers()
  }
})()
