// Note de prononciation v2 dans le navigateur : le modèle de parole
// (assets/models/mhubert8.onnx, 94 Mo) tourne avec onnxruntime-web, hébergé
// ici même (ort/, rien d'un autre site : CSP). Utilisé par
// lib/core/voice/ssl_web_web.dart.
//
//  • Un seul fil de calcul : GitHub Pages n'envoie pas les en-têtes COOP/COEP
//    qu'exige le multi-thread. Le calcul tourne dans un worker (« proxy ») pour
//    que l'interface reste fluide.
//  • Le modèle n'est téléchargé qu'à la demande, sur un appareil assez
//    puissant, puis gardé dans le cache du navigateur (« mboa-ssl-… », que le
//    service worker ne vide pas) : les fois suivantes, il se charge sans réseau.
//  • Jamais sur iPhone/iPad (mémoire des onglets trop juste) ; partout où ça
//    échoue, l'application garde le moteur classique (v1).
(function () {
  'use strict';

  const base = new URL('./', document.baseURI).href;
  const ORT = base + 'ort/';
  const PREFIX = 'mboa-ssl-';
  // Petit module WebAssembly qui n'est valide qu'avec SIMD (requis par ort).
  const SIMD = new Uint8Array([
    0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0,
    253, 15, 253, 98, 11,
  ]);

  let session = null;
  let ortReady = null;
  let lastMs = 0;

  function platform() {
    const ua = navigator.userAgent || '';
    if (/iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)) return 'ios';
    if (/Android/.test(ua)) return 'android';
    if (/Mobi/.test(ua)) return 'mobile';
    return 'desktop';
  }

  /** '' si l'appareil peut faire tourner le modèle, sinon la raison. */
  function reason() {
    if (platform() === 'ios') return 'ios';
    try {
      if (typeof WebAssembly !== 'object' || !WebAssembly.validate(SIMD)) return 'wasm';
    } catch (_) {
      return 'wasm';
    }
    if (typeof Worker !== 'function' || !('caches' in self)) return 'browser';
    // deviceMemory : Chrome, Edge, Android (arrondi, plafonné à 8) ; absent
    // ailleurs (Firefox, Safari) : on s'en remet au nombre de cœurs.
    const mem = navigator.deviceMemory;
    if (typeof mem === 'number' && mem < 4) return 'memory';
    if ((navigator.hardwareConcurrency || 0) < 4) return 'cpu';
    return '';
  }

  function connection() {
    const c = navigator.connection || {};
    return { saveData: !!c.saveData, type: c.type || '' };
  }

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = src;
      s.async = true;
      s.onload = resolve;
      s.onerror = () => reject(new Error('script ' + src));
      document.head.appendChild(s);
    });
  }

  function ort() {
    return (ortReady ??= (async () => {
      if (!self.ort) await loadScript(ORT + 'ort.wasm.min.js');
      const env = self.ort.env;
      env.wasm.numThreads = 1;
      env.wasm.proxy = true;
      env.wasm.wasmPaths = ORT;
      env.logLevel = 'error';
      return self.ort;
    })().catch((e) => {
      ortReady = null;
      throw e;
    }));
  }

  async function cacheFor(name) {
    try {
      return await caches.open(name);
    } catch (_) {
      return null;
    }
  }

  /** Le modèle : du cache s'il y est, sinon du réseau (puis gardé). */
  async function fetchModel(url, name, progress) {
    const cache = await cacheFor(name);
    let res = cache ? await cache.match(url) : null;
    const cached = !!res;
    if (!res) {
      res = await fetch(url, { cache: 'no-store' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
    }
    const encoded = !!res.headers.get('content-encoding');
    const total = encoded ? 0 : Number(res.headers.get('content-length')) || 0;
    const reader = res.body.getReader();
    let bytes = new Uint8Array(total || 8 << 20);
    let got = 0;
    let tick = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (got + value.length > bytes.length) {
        const grown = new Uint8Array(Math.max(bytes.length * 2, got + value.length));
        grown.set(bytes.subarray(0, got));
        bytes = grown;
      }
      bytes.set(value, got);
      got += value.length;
      const now = performance.now();
      if (now - tick > 150) {
        tick = now;
        progress(got, total);
      }
    }
    if (total && got !== total) throw new Error('incomplet ' + got + '/' + total);
    if (got !== bytes.length) bytes = bytes.slice(0, got);
    progress(got, total || got);
    if (!cached && cache) {
      try {
        await cache.put(
          url,
          new Response(bytes, {
            headers: { 'content-type': 'application/octet-stream', 'content-length': String(got) },
          }),
        );
      } catch (_) {
        // Quota dépassé : le modèle servira pour cette visite seulement.
      }
    }
    return { bytes, cached };
  }

  async function dropOthers(keep) {
    try {
      for (const key of await caches.keys()) {
        if (key.startsWith(PREFIX) && key !== keep) await caches.delete(key);
      }
    } catch (_) {}
  }

  window.mboaSsl = {
    /** JSON : { reason, platform, saveData, type, cached, quota } */
    async check(url, name) {
      const c = connection();
      let cached = false;
      let quota = -1;
      try {
        // caches.open() créerait un cache vide : on regarde d'abord.
        if (await caches.has(name)) {
          const cache = await caches.open(name);
          cached = !!(await cache.match(new URL(url, base).href));
        }
      } catch (_) {}
      try {
        if (navigator.storage && navigator.storage.estimate) {
          const e = await navigator.storage.estimate();
          quota = Math.max(0, (e.quota || 0) - (e.usage || 0));
        }
      } catch (_) {}
      return JSON.stringify({
        reason: reason(),
        platform: platform(),
        saveData: c.saveData,
        type: c.type,
        cached,
        quota,
        loaded: !!session,
      });
    },

    /** Charge le modèle. progress(reçus, total) ; renvoie 'ok' ou l'erreur. */
    async load(url, name, progress) {
      if (session) return 'ok';
      const why = reason();
      if (why) return 'refused:' + why;
      const abs = new URL(url, base).href;
      try {
        const lib = await ort();
        await dropOthers(name);
        for (let attempt = 0; attempt < 2; attempt++) {
          const { bytes, cached } = await fetchModel(abs, name, (a, b) => {
            try {
              progress(a, b);
            } catch (_) {}
          });
          try {
            session = await lib.InferenceSession.create(bytes, {
              executionProviders: ['wasm'],
              graphOptimizationLevel: 'all',
            });
            break;
          } catch (e) {
            // Copie abîmée dans le cache : on la jette et on retélécharge.
            if (!cached || attempt) throw e;
            try {
              await caches.delete(name);
            } catch (_) {}
          }
        }
        if (navigator.storage && navigator.storage.persist) {
          navigator.storage.persist().catch(() => {});
        }
        return 'ok';
      } catch (e) {
        session = null;
        return 'error:' + (e && e.message ? e.message : e);
      }
    },

    loaded() {
      return !!session;
    },

    /** Voix normalisée (16 kHz) -> trames du modèle, à plat [trames × 768]. */
    async run(wav) {
      if (!session) throw new Error('modèle absent');
      const lib = self.ort;
      const t = performance.now();
      const input = new lib.Tensor('float32', wav, [1, wav.length]);
      const out = await session.run({ [session.inputNames[0]]: input });
      const y = out[session.outputNames[0]];
      lastMs = performance.now() - t;
      this.mark('model', lastMs);
      return y.data;
    },

    lastMs() {
      return lastMs;
    },

    /** Durées mesurées (ms), pour les essais : { model: [...], score: [...] }. */
    times: { model: [], score: [] },

    mark(key, ms) {
      const list = (this.times[key] ||= []);
      list.push(Math.round(ms));
      if (list.length > 50) list.shift();
    },

    /** Libère la mémoire et retire du cache le modèle et son moteur. */
    async remove() {
      const s = session;
      session = null;
      try {
        if (s) await s.release();
      } catch (_) {}
      await dropOthers('');
      try {
        for (const key of await caches.keys()) {
          if (key.startsWith('mboa-ort-')) await caches.delete(key);
        }
      } catch (_) {}
      return 'ok';
    },
  };
})();
