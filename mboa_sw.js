// Service worker de MboaLang : ce qui fait de la version web une vraie
// application, y compris quand elle est fermée.
//
//  Hors-ligne
//  • le moteur de l'application (mboa_shell.json) est mis en cache dès la
//    première visite, SANS le superflu (modèle vocal du téléphone, variante du
//    moteur graphique non utilisée, musiques) ;
//  • les parcours de toutes les langues, puis les leçons de la langue apprise ;
//  • les enregistrements audio : dès qu'ils ont été entendus une fois, ou
//    tous ceux d'une langue à la demande (« Disponible hors-ligne ») ;
//  • tout le reste : réseau d'abord, cache en secours sans réseau ; sur une
//    connexion trop lente (page sans réponse en 4 s), l'application démarre
//    entièrement depuis le cache, comme une application installée.
//    Les appels au serveur (/v1/) ne sont jamais mis en cache.
//  • note de prononciation v2 (ort/mboa_ssl.js) : le moteur onnxruntime-web
//    (ort/, 14 Mo) n'est demandé que sur un appareil qui s'en sert, puis
//    servi d'ici (cache « mboa-ort-<version> ») ; le modèle (94 Mo) est gardé
//    par la page elle-même dans « mboa-ssl-… ». Aucun des deux n'est
//    préchargé, ni effacé à une mise à jour de l'application.
//
//  Notifications (mêmes textes et mêmes dessins que sur Android)
//  • le programme calculé par l'application (notif_planner.dart) est gardé
//    ici ; chaque message part à son heure tant que l'application est ouverte
//    ou en arrière-plan, et au réveil suivant sinon (synchronisation
//    périodique des applications installées) ;
//  • version en ligne (avec compte) : le serveur envoie aussi chaque message
//    à son heure par Web Push, application fermée (iPhone installé compris) ;
//    un message déjà montré par le programme local n'est pas répété ;
//  • grande illustration de l'humeur de Nsangou, compte à rebours jusqu'à
//    minuit, flamme et jours de série ; boutons « C'est parti » et
//    « Plus tard (1 h) ».
//
//  Écran d'accueil
//  • pastille de l'icône (Badging API) : les jours de série en jeu ;
//  • widgets du tableau de widgets de Windows (Edge) : Nsangou, Ma semaine,
//    Mon mot, d'après la frise heure par heure calculée par l'application.
const CACHE = 'mboalang-v2';
const MEDIA = '/assets/assets/content/media/';
const INDEX = 'assets/assets/content/index.json';
const GRACE = 3 * 3600e3; // un message manqué de plus de 3 h n'a plus de sens
// Changer avec la version d'onnxruntime-web (tools/web-ort.sh).
const ORT_CACHE = 'mboa-ort-1.30.0';
const ORT_FILE = /\/ort\/(ort\.wasm\.min\.js|ort-wasm-[^/]+\.(mjs|wasm))$/;

/** Adresse complète d'un fichier du site. */
const at = (path) =>
  new URL(path, self.registration ? self.registration.scope : self.location.href).href;

// ---------------------------------------------------------------------------
// Petite base clé → valeur (IndexedDB) : programme, frise, état.
// ---------------------------------------------------------------------------
function db() {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open('mboa_sw', 1);
    open.onupgradeneeded = () => open.result.createObjectStore('kv');
    open.onsuccess = () => resolve(open.result);
    open.onerror = () => reject(open.error);
  });
}

async function kvGet(key, fallback) {
  try {
    const base = await db();
    return await new Promise((resolve) => {
      const req = base.transaction('kv').objectStore('kv').get(key);
      req.onsuccess = () => resolve(req.result === undefined ? fallback : req.result);
      req.onerror = () => resolve(fallback);
    });
  } catch (_) {
    return fallback;
  }
}

async function kvSet(key, value) {
  try {
    const base = await db();
    await new Promise((resolve) => {
      const tx = base.transaction('kv', 'readwrite');
      tx.objectStore('kv').put(value, key);
      tx.oncomplete = resolve;
      tx.onerror = resolve;
    });
  } catch (_) {}
}

