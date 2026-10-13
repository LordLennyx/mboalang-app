// Service worker de MboaLang : rend l'application web utilisable hors-ligne
// une fois installée sur l'écran d'accueil (iPhone compris).
//
//  • enregistrements audio des leçons : servis depuis le cache dès qu'ils ont
//    été entendus une fois (fichiers immuables) ;
//  • tout le reste : réseau d'abord (toujours la dernière version en ligne),
//    cache en secours quand il n'y a pas de réseau ;
//  • à l'installation, les parcours et les leçons (texte) sont mis en cache en
//    arrière-plan, pour que chaque leçon s'ouvre sans réseau.
//
// Les appels au serveur (/v1/) ne sont jamais mis en cache.
const CACHE = 'mboalang-v1';
const MEDIA = '/assets/assets/content/media/';
const INDEX = 'assets/assets/content/index.json';

self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      for (const key of await caches.keys()) {
        if (key !== CACHE && key.startsWith('mboalang-')) await caches.delete(key);
      }
      await self.clients.claim();
      precacheLessons();
    })(),
  );
});

/** Met en cache parcours et leçons, par petits lots, sans bloquer l'application. */
async function precacheLessons() {
  try {
    const cache = await caches.open(CACHE);
    // Moteur de l'application : liste complète si le build la fournit
    // (tools/web-shell-index.js), sinon le strict minimum.
    let shell = ['index.html', 'main.dart.js', 'flutter_bootstrap.js', 'manifest.json'];
    try {
      const listed = await fetch('mboa_shell.json');
      if (listed.ok) shell = (await listed.json()).files || shell;
    } catch (_) {
      // Pas de liste : on garde le minimum.
    }
    await Promise.allSettled(['./', ...shell].map((url) => cache.add(url)));
    const res = await fetch(INDEX);
    if (!res.ok) return;
    await cache.put(INDEX, res.clone());
    const index = await res.json();
    const files = [...(index.paths || []), ...(index.packs || [])];
    for (let i = 0; i < files.length; i += 20) {
      const batch = files.slice(i, i + 20).map((f) => 'assets/' + f);
      await Promise.allSettled(
        batch.map(async (url) => {
          if (!(await cache.match(url))) await cache.add(url);
        }),
      );
    }
  } catch (_) {
    // Hors-ligne ou index absent : on réessaiera à la prochaine activation.
  }
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.includes('/v1/')) return;
  event.respondWith(
    url.pathname.includes(MEDIA) ? mediaFirst(request) : networkFirst(request),
  );
});

async function networkFirst(request) {
  const cache = await caches.open(CACHE);
  try {
    const response = await fetch(request);
    if (response.ok && response.status === 200) cache.put(request, response.clone());
    return response;
  } catch (error) {
    const cached = await cache.match(request, { ignoreSearch: true });
    if (cached) return cached;
    throw error;
  }
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
