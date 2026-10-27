// Pont entre MboaLang (Flutter) et le navigateur : service worker, installation
// sur l'écran d'accueil, partage, zones sûres de l'iPhone, icône vivante de
// l'onglet, vibrations. Utilisé par lib/core/web/web_shell_web.dart.
(function () {
  'use strict';

  // --- Démarrage plus rapide : le programme et le moteur graphique sont
  // demandés tout de suite, en parallèle, au lieu d'attendre l'amorce de
  // Flutter. Même choix de variante que Flutter (flutter.js) : « chromium »
  // pour Chrome et Edge récents, la variante générale ailleurs.
  try {
    const blink = navigator.vendor === 'Google Inc.' || navigator.userAgent.includes('Edg/');
    const chromium = blink && typeof ImageDecoder !== 'undefined' &&
      typeof Intl.v8BreakIterator !== 'undefined' && typeof Intl.Segmenter !== 'undefined';
    const dir = chromium ? 'canvaskit/chromium/' : 'canvaskit/';
    const hint = (href, as, cors) => {
      const link = document.createElement('link');
      link.rel = as === 'module' ? 'modulepreload' : 'preload';
      if (as !== 'module') link.as = as;
      if (cors) link.crossOrigin = 'anonymous';
      link.href = href;
      document.head.appendChild(link);
    };
    hint('main.dart.js', 'script');
    hint(dir + 'canvaskit.js', 'module');
    hint(dir + 'canvaskit.wasm', 'fetch', true);
  } catch (_) {}

  const listeners = [];
  const waiting = [];
  let installEvent = null;
  let installed = false;

  function emit(msg) {
    const text = JSON.stringify(msg);
    if (!listeners.length) {
      waiting.push(text);
      return;
    }
    for (const fn of listeners) {
      try {
        fn(text);
      } catch (_) {}
    }
  }

  // --- Installation (Android, ordinateur) : la fenêtre du navigateur est
  // gardée pour être ouverte depuis l'application, au bon moment.
  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault();
    installEvent = event;
    emit({ type: 'install', available: true });
  });
  window.addEventListener('appinstalled', () => {
    installEvent = null;
    installed = true;
    emit({ type: 'install', available: false, installed: true });
  });

  function standalone() {
    try {
      return (
        navigator.standalone === true ||
        matchMedia('(display-mode: standalone)').matches ||
        matchMedia('(display-mode: window-controls-overlay)').matches ||
        matchMedia('(display-mode: fullscreen)').matches
      );
    } catch (_) {
      return false;
    }
  }

  function platform() {
    const ua = navigator.userAgent || '';
    if (/iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)) return 'ios';
    if (/Android/.test(ua)) return 'android';
    return 'desktop';
  }

  function browser() {
    const ua = navigator.userAgent || '';
    if (/EdgiOS|Edg\//.test(ua)) return 'edge';
    if (/SamsungBrowser/.test(ua)) return 'samsung';
    if (/CriOS/.test(ua)) return 'chrome';
    if (/FxiOS|Firefox\//.test(ua)) return 'firefox';
    if (/OPR\/|OPiOS/.test(ua)) return 'opera';
    if (/Chrome\//.test(ua)) return 'chrome';
    if (/Safari\//.test(ua)) return 'safari';
    return 'other';
  }

  // --- Zones sûres (encoche, barre d'accueil de l'iPhone) : Flutter ne les
  // lit pas ; on les mesure ici, l'application les applique (web_safe_area).
  let probe = null;
  function insets() {
    try {
      if (!probe) {
        probe = document.createElement('div');
        probe.setAttribute('aria-hidden', 'true');
        probe.style.cssText =
          'position:fixed;top:0;left:0;width:0;height:0;visibility:hidden;pointer-events:none;' +
          'padding:env(safe-area-inset-top,0px) env(safe-area-inset-right,0px) ' +
          'env(safe-area-inset-bottom,0px) env(safe-area-inset-left,0px);';
        document.body.appendChild(probe);
      }
      const s = getComputedStyle(probe);
      return [s.paddingTop, s.paddingRight, s.paddingBottom, s.paddingLeft]
        .map((v) => parseFloat(v) || 0)
        .join(',');
    } catch (_) {
      return '0,0,0,0';
    }
  }

  // Flutter remplace la balise viewport au démarrage : on y remet
  // « viewport-fit=cover », sans quoi l'iPhone ne donne pas ses zones sûres.
  function coverViewport() {
    for (const meta of document.querySelectorAll('meta[name="viewport"]')) {
      const content = meta.getAttribute('content') || '';
      if (!content.includes('viewport-fit')) meta.setAttribute('content', content + ', viewport-fit=cover');
    }
  }
  try {
    new MutationObserver(coverViewport).observe(document.head, { childList: true });
  } catch (_) {}

  function notifyInsets() {
    emit({ type: 'insets', value: insets() });
  }
  window.addEventListener('resize', notifyInsets);
  window.addEventListener('orientationchange', () => setTimeout(notifyInsets, 300));

  // --- Nouvelle version publiée : l'empreinte du build chargé est lue tout
  // de suite (même publication que main.dart.js), puis comparée à celle du
  // site au retour dans l'application et toutes les 30 minutes.
  let loadedBuild = null;
  let announced = false;
  // « ?fresh » : toujours le réseau, même quand l'application a démarré
  // depuis le cache sur une connexion lente (mboa_sw.js) ; sans : la version
  // réellement chargée.
  function shellBuild(fresh) {
    return fetch(fresh ? 'mboa_shell.json?fresh=1' : 'mboa_shell.json', { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : {}))
      .then((j) => j.build || null)
      .catch(() => null);
  }
  shellBuild().then((b) => (loadedBuild = b));
  function checkVersion() {
    if (announced || !loadedBuild || !navigator.onLine) return;
    shellBuild(true).then((b) => {
      if (b && loadedBuild && b !== loadedBuild && !announced) {
        announced = true;
        emit({ type: 'newversion' });
      }
    });
  }
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') checkVersion();
  });
  setInterval(checkVersion, 30 * 60 * 1000);

  // --- Service worker.
  let registration = null;
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.addEventListener('message', (event) => emit(event.data || {}));
    window.addEventListener('load', () => {
      navigator.serviceWorker
        .register('mboa_sw.js')
        .then(async (reg) => {
          registration = reg;
          // Réveil périodique (applications installées, Chrome et Edge) :
          // notifications, pastille et widgets à jour application fermée.
          try {
            if ('periodicSync' in reg && navigator.permissions) {
              const status = await navigator.permissions.query({ name: 'periodic-background-sync' });
              if (status.state === 'granted') {
                await reg.periodicSync.register('mboa-presence', { minInterval: 3600 * 1000 });
              }
            }
          } catch (_) {}
        })
        .catch(() => {});
    });
  }

  async function worker() {
    if (!('serviceWorker' in navigator)) return null;
    const reg = registration || (await navigator.serviceWorker.ready);
    return reg.active || reg.waiting || reg.installing;
  }

  // Après le premier écran : la page retire l'écran de chargement et confie
  // au service worker la liste exacte des fichiers qu'elle a chargés.
  window.addEventListener('flutter-first-frame', () => {
    coverViewport();
    const splash = document.getElementById('mboa-splash');
    if (splash) {
      splash.classList.add('gone');
      setTimeout(() => splash.remove(), 400);
    }
    notifyInsets();
    setTimeout(async () => {
      try {
        const urls = performance.getEntriesByType('resource').map((e) => e.name);
        const sw = await worker();
        if (sw) sw.postMessage({ type: 'warm', urls: [location.href.split('#')[0], ...urls] });
      } catch (_) {}
    }, 4000);
  });

  // --- Web Push (version en ligne seulement) : abonnement de ce navigateur
  // aux rappels envoyés par le serveur MboaLang (lib/core/notifications/web_push.dart).
  function serverKey(base64url) {
    const pad = '='.repeat((4 - (base64url.length % 4)) % 4);
    const raw = atob((base64url + pad).replace(/-/g, '+').replace(/_/g, '/'));
    return Uint8Array.from(raw, (c) => c.charCodeAt(0));
  }

  function sameKey(buffer, key) {
    if (!buffer) return false;
    const a = new Uint8Array(buffer);
    return a.length === key.length && a.every((b, i) => b === key[i]);
  }

  async function pushManager() {
    const reg = registration || (await navigator.serviceWorker.ready);
    return reg.pushManager;
  }

  window.mboaWeb = {
    onMessage(fn) {
      listeners.push(fn);
      while (waiting.length) {
        const text = waiting.shift();
        try {
          fn(text);
        } catch (_) {}
      }
    },
    post(json) {
      worker()
        .then((sw) => sw && sw.postMessage(JSON.parse(json)))
        .catch(() => {});
    },
    standalone,
    platform,
    browser,
    insets,
    canInstall: () => installEvent !== null,
    installed: () => installed || standalone(),
    async install() {
      if (!installEvent) return 'unavailable';
      const event = installEvent;
      installEvent = null;
      try {
        await event.prompt();
        const choice = await event.userChoice;
        return choice && choice.outcome ? choice.outcome : 'dismissed';
      } catch (_) {
        return 'failed';
      }
    },
    canShare: () => typeof navigator.share === 'function',
    async share(json) {
      try {
        await navigator.share(JSON.parse(json));
        return 'shared';
      } catch (error) {
        return error && error.name === 'AbortError' ? 'cancel' : 'failed';
      }
    },
    setIcon(key) {
      const link = document.querySelector('link[rel="icon"]');
      if (link) link.setAttribute('href', 'icons/living/' + key + '.png');
    },
    setLang(code) {
      try {
        document.documentElement.lang = code;
      } catch (_) {}
    },
    reload() {
      location.reload();
    },
    vibrate(ms) {
      try {
        if (navigator.vibrate) navigator.vibrate(ms);
      } catch (_) {}
    },
    // L'iPhone n'offre le push qu'à l'application installée (iOS 16.4+).
    pushSupported: () =>
      'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window,
    /** Abonnement (JSON de PushSubscription) avec la clé du serveur, ou ''. */
    async pushSubscribe(publicKey) {
      try {
        const manager = await pushManager();
        const key = serverKey(publicKey);
        let sub = await manager.getSubscription();
        // Clé du serveur changée : l'ancien abonnement ne servirait plus.
        if (sub && !sameKey(sub.options && sub.options.applicationServerKey, key)) {
          await sub.unsubscribe();
          sub = null;
        }
        if (!sub) sub = await manager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
        return JSON.stringify(sub.toJSON());
      } catch (_) {
        return '';
      }
    },
    /** Désabonne ce navigateur ; renvoie l'adresse quittée, ou ''. */
    async pushUnsubscribe() {
      try {
        const sub = await (await pushManager()).getSubscription();
        if (sub) {
          await sub.unsubscribe();
          return sub.endpoint;
        }
      } catch (_) {}
      return '';
    },
    async persist() {
      try {
        if (navigator.storage && navigator.storage.persist) {
          return (await navigator.storage.persist()) ? 'yes' : 'no';
        }
      } catch (_) {}
      return 'no';
    },
  };
})();