// ---------------------------------------------------------------------------
// Installation, mise à jour, hors-ligne.
// ---------------------------------------------------------------------------
self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      for (const key of await caches.keys()) {
        if (key === CACHE || !key.startsWith('mboalang-')) continue;
        // Ancienne version : on garde les leçons et les audios déjà là,
        // jamais le modèle vocal du téléphone (inutile sur le web).
        try {
          const old = await caches.open(key);
          for (const req of await old.keys()) {
            if (!req.url.includes('/assets/assets/content/')) continue;
            const res = await old.match(req);
            if (res) await cache.put(req, res);
          }
        } catch (_) {}
        await caches.delete(key);
      }
      for (const key of await caches.keys()) {
        if (key.startsWith('mboa-ort-') && key !== ORT_CACHE) await caches.delete(key);
      }
      await self.clients.claim();
      // Première visite : on attend que l'application ait affiché son premier
      // écran (message « warm ») pour ne pas lui disputer la connexion.
      // Mise à jour : l'application est déjà là, on complète tout de suite.
      if (await kvGet('shellDone', 0)) precache();
    })(),
  );
});

let precaching = null;

/** Ce dont l'application a besoin pour démarrer, puis les leçons (une seule
 *  passe à la fois). */
function precache() {
  if (!precaching) precaching = runPrecache().finally(() => (precaching = null));
  return precaching;
}

async function runPrecache() {
  try {
    const cache = await caches.open(CACHE);
    let shell = ['index.html', 'main.dart.js', 'flutter_bootstrap.js', 'manifest.json'];
    let later = [];
    try {
      const listed = await fetch('mboa_shell.json', { cache: 'no-store' });
      if (listed.ok) {
        const json = await listed.json();
        shell = json.files || shell;
        later = json.later || [];
      }
    } catch (_) {}
    await addAll(cache, ['./', ...shell]);
    await kvSet('shellDone', Date.now());
    const lang = await kvGet('lang', null);
    await precacheLessons(lang);
    // Bruitages et musiques : après les leçons, ils ne bloquent rien.
    await addAll(cache, later);
  } catch (_) {
    // Hors-ligne : on réessaiera à la prochaine activation.
  }
}

async function addAll(cache, urls) {
  for (let i = 0; i < urls.length; i += 12) {
    await Promise.allSettled(
      urls.slice(i, i + 12).map(async (url) => {
        if (!(await cache.match(url))) await cache.add(url);
      }),
    );
  }
}

/** Parcours de toutes les langues ; leçons de la langue apprise seulement. */
async function precacheLessons(lang) {
  try {
    const cache = await caches.open(CACHE);
    const res = await fetch(INDEX);
    if (!res.ok) return;
    await cache.put(INDEX, res.clone());
    const index = await res.json();
    const packs = lang
      ? (index.packs || []).filter((p) => p.includes(`/packs/${lang}-`))
      : [];
    await addAll(cache, [...(index.paths || []), ...packs].map((f) => 'assets/' + f));
    if (lang) await kvSet('lessonsLang', lang);
  } catch (_) {}
}

/** Tous les audios (et la banque de voix) d'une langue, avec progression. */
async function cacheLanguage(lang, client) {
  const cache = await caches.open(CACHE);
  let list = [];
  try {
    const res = await fetch('mboa_media.json', { cache: 'no-store' });
    const media = res.ok ? await res.json() : {};
    list = (media[lang] && media[lang].files) || [];
  } catch (_) {}
  await precacheLessons(lang);
  let done = 0;
  let failed = 0;
  const total = list.length;
  const report = (final) =>
    client &&
    client.postMessage({ type: 'offline-progress', lang, done, total, failed, final });
  for (let i = 0; i < list.length; i += 8) {
    const results = await Promise.allSettled(
      list.slice(i, i + 8).map(async (url) => {
        if (!(await cache.match(url))) await cache.add(url);
      }),
    );
    for (const r of results) r.status === 'fulfilled' ? done++ : failed++;
    report(false);
  }
  if (failed === 0 && total > 0) {
    const ready = await kvGet('offlineLangs', []);
    if (!ready.includes(lang)) await kvSet('offlineLangs', [...ready, lang]);
  }
  report(true);
}

