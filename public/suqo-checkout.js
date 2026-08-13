/*!
 * SUQO embedded checkout — drop-in loader.
 *
 *   <script src="https://test.suqo.ai/suqo-checkout.js"></script>
 *   <button data-suqo-pay-id="SUB123">Pay</button>
 *
 * Opens the SUQO checkout in a modal iframe over the merchant's own page, so the
 * buyer never leaves it. No build step, no dependencies, one global.
 *
 * Source of truth: the `js-checkout` project. `frontend/public/suqo-checkout.js`
 * is a synced copy — that is the one actually served. Edit here, then run
 * `npm run sync` in js-checkout. See its README.
 *
 * ES5 on purpose: this runs on whatever the merchant's site happens to be, which
 * may be an old template with no transpiler in front of it. No const/let, no
 * arrow functions, no template literals.
 *
 * Every style is set inline on the elements this creates. A host page's CSS must
 * not be able to restyle the modal, and nothing here may leak out — so there is
 * no stylesheet, no class names, and no <style> injection.
 */
;(function () {
  'use strict'

  if (window.SuqoCheckout) return

  // Last-resort base URL, used when the origin cannot be derived any other way.
  var FALLBACK_ORIGIN = 'https://test.suqo.ai'

  // Shared with the app: src/lib/embed/embedMode.ts must open the gateway popup
  // under this exact name, or the host cannot take a handle on it to clean up.
  var GATEWAY_WINDOW_NAME = 'suqo_gateway'

  // Envelope tag on every message, so unrelated postMessage traffic on the host
  // page (analytics, chat widgets, other embeds) is ignored cheaply.
  var MESSAGE_SOURCE = 'suqo-checkout'

  var MSG = {
    alive: 'suqo:alive',
    ready: 'suqo:ready',
    resize: 'suqo:resize',
    gateway: 'suqo:gateway',
    result: 'suqo:result',
    close: 'suqo:close',
  }

  // Two deadlines, because "nothing loaded" and "loading slowly" need different
  // messages and different patience. ALIVE_MS expires when the document itself
  // never ran — a CSP frame-ancestors block, a dead link, an extension blocking
  // frames. Once `alive` lands we know the frame is real and only slow, so the
  // budget extends to READY_MS.
  var ALIVE_DEADLINE_MS = 4000
  var READY_DEADLINE_MS = 25000

  var CARD_MAX_WIDTH = 520
  var MIN_FRAME_HEIGHT = 420

  var configuredOrigin = null

  // ───────────────────────── origin resolution ─────────────────────────

  function trimTrailingSlash(value) {
    return String(value).replace(/\/+$/, '')
  }

  /** Origin of the <script> that loaded this file, or null when undeterminable. */
  function scriptOrigin() {
    var current = document.currentScript
    // currentScript is null inside a callback, and this function is called lazily
    // (on open), so fall back to locating our own tag by filename.
    if (!current) {
      var tags = document.getElementsByTagName('script')
      for (var i = tags.length - 1; i >= 0; i--) {
        if (tags[i].src && tags[i].src.indexOf('suqo-checkout.js') !== -1) {
          current = tags[i]
          break
        }
      }
    }
    if (!current || !current.src) return null
    try {
      return new URL(current.src, window.location.href).origin
    } catch (e) {
      return null
    }
  }

  /**
   * Resolution order, most specific first:
   *   per-call origin  →  data-suqo-origin  →  configure()/window.SUQO_CHECKOUT_ORIGIN
   *   →  origin the script was served from  →  FALLBACK_ORIGIN
   */
  function resolveOrigin(perCall) {
    var candidate =
      perCall || configuredOrigin || window.SUQO_CHECKOUT_ORIGIN || scriptOrigin() || FALLBACK_ORIGIN
    return trimTrailingSlash(candidate)
  }

  function buildUrl(opts) {
    if (opts.url) return opts.url // used verbatim — the caller owns the query string
    var base = resolveOrigin(opts.origin)
    if (opts.payId) return base + '/pay/' + encodeURIComponent(opts.payId)
    if (opts.renewId) return base + '/renew/' + encodeURIComponent(opts.renewId)
    return null
  }

  // ───────────────────────── scroll lock ─────────────────────────
  //
  // Saves and restores the host's own values rather than clearing them: the page
  // may already set overflow or padding-right for its own reasons, and clearing
  // them on close would be a visible change the merchant did not ask for.

  var savedOverflow = null
  var savedPaddingRight = null

  function lockScroll() {
    var body = document.body
    savedOverflow = body.style.overflow
    savedPaddingRight = body.style.paddingRight
    // Hiding overflow removes the scrollbar, which widens the viewport and shifts
    // the page under the overlay. Pad by the width it occupied to hold it still.
    var scrollbar = window.innerWidth - document.documentElement.clientWidth
    if (scrollbar > 0) {
      var existing = parseInt(window.getComputedStyle(body).paddingRight, 10) || 0
      body.style.paddingRight = existing + scrollbar + 'px'
    }
    body.style.overflow = 'hidden'
  }

  function unlockScroll() {
    if (savedOverflow === null) return
    document.body.style.overflow = savedOverflow
    document.body.style.paddingRight = savedPaddingRight
    savedOverflow = null
    savedPaddingRight = null
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

  // ───────────────────────── state ─────────────────────────

  var session = null

  function isOpen() {
    return session !== null
  }

  // ───────────────────────── modal ─────────────────────────

  function buildSpinner() {
    var wrap = make('div', {
      position: 'absolute',
      inset: '0',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      background: '#ffffff',
      zIndex: '1',
    })

    // Keyframes cannot be inlined, so the spin is driven by setInterval on a
    // transform. Avoids injecting a <style> tag into the host document.
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
    return { el: wrap, stop: function () { window.clearInterval(timer) } }
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
      background: '#ffffff',
      textAlign: 'center',
      font: '400 15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif',
      color: '#425466',
      zIndex: '2',
    })

    var title = make('div', {
      font: '600 17px/1.3 inherit',
      color: '#0d062d',
    })
    title.textContent = "The checkout didn't load"

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
    link.textContent = 'Open checkout in a new tab'

    wrap.appendChild(title)
    wrap.appendChild(body)
    wrap.appendChild(link)
    return wrap
  }

  // ───────────────────────── gateway popup cleanup ─────────────────────────

  /**
   * Closes a gateway window that outlived the checkout. A payable window with
   * nothing left to report back to is worse than no window: the buyer can
   * complete a payment that never reaches the merchant's page.
   *
   * The handle is taken by *name*, which is the only way the host can reach a
   * window the iframe opened. Note this call reassigns that window's `opener` to
   * the host — see the note in reportResultToEmbedOpener on the app side, which
   * is why the return page must post with target '*'.
   */
  function closeGatewayWindow() {
    if (!session || !session.gatewayOpened) return
    try {
      var handle = window.open('', GATEWAY_WINDOW_NAME)
      if (handle && !handle.closed) handle.close()
    } catch (e) {
      /* cross-origin or popup blocked — nothing we can do */
    }
  }

  // ───────────────────────── open / close ─────────────────────────

  function open(options) {
    var opts = options || {}
    if (isOpen()) close()

    var url = buildUrl(opts)
    if (!url) {
      throw new Error('SuqoCheckout.open needs one of: url, payId, renewId')
    }

    var targetOrigin
    try {
      targetOrigin = new URL(url, window.location.href).origin
    } catch (e) {
      throw new Error('SuqoCheckout.open received an unparseable url: ' + url)
    }

    var showResult = opts.showResult !== false

    var overlay = make('div', {
      position: 'fixed',
      inset: '0',
      zIndex: '2147483000',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      padding: '16px',
      background: 'rgba(13,6,45,0.55)',
      opacity: '0',
      transition: 'opacity 180ms ease',
      // The host page's text styles must not reach into the modal chrome.
      font: '400 15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif',
      boxSizing: 'border-box',
    })

    var card = make('div', {
      position: 'relative',
      width: '100%',
      maxWidth: CARD_MAX_WIDTH + 'px',
      height: MIN_FRAME_HEIGHT + 'px',
      maxHeight: 'calc(100vh - 32px)',
      background: '#ffffff',
      borderRadius: '16px',
      overflow: 'hidden',
      boxShadow: '0 24px 60px rgba(13,6,45,0.28)',
      transform: 'scale(0.96)',
      opacity: '0',
      transition: 'transform 200ms ease, opacity 200ms ease, height 220ms ease',
      boxSizing: 'border-box',
    })

    var closeButton = make('button', {
      position: 'absolute',
      top: '10px',
      right: '10px',
      zIndex: '3',
      width: '32px',
      height: '32px',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      padding: '0',
      border: '0',
      borderRadius: '50%',
      background: 'rgba(245,246,250,0.92)',
      color: '#425466',
      font: '400 20px/1 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif',
      cursor: 'pointer',
      boxSizing: 'border-box',
    })
    closeButton.type = 'button'
    closeButton.setAttribute('aria-label', 'Close checkout')
    closeButton.innerHTML = '&times;'

    var spinner = buildSpinner()

    var iframe = make('iframe', {
      position: 'relative',
      zIndex: '0',
      display: 'block',
      width: '100%',
      height: '100%',
      border: '0',
      boxSizing: 'border-box',
    })
    iframe.setAttribute('title', 'SUQO checkout')
    iframe.setAttribute('allow', 'payment *; clipboard-write')
    // Deliberately not sandboxed. `allow-scripts allow-same-origin` on a
    // same-origin frame is close to no sandbox anyway, and sandboxing blocks the
    // custom-protocol bank deeplinks the Nepali gateways rely on. See README.

    card.appendChild(closeButton)
    card.appendChild(spinner.el)
    card.appendChild(iframe)
    overlay.appendChild(card)

    session = {
      overlay: overlay,
      card: card,
      iframe: iframe,
      spinner: spinner,
      url: url,
      origin: targetOrigin,
      showResult: showResult,
      handlers: opts,
      alive: false,
      ready: false,
      failed: false,
      gatewayOpened: false,
      aliveTimer: null,
      readyTimer: null,
      onMessage: null,
      onKeydown: null,
      onPopState: null,
      onPageHide: null,
    }

    function fail(reason, consoleHint) {
      if (!session || session.failed || session.ready) return
      session.failed = true
      session.spinner.stop()
      if (session.spinner.el.parentNode) {
        session.spinner.el.parentNode.removeChild(session.spinner.el)
      }
      session.card.appendChild(buildFailurePanel(session.url, reason))
      if (consoleHint) console.warn('[SuqoCheckout] ' + consoleHint)
    }

    function clearTimers() {
      if (session.aliveTimer) window.clearTimeout(session.aliveTimer)
      if (session.readyTimer) window.clearTimeout(session.readyTimer)
      session.aliveTimer = null
      session.readyTimer = null
    }

    // ── message handling ──
    //
    // Only the origin is checked, never event.source. The payment result
    // legitimately arrives from the gateway popup rather than the iframe, and
    // pinning the source would drop it.
    session.onMessage = function (event) {
      if (!session) return
      if (event.origin !== session.origin) return

      var data = event.data
      if (!data || typeof data !== 'object') return
      if (data.source !== MESSAGE_SOURCE) return

      switch (data.type) {
        case MSG.alive:
          if (session.alive) return
          session.alive = true
          if (session.aliveTimer) window.clearTimeout(session.aliveTimer)
          session.aliveTimer = null
          // The frame is real, just not mounted yet — extend the budget.
          session.readyTimer = window.setTimeout(function () {
            fail(
              'The checkout is taking longer than expected. You can continue in a new tab.',
              'Checkout loaded but never became ready within ' +
                READY_DEADLINE_MS / 1000 +
                's. The page is reachable, so this is slowness rather than a framing block.'
            )
          }, READY_DEADLINE_MS)
          break

        case MSG.ready:
          session.ready = true
          clearTimers()
          session.spinner.stop()
          if (session.spinner.el.parentNode) {
            session.spinner.el.parentNode.removeChild(session.spinner.el)
          }
          if (typeof session.handlers.onReady === 'function') session.handlers.onReady()
          break

        case MSG.resize:
          var height = Number(data.height)
          if (!height || isNaN(height)) return
          session.card.style.height = Math.max(height, MIN_FRAME_HEIGHT) + 'px'
          break

        case MSG.gateway:
          // Remember that a popup exists so it can be closed if this page goes away.
          session.gatewayOpened = true
          break

        case MSG.result:
          var status = data.status
          var params = data.params || {}
          if (status === 'success') {
            // Params are passed through exactly as the gateway returned them.
            // Every gateway names its ids differently and the merchant reconciles
            // against what their own backend knows — normalising here would throw
            // away the only field they can match on.
            if (typeof session.handlers.onSuccess === 'function') {
              session.handlers.onSuccess(params)
            }
          } else if (typeof session.handlers.onFailure === 'function') {
            session.handlers.onFailure(status, params)
          }
          if (!session.showResult) close()
          break

        case MSG.close:
          close()
          break
      }
    }

    session.onKeydown = function (event) {
      if (event.key === 'Escape' || event.keyCode === 27) close()
    }

    session.onPopState = function () {
      // Close only. Never history.back() from here: the entry pushed below is not
      // necessarily the previous one, because in-frame navigations add their own
      // joint session history entries. Going back would re-navigate one of those
      // and read to the buyer as the whole page reloading.
      close()
    }

    session.onPageHide = function () {
      closeGatewayWindow()
    }

    // Listener first, src second. On localhost the frame can post alive/ready
    // before a listener attached afterwards would exist, and those messages are
    // not replayed.
    window.addEventListener('message', session.onMessage)
    document.addEventListener('keydown', session.onKeydown)
    window.addEventListener('popstate', session.onPopState)
    // pagehide, not unload: unload is blocked by Permissions-Policy in current
    // Chrome and would never fire.
    window.addEventListener('pagehide', session.onPageHide)

    overlay.addEventListener('click', function (event) {
      // Only a click on the backdrop itself closes. Without the target check, a
      // click that started inside the card but ended on the overlay would close
      // the modal mid-interaction.
      if (event.target === overlay) close()
    })
    closeButton.addEventListener('click', function () {
      close()
    })

    lockScroll()
    document.body.appendChild(overlay)

    // Pushed so the hardware/browser Back button closes the modal instead of
    // leaving the merchant's page. Left in place on close — see onPopState.
    try {
      window.history.pushState({ suqoCheckout: true }, '')
    } catch (e) {
      /* history unavailable (sandboxed host) — Back-to-close simply won't work */
    }

    session.aliveTimer = window.setTimeout(function () {
      fail(
        'We could not load the checkout here. Your browser or this site may be blocking it.',
        'No response from ' +
          session.origin +
          ' within ' +
          ALIVE_DEADLINE_MS / 1000 +
          's. The most likely cause is a Content-Security-Policy frame-ancestors ' +
          'directive on the checkout origin, or an extension blocking iframes. ' +
          'Open ' +
          session.url +
          ' directly to confirm the link itself works.'
      )
    }, ALIVE_DEADLINE_MS)

    iframe.src = url

    // Paint, then transition in.
    window.requestAnimationFrame(function () {
      overlay.style.opacity = '1'
      card.style.opacity = '1'
      card.style.transform = 'scale(1)'
    })

    return api
  }

  function close() {
    if (!session) return
    var current = session
    session = null

    if (current.aliveTimer) window.clearTimeout(current.aliveTimer)
    if (current.readyTimer) window.clearTimeout(current.readyTimer)
    current.spinner.stop()

    window.removeEventListener('message', current.onMessage)
    document.removeEventListener('keydown', current.onKeydown)
    window.removeEventListener('popstate', current.onPopState)
    window.removeEventListener('pagehide', current.onPageHide)

    // Restore the session briefly so closeGatewayWindow can read gatewayOpened.
    session = current
    closeGatewayWindow()
    session = null

    current.overlay.style.opacity = '0'
    current.card.style.opacity = '0'
    current.card.style.transform = 'scale(0.96)'

    window.setTimeout(function () {
      if (current.overlay.parentNode) current.overlay.parentNode.removeChild(current.overlay)
      unlockScroll()
    }, 190)

    if (typeof current.handlers.onClose === 'function') current.handlers.onClose()
  }

  // ───────────────────────── declarative binding ─────────────────────────
  //
  // Delegated from document rather than bound per element, so buttons rendered
  // after this script runs (SPA views, lazy sections, CMS widgets) work with no
  // re-initialisation step.

  function findTrigger(start) {
    var node = start
    while (node && node !== document.body) {
      if (node.nodeType === 1) {
        if (
          node.hasAttribute('data-suqo-checkout') ||
          node.hasAttribute('data-suqo-pay-id') ||
          node.hasAttribute('data-suqo-renew-id')
        ) {
          return node
        }
      }
      node = node.parentNode
    }
    return null
  }

  document.addEventListener('click', function (event) {
    var trigger = findTrigger(event.target)
    if (!trigger) return

    event.preventDefault()

    open({
      url: trigger.getAttribute('data-suqo-checkout') || undefined,
      payId: trigger.getAttribute('data-suqo-pay-id') || undefined,
      renewId: trigger.getAttribute('data-suqo-renew-id') || undefined,
      origin: trigger.getAttribute('data-suqo-origin') || undefined,
    })
  })

  // ───────────────────────── public API ─────────────────────────

  var api = {
    open: open,
    close: close,
    configure: function (options) {
      if (options && options.origin) configuredOrigin = trimTrailingSlash(options.origin)
      return api
    },
  }

  Object.defineProperty(api, 'origin', {
    get: function () {
      return resolveOrigin(null)
    },
  })

  window.SuqoCheckout = api
})()
