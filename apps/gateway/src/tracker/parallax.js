/*! Parallax tracker 0.1.0 | MIT | https://github.com/Parallax-Build/parallax-analytics
 *
 * Usage:
 *   <script defer src="https://INGEST/v/0.1.0/parallax.js" data-website="WEBSITE_ID"
 *           integrity="sha384-..." crossorigin="anonymous"></script>
 *
 * No cookies, no localStorage, no fingerprinting. The script sends page views
 * and named events to the Parallax ingest gateway. It is served only at a
 * versioned URL; upgrading means changing the version in your own code.
 */
(function () {
  "use strict";
  var script = document.currentScript;
  if (!script) return;
  var website = script.getAttribute("data-website");
  if (!website) return;
  var host = (script.getAttribute("data-host") || new URL(script.src).origin).replace(/\/$/, "");

  var token = null;
  var tokenPromise = null;
  var cache; // Session continuity value returned by the store. Memory only.
  var lastUrl = null;

  function post(path, body) {
    // text/plain keeps this a "simple" cross-origin request: no preflight.
    return fetch(host + path, {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: JSON.stringify(body),
      keepalive: true,
      credentials: "omit",
    });
  }

  function leadingZeroBits(bytes) {
    var bits = 0;
    for (var i = 0; i < bytes.length; i++) {
      if (bytes[i] === 0) { bits += 8; continue; }
      bits += Math.clz32(bytes[i]) - 24;
      break;
    }
    return bits;
  }

  async function solve(challenge, bits) {
    var encoder = new TextEncoder();
    for (var counter = 0; ; counter++) {
      var digest = await crypto.subtle.digest("SHA-256", encoder.encode(challenge + ":" + counter));
      if (leadingZeroBits(new Uint8Array(digest)) >= bits) return counter;
    }
  }

  async function fetchToken() {
    var c = await (await post("/challenge", { website: website })).json();
    if (!c.challenge) throw new Error(c.code || "challenge-failed");
    var counter = await solve(c.challenge, c.bits);
    var t = await (await post("/token", { challenge: c.challenge, counter: counter })).json();
    if (!t.token) throw new Error(t.code || "token-failed");
    return t.token;
  }

  function getToken() {
    if (token) return Promise.resolve(token);
    if (!tokenPromise) {
      tokenPromise = fetchToken().then(
        function (t) { token = t; tokenPromise = null; return t; },
        function (e) { tokenPromise = null; throw e; }
      );
    }
    return tokenPromise;
  }

  async function send(payload, retried) {
    try {
      var t = await getToken();
      var response = await post("/e", {
        type: "event",
        token: t,
        cache: cache,
        wd: navigator.webdriver === true,
        payload: payload,
      });
      if (response.status === 401 && !retried) {
        token = null; // expired: get a new one, once
        return send(payload, true);
      }
      var result = await response.json();
      if (result && result.cache) cache = result.cache;
    } catch (e) {
      /* Analytics must never break the page. */
    }
  }

  function base() {
    return {
      website: website,
      hostname: location.hostname,
      language: navigator.language,
      screen: screen.width + "x" + screen.height,
      title: document.title,
      url: location.pathname + location.search,
      referrer: lastUrl === null ? document.referrer : lastUrl,
    };
  }

  function pageview() {
    var url = location.pathname + location.search;
    if (url === lastUrl) return;
    var payload = base();
    lastUrl = url;
    send(payload, false);
  }

  function track(name, data) {
    if (typeof name !== "string" || !name) return;
    var payload = base();
    payload.name = name.slice(0, 50);
    if (data && typeof data === "object") payload.data = data;
    send(payload, false);
  }

  // Single-page apps: count a view when the URL changes.
  ["pushState", "replaceState"].forEach(function (method) {
    var original = history[method];
    history[method] = function () {
      var result = original.apply(this, arguments);
      setTimeout(pageview, 0);
      return result;
    };
  });
  window.addEventListener("popstate", function () { setTimeout(pageview, 0); });

  window.parallax = { track: track, version: "0.1.0" };

  if (document.visibilityState === "prerender") {
    document.addEventListener("visibilitychange", pageview, { once: true });
  } else {
    pageview();
  }
})();