async function languageState(lang) {
  let total = 0;
  let cached = 0;
  try {
    const res = await fetch('mboa_media.json');
    const media = res.ok ? await res.json() : {};
    const list = (media[lang] && media[lang].files) || [];
    total = list.length;
    const cache = await caches.open(CACHE);
    for (const url of list) if (await cache.match(url)) cached++;
    return { total, cached, bytes: (media[lang] && media[lang].bytes) || 0 };
  } catch (_) {
    return { total, cached, bytes: 0 };
  }
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.includes('/v1/')) return;
  // Empreinte de la version en ligne : le réseau seul, jamais gardée.
  if (url.search.includes('fresh')) return;
  // Modèle vocal du téléphone : jamais servi ni gardé par le web.
  if (url.pathname.includes('/assets/assets/models/')) return;
  if (ORT_FILE.test(url.pathname)) {
    event.respondWith(ortFirst(request));
    return;
  }
  if (url.pathname.includes(MEDIA)) {
    event.respondWith(mediaFirst(request));
  } else if (request.mode === 'navigate') {
    event.respondWith(openApp(request, event.resultingClientId));
  } else if (slowClients.has(event.clientId)) {
    event.respondWith(cacheFirst(request));
  } else {
    event.respondWith(networkFirst(request));
  }
});

// Connexion lente (2G, réseau saturé) : une application installée démarre
// sans attendre. Si la page ne répond pas en 4 s et qu'une copie existe,
// l'application s'ouvre depuis le cache, et TOUT ce que cette page demande
// ensuite vient du cache (jamais un mélange de deux versions) ; la version
// en ligne est reprise au lancement suivant, ou par le bandeau « nouvelle
// version » (mboa_web.js compare l'empreinte avec « mboa_shell.json?fresh »).
const SLOW_START = 4000;
const slowClients = new Set();

async function openApp(request, clientId) {
  const cache = await caches.open(CACHE);
  const cached =
    (await cache.match(request, { ignoreSearch: true })) ||
    (await cache.match('./')) ||
    (await cache.match('index.html'));
  if (!cached || !(await kvGet('shellDone', 0))) return networkFirst(request);
  let late = false;
  const online = fetch(request)
    .then((response) => {
      if (!late && response.ok && response.status === 200) cache.put(request, response.clone());
      return response;
    })
    .catch(() => null);
  const timer = new Promise((resolve) => setTimeout(() => resolve('slow'), SLOW_START));
  const first = await Promise.race([online, timer]);
  if (first && first !== 'slow') return first;
  late = true;
  if (clientId) slowClients.add(clientId);
  return cached;
}

async function cacheFirst(request) {
  const cached = await (await caches.open(CACHE)).match(request, { ignoreSearch: true });
  return cached || networkFirst(request);
}

async function networkFirst(request) {
  const cache = await caches.open(CACHE);
  try {
    const response = await fetch(request);
    if (response.ok && response.status === 200) cache.put(request, response.clone());
    return response;
  } catch (error) {
    const cached = await cache.match(request, { ignoreSearch: true });
    if (cached) return cached;
    // Ouverture hors-ligne par une adresse inconnue (raccourci, notification) :
    // l'application elle-même, qui choisira l'écran.
    if (request.mode === 'navigate') {
      const shell = (await cache.match('./')) || (await cache.match('index.html'));
      if (shell) return shell;
    }
    throw error;
  }
}

/** Moteur onnxruntime-web : cache d'abord (fichiers figés par version). */
async function ortFirst(request) {
  const cache = await caches.open(ORT_CACHE);
  const cached = await cache.match(request, { ignoreSearch: true });
  if (cached) return cached;
  const response = await fetch(request);
  if (response.ok && response.status === 200) {
    try {
      await cache.put(request, response.clone());
    } catch (_) {}
  }
  return response;
}

/** Audio : cache d'abord. Les lecteurs demandent des plages d'octets (Range) ;
 *  le cache ne garde que des réponses complètes, on découpe donc ici. */
