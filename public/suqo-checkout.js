/*!
 * SUQO embedded checkout — drop-in loader.
 *
 *   <script src="https://test.suqo.ai/suqo-checkout.js"></script>
 *   <div id="suqo-checkout-block" data-suqo-checkout-session-id="cks_9f2c41a8"></div>
 *
 * Renders the SUQO payment block *inline*, where the merchant put the div. No overlay, no
 * modal, no page takeover: it is a payment element in their layout, like any other field.
 *
 * The checkout session is created by the merchant's own backend through the API and already
 * carries the buyer; this only collects the payment for it. So the block shows what is
 * actually left to decide — which gateway, and consent — and nothing else. Nothing about the
 * customer appears on the merchant's page at all.
 *
 * Source of truth: `js-checkout/public/suqo-checkout.js`. The identical file at
 * `frontend/public/suqo-checkout.js` is a copy, and the one actually served. Edit the
 * js-checkout one, then run `npm run sync` *in that project* — `sync:check` fails the build
 * if the two drift. Paths are spelled out because this comment ships in both files, where
 * "here" would name a different directory in each.
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

  /**
   * There is no last-resort base URL, deliberately.
   *
   * There used to be — `https://test.suqo.ai`, hardcoded — and it was the wrong shape of
   * safety net. Every path that reaches it is a copy of this file that is not being served by
   * a checkout deployment: self-hosted, inlined into a bundle, or behind a CDN. Guessing
   * sandbox there means a merchant's *production* checkout quietly runs against test data and
   * nothing about it looks broken.
   *
   * The loader is served by the checkout itself — `test.suqo.ai/suqo-checkout.js` for sandbox,
   * `app.suqo.ai/suqo-checkout.js` for live — which is what makes the script-origin step below
   * correct with no configuration at all. When that step cannot answer, the honest move is to
   * refuse and say so.
   */

  /** The container id looked for when the merchant names none. */
  var DEFAULT_CONTAINER_ID = 'suqo-checkout-block'

  /** Marks a container without relying on an id, so a page can carry more than one. */
  var CONTAINER_ATTR = 'data-suqo-checkout-block'

  /**
   * Shared with the app: src/lib/embed/bridge.ts opens the gateway window under this exact
   * name, or the host cannot take a handle on it to clean up.
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
    redirect: 'suqo:redirect',
    unavailable: 'suqo:unavailable',
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
    /**
     * A checkout session id from configure(), consumed by the first block that has none of
     * its own and then cleared. Ids belong on the container — a page may carry several
     * blocks — and without the latch the MutationObserver would apply this one to every
     * container that appears later, mounting the same session over and over on an SPA.
     */
    sessionId: null,
    /** 'redirect' to skip the iframe entirely. See mountRedirect. */
    flow: null,
    onReady: null,
    onSuccess: null,
    onFailure: null,
    onUnavailable: null,
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
   *   window.SUQO_CHECKOUT_ORIGIN  →  origin the script was served from
   *
   * Returns null when none of them answers, and the caller refuses to mount. See the note on
   * the removed fallback above for why guessing is worse than failing.
   */
  /** Said once: discovery re-runs on DOM mutations and would otherwise repeat this forever. */
  var warnedNoOrigin = false

  function warnNoOrigin() {
    if (warnedNoOrigin) return
    warnedNoOrigin = true
    if (window.console && console.error) {
      console.error(
        '[suqo] Could not work out which SUQO checkout to load. This script is meant to be ' +
          'served by the checkout itself — https://test.suqo.ai/suqo-checkout.js for sandbox, ' +
          'https://app.suqo.ai/suqo-checkout.js for live. If you are self-hosting it, set the ' +
          'origin explicitly with data-suqo-origin on the block or ' +
          'SuqoCheckout.configure({ origin }).'
      )
    }
  }

  function resolveOrigin(perCall) {
    var candidate =
      perCall || defaults.origin || window.SUQO_CHECKOUT_ORIGIN || scriptOrigin() || null
    return candidate ? trimTrailingSlash(candidate) : null
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

    // Nothing could say which checkout serves this block. Refusing beats guessing: a guessed
    // origin renders a block that looks fine and takes money in the wrong environment.
    if (!base && !url) {
      warnNoOrigin()
      return null
    }
    // `custom` is a URL given verbatim, so this script cannot know what is on the other end —
    // which is why `mountRedirect` refuses it: there is no session id to build a hosted URL from.
    var flow = url ? 'custom' : null

    if (!url) {
      if (!opts.sessionId) return null
      flow = 'session'
      url = base + '/c/' + encodeURIComponent(opts.sessionId)
    }

    // Appended in exactly one place, so the hash rule above holds by construction rather
    // than by remembering it at each branch.
    return { url: url + '#parentOrigin=' + encodeURIComponent(window.location.origin), flow: flow }
  }

  /** The hosted checkout for a session — where both fallbacks send the buyer. */
  function hostedCheckoutUrl(base, sessionId) {
    return trimTrailingSlash(base) + '/checkout/' + encodeURIComponent(sessionId)
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

  /** The configured session id, consumed once so it cannot be reused by a later block. */
  function takeConfiguredSessionId() {
    var id = defaults.sessionId
    defaults.sessionId = null
    return id
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

  /**
   * The one button this script ever draws: leave the frame for a page that works.
   *
   * An anchor rather than a button with a handler. A click on it is a real navigation, so it
   * cannot be refused the way a programmatic one can, and it brings middle-click, long-press,
   * "open in new tab" and a status-bar preview with it for free.
   */
  function buildContinueLink(url, label, target) {
    var link = make('a', {
      display: 'inline-block',
      marginTop: '4px',
      padding: '11px 20px',
      borderRadius: '10px',
      background: '#635bff',
      color: '#ffffff',
      font: '600 15px/1 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif',
      textDecoration: 'none',
    })
    link.href = url
    if (target) {
      link.target = target
      link.rel = 'noopener noreferrer'
    }
    link.textContent = label
    return link
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

    var link = buildContinueLink(url, 'Open the payment page in a new tab', '_blank')

    wrap.appendChild(title)
    wrap.appendChild(body)
    wrap.appendChild(link)
    return wrap
  }

  // ───────────────────────── sessions ─────────────────────────
  //
  // One entry per mounted container. A page may carry several blocks — two checkout sessions
  // on one page is an ordinary thing for a merchant to want — so nothing here may live in a
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
      // Guarded: a redirect-flow block is a registered session with no iframe at all, and an
      // unguarded read here would throw on *every* message for *every other* block on the page.
      if (sessions[i].iframe && sessions[i].iframe.contentWindow === source) return sessions[i]
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

  /**
   * Takes the merchant's page to the hosted checkout, on the frame's request.
   *
   * The host owns this because the frame cannot: its sandbox deliberately omits
   * `allow-top-navigation-by-user-activation`, and those flags are not changing — they are
   * what keep the merchant's scripts away from the payment payload.
   *
   * The URL is re-validated as same-origin even though `event.origin` was already checked,
   * and the distinction matters: `event.origin` proves the checkout origin *asked*, not that
   * what it asked for is safe. Without this, any reflected value inside the checkout app
   * becomes an open redirect on every merchant page that embeds this script — a far better
   * exploit than the same bug confined to one origin. The payload is by design a SUQO hosted
   * URL, so the check costs the legitimate path nothing.
   */
  function navigateTop(session, rawUrl) {
    var parsed
    try {
      parsed = new URL(String(rawUrl), window.location.href)
    } catch (e) {
      console.warn('[SuqoCheckout] ignoring an unparseable redirect url:', rawUrl)
      return
    }

    // Kept explicit even though the origin check below subsumes it — `new URL('javascript:…')`
    // has an origin of "null" and would fail there anyway. One line a security reviewer can
    // read beats a footnote explaining why it is implied.
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      console.warn('[SuqoCheckout] refusing a non-http(s) redirect url:', rawUrl)
      return
    }

    if (parsed.origin !== session.origin) {
      console.warn('[SuqoCheckout] refusing a cross-origin redirect url:', rawUrl)
      return
    }

    session.redirecting = true
    // Necessary rather than tidy: the READY deadline can fire during the unload window and
    // paint the failure panel over a page that is already leaving.
    clearTimers(session)
    closeGatewayWindow()

    // `href`, not `replace`: the merchant's page stays in history, so Back returns the buyer
    // to the shop. A stale block on that return is harmless — it re-mounts, and the session
    // reports itself spent.
    window.location.href = parsed.href
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
      // The canonical spelling plus one short alias. The long one is easy to mistype, and a
      // near-miss falls through to the silent no-id path below — a blank div and nothing in
      // the console.
      sessionId:
        opts.sessionId ||
        opts.checkoutSessionId ||
        container.getAttribute('data-suqo-checkout-session-id') ||
        container.getAttribute('data-suqo-session-id') ||
        takeConfiguredSessionId() ||
        undefined,
      origin: opts.origin || container.getAttribute('data-suqo-origin') || undefined,
    }

    var built = buildUrl(config)
    if (!built) {
      // Silent on the discovery path: a container the merchant will drive with mount() later
      // is an ordinary state to find on the page, not a mistake worth a console warning on
      // every mutation batch. An explicit mount() with no id is a caller error, so it speaks.
      if (!auto) {
        console.warn(
          '[SuqoCheckout] no id on the block. Add data-suqo-checkout-session-id, or pass ' +
            'sessionId to mount().'
        )
      }
      return api
    }

    var url = built.url
    var flow = built.flow

    var frameOrigin
    try {
      frameOrigin = new URL(url, window.location.href).origin
    } catch (e) {
      console.warn('[SuqoCheckout] unparseable checkout url:', url)
      return api
    }

    // Before any DOM mutation below: everything past this point is iframe machinery, and the
    // redirect flow wants none of it.
    var requestedFlow =
      opts.flow || container.getAttribute('data-suqo-flow') || defaults.flow || 'auto'
    if (requestedFlow === 'redirect') {
      if (flow !== 'session') {
        // A verbatim `data-suqo-checkout` URL carries no session id, so there is nothing to
        // build `/checkout/<id>` from.
        console.warn(
          '[SuqoCheckout] data-suqo-flow="redirect" needs data-suqo-checkout-session-id. ' +
            'Falling back to the embedded block.'
        )
      } else {
        return mountRedirect(container, config, opts)
      }
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
      flow: flow,
      checkoutSessionId: config.sessionId || null,
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
        onUnavailable: opts.onUnavailable,
      },
      loaded: false,
      alive: false,
      ready: false,
      failed: false,
      gatewayOpened: false,
      resultHandled: false,
      redirecting: false,
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

  /**
   * The explicit opt-out: render a link to the hosted checkout, and no frame at all.
   *
   * For a merchant who already knows they are inside their own WebView and would rather not
   * show a payment block the buyer cannot complete.
   *
   * It renders a link rather than navigating on mount, and that is not timidity. Mount fires
   * from DOMContentLoaded or from the MutationObserver, so on an SPA the merchant's router
   * would render the block and the page would instantly leave; Back would re-mount and
   * re-navigate, trapping the buyer with no defence short of a sessionStorage hack; a
   * navigation with no transient activation is increasingly refused outright; and taking the
   * page over contradicts the one thing this script promises — a payment element in their
   * layout.
   */
  function mountRedirect(container, config, opts) {
    if (sessionFor(container)) unmount(container)

    var origin = resolveOrigin(config.origin)
    if (!origin) {
      warnNoOrigin()
      return null
    }

    var href = hostedCheckoutUrl(origin, config.sessionId)
    var label =
      opts.flowLabel ||
      container.getAttribute('data-suqo-flow-label') ||
      // Not "Pay now": the buyer is not paying yet, and the next screen asking them to pick a
      // gateway after a button that promised payment is where the drop-off happens.
      'Continue to payment'

    var link = buildContinueLink(href, label, null)
    container.appendChild(link)

    // Registered like any other block, so unmount() works uniformly and the observer's
    // sessionFor() check still stops it from mounting twice. Every consumer of this list now
    // guards on `iframe` being present.
    sessions.push({
      container: container,
      iframe: null,
      spinner: null,
      link: link,
      url: href,
      origin: resolveOrigin(config.origin),
      flow: 'redirect',
      checkoutSessionId: config.sessionId,
      previousPosition: container.style.position,
      previousMinHeight: container.style.minHeight,
      handlers: {
        onReady: opts.onReady,
        onSuccess: opts.onSuccess,
        onFailure: opts.onFailure,
        onUnavailable: opts.onUnavailable,
      },
      loaded: true,
      alive: true,
      ready: true,
      failed: false,
      gatewayOpened: false,
      resultHandled: false,
      redirecting: false,
      loadTimer: null,
      aliveTimer: null,
      readyTimer: null,
    })

    return api
  }

  function unmount(target) {
    var container = resolveElement(target)
    var session = container ? sessionFor(container) : null
    if (!session) return api

    clearTimers(session)
    if (session.spinner) session.spinner.stop()

    for (var i = 0; i < sessions.length; i++) {
      if (sessions[i] === session) {
        sessions.splice(i, 1)
        break
      }
    }

    if (session.iframe && session.iframe.parentNode) {
      session.iframe.parentNode.removeChild(session.iframe)
    }
    if (session.link && session.link.parentNode) {
      session.link.parentNode.removeChild(session.link)
    }
    if (session.spinner && session.spinner.el.parentNode) {
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

  // ───────────────────────── messages ─────────────────────────
  //
  // One direction only. The frame speaks; the host listens and acts. There is no host-to-frame
  // message and none should be added: a checkout session carries the buyer server-side, so
  // there is nothing this script knows that the frame needs, and anything sent down would be
  // buyer-shaped data on the wire for no reason.

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

      case MSG.redirect:
        // No flow gate. Every block is a checkout block, and what actually guards this is the
        // payload check in `navigateTop` — the URL must be same-origin with the frame.
        //
        // A navigation is already committed; a second is noise at best.
        if (session.redirecting) return

        // The merchant's callbacks cannot fire past here — their document is about to be
        // destroyed — so `return_url` on the session is the only way the buyer gets back to
        // them. onFailure is deliberately not called: nothing settled badly, nothing settled
        // at all.
        navigateTop(session, data.url)
        break

      case MSG.unavailable:
        // The session cannot be paid: expired, already spent, never existed, or wired up
        // without a customer. The block has rendered its own explanation to the buyer, so
        // nothing needs doing here — but a merchant who is never told cannot tell a session
        // their integration created wrong from one nobody clicked, which is the most common
        // integration error there is.
        //
        // Not onFailure: no payment was attempted, and reporting one that was is worse than
        // saying nothing. One callback for all six reasons, matching the other two SDKs:
        // 'not-found', 'expired', 'spent', 'no-customer', 'no-methods', 'load-failed'.
        var onUnavailable = handler(session, 'onUnavailable')
        if (onUnavailable) onUnavailable(data.reason)
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
      // Latched — see `defaults.sessionId`.
      if (options.sessionId || options.checkoutSessionId) {
        defaults.sessionId = String(options.sessionId || options.checkoutSessionId)
      }
      // Unlike an id, a flow genuinely is a property of the page, so it is not latched.
      if (options.flow) defaults.flow = String(options.flow)
      if (options.onReady) defaults.onReady = options.onReady
      if (options.onSuccess) defaults.onSuccess = options.onSuccess
      if (options.onFailure) defaults.onFailure = options.onFailure
      if (options.onUnavailable) defaults.onUnavailable = options.onUnavailable
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