async function mediaFirst(request) {
  const cache = await caches.open(CACHE);
  const key = request.url;
  let full = await cache.match(key);
  if (!full) {
    const response = await fetch(key);
    if (!response.ok || response.status !== 200) return response;
    await cache.put(key, response.clone());
    full = response;
  }
  const range = request.headers.get('range');
  if (!range) return full;

  const bytes = await full.arrayBuffer();
  const match = /bytes=(\d*)-(\d*)/.exec(range);
  const size = bytes.byteLength;
  let start = match && match[1] ? Number(match[1]) : 0;
  let end = match && match[2] ? Number(match[2]) : size - 1;
  if (match && !match[1] && match[2]) {
    start = Math.max(0, size - Number(match[2]));
    end = size - 1;
  }
  end = Math.min(end, size - 1);
  if (start > end) {
    return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } });
  }
  return new Response(bytes.slice(start, end + 1), {
    status: 206,
    headers: {
      'Content-Type': full.headers.get('Content-Type') || 'audio/mpeg',
      'Content-Range': `bytes ${start}-${end}/${size}`,
      'Content-Length': String(end - start + 1),
      'Accept-Ranges': 'bytes',
    },
  });
}

// ---------------------------------------------------------------------------
// Messages de l'application.
// ---------------------------------------------------------------------------
self.addEventListener('message', (event) => {
  const msg = event.data || {};
  const client = event.source;
  const reply = (data) => client && client.postMessage(data);
  const job = (async () => {
    switch (msg.type) {
      case 'plan':
        await kvSet('plan', msg.plan || []);
        await kvSet('snoozed', []);
        await checkDue();
        break;
      case 'cancel':
        await kvSet('plan', []);
        await kvSet('snoozed', []);
        break;
      case 'push-config':
        // Version en ligne : adresse du serveur, abonnement, clé (ou null).
        await kvSet('push', msg.config || null);
        break;
      case 'show':
        if (msg.entry) await show(msg.entry);
        break;
      case 'tick':
        await checkDue();
        await refreshPresence();
        // Premier passage pas encore fini (réseau coupé, onglet fermé) : on
        // reprend.
        if (!(await kvGet('shellDone', 0))) await precache();
        break;
      case 'pending': {
        const now = Date.now();
        const plan = await kvGet('plan', []);
        reply({ type: 'pending', count: plan.filter((e) => e.when > now).length });
        break;
      }
      case 'presence': {
        await kvSet('timeline', msg.timeline || []);
        if (msg.lang) {
          const before = await kvGet('lang', null);
          await kvSet('lang', msg.lang);
          if (before !== msg.lang || (await kvGet('lessonsLang', null)) !== msg.lang) {
            // Nouvelle langue : ses leçons, en arrière-plan.
            precacheLessons(msg.lang);
          }
        }
        await refreshPresence(true);
        break;
      }
      case 'warm': {
        // Fichiers réellement chargés par cette page (dont la variante du
        // moteur graphique propre à ce navigateur) : gardés pour hors-ligne.
        const cache = await caches.open(CACHE);
        const urls = (msg.urls || []).filter((u) => {
          try {
            const url = new URL(u);
            return url.origin === self.location.origin &&
              !url.pathname.includes('/v1/') &&
              !url.search.includes('fresh') &&
              !url.pathname.includes('/assets/assets/models/') &&
              !ORT_FILE.test(url.pathname);
          } catch (_) {
            return false;
          }
        });
        await addAll(cache, urls);
        // Premier écran affiché : le reste peut venir.
        await precache();
        break;
      }
      case 'offline':
        await cacheLanguage(msg.lang, client);
        break;
      case 'offline-state':
        reply({ type: 'offline-state', lang: msg.lang, ...(await languageState(msg.lang)) });
        break;
      case 'status':
        reply({
          type: 'status',
          shell: await kvGet('shellDone', 0),
          lessons: await kvGet('lessonsLang', null),
          offline: await kvGet('offlineLangs', []),
        });
        break;
    }
  })();
  if (event.waitUntil) event.waitUntil(job);
});

// ---------------------------------------------------------------------------
// Notifications.
// ---------------------------------------------------------------------------
async function checkDue() {
  const now = Date.now();
  const plan = await kvGet('plan', []);
  const snoozed = await kvGet('snoozed', []);
  const shown = await kvGet('shown', {});
  let changed = false;
  for (const e of [...plan, ...snoozed]) {
    const key = `${e.id}@${e.when}`;
    if (e.when > now || shown[key]) continue;
    shown[key] = now;
    changed = true;
    if (now - e.when > GRACE) continue; // trop tard : on ne dérange pas pour rien
    if (e.deadline && e.deadline <= now) continue; // la série s'est jouée
    await show(e);
  }
  // Oubli des messages de plus de deux jours.
  for (const key of Object.keys(shown)) {
    if (now - shown[key] > 2 * 86400e3) {
      delete shown[key];
      changed = true;
    }
  }
  if (changed) await kvSet('shown', shown);
}

const LABELS = {
  fr: { go: 'C’est parti', later: 'Plus tard (1 h)', before: 'avant minuit', days: (n) => (n > 1 ? `${n} jours de série` : '1 jour de série'), daysShort: (n) => (n > 1 ? 'jours de série' : 'jour de série') },
  en: { go: 'Let’s go', later: 'Later (1 h)', before: 'before midnight', days: (n) => (n > 1 ? `${n}-day streak` : '1-day streak'), daysShort: () => 'day streak' },
};

/** Ce que dit Nsangou dans la bulle (NotifArt.kt). */
const CHEER = {
  fr: { neutral: 'Mbɔ́lɔ́ !', joy: 'Bravo !', love: 'Fier de toi !', sad: 'Tu me manques…', sleepy: 'Psst…', angry: 'On y va ?', fire: 'Vite !' },
  en: { neutral: 'Mbɔ́lɔ́!', joy: 'Well done!', love: 'So proud!', sad: 'I miss you…', sleepy: 'Psst…', angry: 'Shall we?', fire: 'Hurry!' },
};

const ACCENT = {
  neutral: '#1E8E4E', joy: '#F2A100', love: '#E2457E', sad: '#5B4BB7',
  sleepy: '#2D3A78', angry: '#B3261E', fire: '#F26B1D',
};

/** [quiet] : remplace la notification affichée à l'identique, sans bruit. */
async function show(e, quiet) {
  const fr = e.fr !== false;
  const l = fr ? LABELS.fr : LABELS.en;
  const art = ACCENT[e.art] ? e.art : 'neutral';
  let image = `notif/${art}_right.webp`;
  try {
    image = (await banner(e, art, fr)) || image;
  } catch (_) {}
  const options = {
    body: e.body,
    tag: `mboa-${e.group || 'reminders'}`,
    renotify: !quiet,
    silent: !!quiet,
    icon: `notif/${art}_avatar.png`,
    badge: 'icons/badge-96.png',
    image,
    lang: fr ? 'fr' : 'en',
    timestamp: e.deadline && e.deadline > Date.now() ? e.deadline : e.when || Date.now(),
    data: { route: e.route || '/home', entry: e },
    actions: [
      { action: 'go', title: l.go },
      { action: 'later', title: l.later },
    ],
  };
  try {
    await self.registration.showNotification(e.title, options);
  } catch (_) {
    // Navigateur sans boutons ni image : la version simple.
    try {
      await self.registration.showNotification(e.title, {
        body: e.body,
        tag: options.tag,
        icon: options.icon,
        data: options.data,
      });
    } catch (_) {}
  }
}

let fontReady = null;
function displayFont() {
  if (!fontReady) {
    fontReady = (async () => {
      try {
        if (typeof FontFace === 'undefined' || !self.fonts) return 'sans-serif';
        const face = new FontFace('MboaDisplay', `url(${at('assets/assets/fonts/BricolageGrotesque.ttf')})`, { weight: '800' });
        await face.load();
        self.fonts.add(face);
        return 'MboaDisplay';
      } catch (_) {
        return 'sans-serif';
      }
    })();
  }
  return fontReady;
}

async function bitmap(path) {
  const url = at(path);
  const cache = await caches.open(CACHE);
  let res = await cache.match(url);
  if (!res) {
    res = await fetch(url);
    if (res.ok) cache.put(url, res.clone());
  }
  return createImageBitmap(await res.blob());
}

const FLAME_OUTER = 'M12,2C12,2 19,8.5 19,14A7,7 0,0 1,5 14C5,10.5 7.5,8 7.5,8C7.5,10.5 9,12 10.5,12C10.5,7 12,2 12,2Z';
const FLAME_INNER = 'M12,11C12,11 15.5,14.2 15.5,16.5A3.5,3.5 0,0 1,8.5 16.5C8.5,14.6 12,11 12,11Z';

function flame(g, x, top, size) {
  if (typeof Path2D === 'undefined') return;
  g.save();
  g.translate(x, top);
  g.scale(size / 24, size / 24);
  g.fillStyle = '#FFB74D';
  g.fill(new Path2D(FLAME_OUTER));
  g.fillStyle = '#FFF3C4';
  g.fill(new Path2D(FLAME_INNER));
  g.restore();
}

/** Grande illustration 2:1, comme NotifArt.banner : compte à rebours avant
 *  minuit quand la série se joue, sinon la série, sinon une bulle. */
async function banner(e, art, fr) {
  if (typeof OffscreenCanvas === 'undefined') return null;
  const w = 720;
  const h = 360;
  const canvas = new OffscreenCanvas(w, h);
  const g = canvas.getContext('2d');
  if (!g) return null;
  g.drawImage(await bitmap(`notif/${art}_right.webp`), 0, 0, w, h);
  const family = await displayFont();
  const l = fr ? LABELS.fr : LABELS.en;
  const left = w * 0.07;
  g.fillStyle = '#FFFFFF';
  g.shadowColor = 'rgba(0,0,0,0.28)';
  g.shadowBlur = h * 0.02;
  g.shadowOffsetY = h * 0.008;
  const remaining = (e.deadline || 0) - Date.now();
  const streak = e.streak || 0;
  if (e.deadline && remaining > 0) {
    const hours = Math.floor(remaining / 3600e3);
    const minutes = Math.floor(remaining / 60e3) % 60;
    g.font = `800 ${h * 0.3}px ${family}`;
    g.fillText(hours > 0 ? `${hours} h ${String(minutes).padStart(2, '0')}` : `${minutes} min`, left, h * 0.5);
    g.font = `800 ${h * 0.095}px ${family}`;
    g.fillStyle = 'rgba(255,255,255,0.92)';
    g.fillText(l.before, left, h * 0.66);
    if (streak > 0) {
      flame(g, left, h * 0.83 - h * 0.13 * 0.85, h * 0.13);
      g.fillStyle = '#FFFFFF';
      g.font = `800 ${h * 0.1}px ${family}`;
      g.fillText(l.days(streak), left + h * 0.13 * 1.05, h * 0.83);
    }
  } else if (streak > 0) {
    const size = h * 0.3;
    flame(g, left, h * 0.6 - size * 0.92, size);
    g.font = `800 ${h * 0.34}px ${family}`;
    g.fillText(String(streak), left + size * 1.05, h * 0.6);
    g.font = `800 ${h * 0.1}px ${family}`;
    g.fillStyle = 'rgba(255,255,255,0.92)';
    g.fillText(l.daysShort(streak), left, h * 0.77);
  } else {
    const say = (fr ? CHEER.fr : CHEER.en)[art] || CHEER.fr.neutral;
    g.font = `800 ${h * 0.17}px ${family}`;
    const tw = g.measureText(say).width;
    const pad = h * 0.07;
    const bw = tw + pad * 2;
    const bx = Math.min(left, w * 0.76 - h * 0.3 - bw);
    const top = h * 0.24;
    const bh = h * 0.17 + pad * 1.6;
    g.shadowColor = 'transparent';
    g.fillStyle = '#FFFFFF';
    g.beginPath();
    if (g.roundRect) g.roundRect(bx, top, bw, bh, h * 0.08);
    else g.rect(bx, top, bw, bh);
    g.fill();
    g.beginPath();
    g.moveTo(bx + bw - h * 0.1, top + bh - 1);
    g.lineTo(bx + bw + h * 0.06, top + bh + h * 0.08);
    g.lineTo(bx + bw - h * 0.22, top + bh - 1);
    g.closePath();
    g.fill();
    g.fillStyle = ACCENT[art];
    g.fillText(say, bx + pad, top + bh - pad * 0.95);
  }
  const blob = await canvas.convertToBlob({ type: 'image/webp', quality: 0.86 });
  return dataUrl(blob);
}

async function dataUrl(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return `data:${blob.type};base64,${btoa(bin)}`;
}

self.addEventListener('notificationclick', (event) => {
  const n = event.notification;
  const data = n.data || {};
  n.close();
  if (event.action === 'later') {
    event.waitUntil(snooze(data.entry));
    return;
  }
  event.waitUntil(openRoute(data.route || '/home'));
});

/** « Plus tard » : le même message revient dans une heure. */
async function snooze(entry) {
  if (!entry) return;
  const later = { ...entry, when: Date.now() + 3600e3 };
  const snoozed = (await kvGet('snoozed', [])).filter((e) => e.id !== entry.id);
  snoozed.push(later);
  await kvSet('snoozed', snoozed);
  // Version en ligne : le serveur le renverra à l'heure, même application
  // fermée (même heure ici et là-bas : un seul affichage).
  const push = await kvGet('push', null);
  if (push && push.api && push.endpoint) {
    try {
      await fetch(`${push.api}/push/snooze`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ endpoint: push.endpoint, entry: later }),
      });
    } catch (_) {}
  }
}

/** Ouvre l'application sur [route], ou la ramène au premier plan. */
async function openRoute(route) {
  const scope = self.registration.scope;
  const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  for (const c of windows) {
    if (!c.url.startsWith(scope)) continue;
    try {
      await c.focus();
    } catch (_) {}
    c.postMessage({ type: 'open', route });
    return;
  }
  await self.clients.openWindow(`${scope}#${route}`);
}

// Notification « push » du serveur MboaLang (version en ligne, voir
// backend/src/modules/push) : une entrée du programme, envoyée à son heure
// même application fermée, affichée avec les mêmes dessins. Sans contenu :
// simple réveil.
self.addEventListener('push', (event) => {
  let data = null;
  try {
    data = event.data ? event.data.json() : null;
  } catch (_) {}
  event.waitUntil(
    (async () => {
      if (data && data.title) await showPushed({ when: Date.now(), ...data });
      await wake();
    })(),
  );
});

/** Message du serveur, sauf s'il est déjà parti du programme local
 *  (application ouverte) : même clé « id@heure » des deux côtés. */
async function showPushed(e) {
  const shown = await kvGet('shown', {});
  const key = `${e.id}@${e.when}`;
  if (shown[key]) {
    // Chrome veut une notification par push : si la précédente est encore
    // là, on la redonne à l'identique, sans bruit ; sinon rien.
    try {
      const open = await self.registration.getNotifications({ tag: `mboa-${e.group || 'reminders'}` });
      if (open.length) await show(e, true);
    } catch (_) {}
    return;
  }
  shown[key] = Date.now();
  await kvSet('shown', shown);
  await show(e);
}

// Le navigateur a renouvelé l'abonnement push : le serveur garde le compte
// et le programme, avec la nouvelle adresse.
self.addEventListener('pushsubscriptionchange', (event) => {
  event.waitUntil(
    (async () => {
      const push = await kvGet('push', null);
      if (!push || !push.api || !push.key) return;
      try {
        let sub = event.newSubscription;
        if (!sub) {
          const pad = '='.repeat((4 - (push.key.length % 4)) % 4);
          const raw = atob((push.key + pad).replace(/-/g, '+').replace(/_/g, '/'));
          sub = await self.registration.pushManager.subscribe({
            userVisibleOnly: true,
            applicationServerKey: Uint8Array.from(raw, (c) => c.charCodeAt(0)),
          });
        }
        const oldEndpoint = (event.oldSubscription && event.oldSubscription.endpoint) || push.endpoint;
        await fetch(`${push.api}/push/renew`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ oldEndpoint, subscription: sub.toJSON() }),
        });
        await kvSet('push', { ...push, endpoint: sub.endpoint });
      } catch (_) {}
    })(),
  );
});

// Réveil périodique des applications installées (Chrome, Edge) : messages en
// retard, pastille et widgets à jour même application fermée.
self.addEventListener('periodicsync', (event) => {
  event.waitUntil(wake());
});

async function wake() {
  await checkDue();
  await refreshPresence(true);
}

// ---------------------------------------------------------------------------
// Pastille et widgets (Windows).
// ---------------------------------------------------------------------------
async function presenceNow() {
  const timeline = await kvGet('timeline', []);
  if (!timeline.length) return null;
  const now = Date.now();
  let current = timeline[0];
  for (const entry of timeline) {
    if (entry.at <= now) current = entry;
    else break;
  }
  return current;
}

/** [force] : redessine les widgets même si l'heure n'a pas changé. */
async function refreshPresence(force) {
  const p = await presenceNow();
  if (!p) return;
  try {
    const nav = self.navigator;
    if (nav && nav.setAppBadge) {
      if (p.badge > 0) await nav.setAppBadge(p.badge);
      else await nav.clearAppBadge();
    }
  } catch (_) {}
  const key = `${p.at}:${p.mood}:${p.headline}:${p.message}`;
  if (!force && (await kvGet('widgetKey', '')) === key) return;
  await kvSet('widgetKey', key);
  await updateWidgets(p);
}

const WIDGETS = ['nsangou', 'week', 'word'];

function widgetData(tag, p) {
  const scope = self.registration.scope;
  const goal = p.goal > 0 && p.mood !== 'asleep';
  return {
    tag,
    image: `${scope}notif/${p.art}_left.jpg`,
    imageRight: `${scope}notif/${p.art}_right.jpg`,
    headline: tag === 'word' && p.term ? p.term : p.headline,
    message: tag === 'word' ? p.prompt : p.message,
    meaning: p.meaning,
    goal: goal ? `${Math.min(p.xp, p.goal)} / ${p.goal} XP` : '',
    week: (p.days || []).map((d, i) => ({
      d,
      s: p.week && p.week[i] ? '●' : i === p.today ? '◌' : '○',
    })),
    open: p.fr ? 'Ouvrir MboaLang' : 'Open MboaLang',
  };
}

async function updateWidgets(p) {
  if (!self.widgets || !self.widgets.getByTag) return;
  for (const tag of WIDGETS) {
    try {
      const widget = await self.widgets.getByTag(tag);
      if (widget) await renderWidget(widget, p);
    } catch (_) {}
  }
}

async function renderWidget(widget, p) {
  p = p || (await presenceNow());
  const def = widget.definition || {};
  const tag = def.tag || 'nsangou';
  const res = await fetch(def.msAcTemplate || `widgets/${tag}.json`);
  const template = await res.text();
  // Application jamais ouverte depuis l'installation : Nsangou accueille.
  const data = widgetData(tag, p || {
    art: 'neutral', mood: 'fresh', fr: true, goal: 0, xp: 0, days: [], week: [],
    headline: 'MboaLang',
    message: 'Ouvre MboaLang une fois : Nsangou suivra ensuite ta journée ici.',
    prompt: 'Ouvre MboaLang une fois : Nsangou suivra ensuite ta journée ici.',
    meaning: 'Tes mots appris apparaîtront ici.',
  });
  await self.widgets.updateByTag(tag, { template, data: JSON.stringify(data) });
}

self.addEventListener('widgetinstall', (event) => {
  event.waitUntil(renderWidget(event.widget));
});

self.addEventListener('widgetresume', (event) => {
  event.waitUntil(renderWidget(event.widget));
});

self.addEventListener('widgetclick', (event) => {
  const def = (event.widget && event.widget.definition) || {};
  event.waitUntil(openRoute(def.tag === 'word' ? '/words' : '/home'));
});
