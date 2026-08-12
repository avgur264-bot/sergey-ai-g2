import type { ToolSpec, ToolContext } from '../registry.ts';

/**
 * Бесплатные источники данных: без ключей, без регистрации, с CORS.
 *
 * Почему именно они. Платный поиск провайдера решает всё сразу, но стоит
 * денег за каждый запрос. Perplexity и Yandex Search API бесплатных
 * тарифов не имеют, а Yandex вдобавок не отдаёт CORS-заголовки — из
 * WebView очков туда не попасть без своего сервера. OpenStreetMap и
 * Wikipedia отдают данные напрямую браузеру и не просят ни ключа, ни
 * оплаты.
 *
 * Честное ограничение: у OSM нет рейтингов и отзывов. «Лучшие» он не
 * знает — он знает, что рядом и как называется. Для «где поесть
 * поблизости» этого достаточно, для «какой ресторан лучше» — нет.
 */

const NOMINATIM = 'https://nominatim.openstreetmap.org';
const OVERPASS = 'https://overpass-api.de/api/interpreter';

/** OSM просит представляться — иначе быстро упрёмся в лимиты. */
const UA_PARAM = 'sergey-ai-g2';

interface Coords { lat: number; lon: number }

/** Город из настроек → координаты. Кэшируем: город меняется редко. */
const geocodeCache = new Map<string, Coords>();

async function geocodeCity(city: string, signal: AbortSignal): Promise<Coords> {
  const key = city.toLowerCase().trim();
  const hit = geocodeCache.get(key);
  if (hit) return hit;

  const url = `${NOMINATIM}/search?format=json&limit=1`
    + `&q=${encodeURIComponent(city)}&email=${UA_PARAM}`;
  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error(`Геокодер: ${res.status}`);

  const arr = await res.json();
  if (!Array.isArray(arr) || !arr.length) throw new Error('Город не найден');

  const c = { lat: Number(arr[0].lat), lon: Number(arr[0].lon) };
  geocodeCache.set(key, c);
  return c;
}

/** Координаты устройства, если доступны; иначе — центр города из настроек. */
async function resolveCoords(ctx: ToolContext): Promise<Coords> {
  try {
    return await new Promise<Coords>((resolve, reject) => {
      navigator.geolocation.getCurrentPosition(
        (p) => resolve({ lat: p.coords.latitude, lon: p.coords.longitude }),
        () => reject(new Error('нет геолокации')),
        { timeout: 5000, enableHighAccuracy: false },
      );
    });
  } catch {
    // Геолокация в режиме прототипа не работает — это ожидаемо,
    // поэтому город в настройках и существует.
    const city = String(ctx.cfg.city ?? '').trim();
    if (!city) throw new Error('Укажите город в настройках');
    return geocodeCity(city, ctx.signal);
  }
}

/** Категории на человеческом языке → теги OSM. */
const CATEGORIES: Record<string, string> = {
  ресторан: 'amenity=restaurant',
  кафе: 'amenity=cafe',
  бар: 'amenity=bar',
  аптека: 'amenity=pharmacy',
  банкомат: 'amenity=atm',
  заправка: 'amenity=fuel',
  магазин: 'shop=supermarket',
  больница: 'amenity=hospital',
  отель: 'tourism=hotel',
  парк: 'leisure=park',
};

function tagFor(query: string): string {
  const q = query.toLowerCase();
  for (const [word, tag] of Object.entries(CATEGORIES)) {
    if (q.includes(word.slice(0, 5))) return tag;
  }
  return 'amenity=restaurant';
}

export const placesTool: ToolSpec = {
  name: 'places_near',
  description:
    'Найти заведения поблизости: рестораны, кафе, бары, аптеки, банкоматы, '
    + 'заправки, магазины, отели, парки. Возвращает названия и расстояние. '
    + 'Рейтингов и отзывов нет.',
  kind: 'read',
  transport: 'direct',
  label: 'ИЩУ РЯДОМ',
  schema: {
    type: 'object',
    properties: {
      category: {
        type: 'string',
        description: 'Что искать одним словом: ресторан, кафе, аптека, банкомат…',
      },
      radius: { type: 'number', description: 'Радиус поиска в метрах, по умолчанию 1500' },
    },
    required: ['category'],
  },
  async run(args, ctx) {
    const { lat, lon } = await resolveCoords(ctx);
    const radius = Math.min(Math.max(Number(args.radius) || 1500, 200), 5000);
    const tag = tagFor(String(args.category));

    // Просим только именованные объекты: безымянная точка на карте
    // человеку в очках ничего не даёт.
    const q = `[out:json][timeout:15];
      nwr[${tag}][name](around:${radius},${lat},${lon});
      out center 12;`;

    const res = await fetch(OVERPASS, {
      method: 'POST',
      signal: ctx.signal,
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'data=' + encodeURIComponent(q),
    });
    if (!res.ok) throw new Error(`Карты: ${res.status}`);

    const d = await res.json();
    const items = (d.elements ?? [])
      .map((e: any) => {
        const elat = e.lat ?? e.center?.lat;
        const elon = e.lon ?? e.center?.lon;
        if (typeof elat !== 'number' || typeof elon !== 'number') return null;
        return {
          name: String(e.tags?.name ?? '').slice(0, 40),
          cuisine: e.tags?.cuisine ? String(e.tags.cuisine).split(';')[0] : '',
          dist: Math.round(haversine(lat, lon, elat, elon)),
        };
      })
      .filter((x: any) => x && x.name)
      .sort((a: any, b: any) => a.dist - b.dist)
      .slice(0, 5);

    if (!items.length) return { data: 'ничего не найдено рядом', direct: 'НИЧЕГО РЯДОМ' };

    const lines = items.map((i: any) =>
      `${i.name} — ${fmtDist(i.dist)}${i.cuisine ? `, ${i.cuisine}` : ''}`);

    // direct: показываем список сразу, без второго обращения к модели.
    // Это и быстрее, и ровно тот конкретный ответ, который нужен.
    return { data: lines.join('\n'), direct: lines.join('\n') };
  },
};

function fmtDist(m: number) {
  return m < 1000 ? `${m} м` : `${(m / 1000).toFixed(1)} км`;
}

function haversine(la1: number, lo1: number, la2: number, lo2: number) {
  const R = 6371000, rad = Math.PI / 180;
  const dLa = (la2 - la1) * rad, dLo = (lo2 - lo1) * rad;
  const a = Math.sin(dLa / 2) ** 2
    + Math.cos(la1 * rad) * Math.cos(la2 * rad) * Math.sin(dLo / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

// ─── Wikipedia: факты, которых нет в модели ──────────────────

export const wikiTool: ToolSpec = {
  name: 'wiki_lookup',
  description:
    'Краткая справка из Википедии о человеке, месте, событии, организации. '
    + 'Использовать для фактов, а не для свежих новостей.',
  kind: 'read',
  transport: 'direct',
  label: 'СПРАВКА',
  schema: {
    type: 'object',
    properties: { topic: { type: 'string', description: 'О чём справка' } },
    required: ['topic'],
  },
  async run(args, ctx) {
    const topic = String(args.topic).trim();

    // Сначала ищем точное название статьи: прямой переход по заголовку
    // часто промахивается из-за падежей и уточнений в скобках.
    const s = await fetch(
      'https://ru.wikipedia.org/w/api.php?action=query&list=search&format=json'
      + `&origin=*&srlimit=1&srsearch=${encodeURIComponent(topic)}`,
      { signal: ctx.signal },
    );
    if (!s.ok) throw new Error(`Википедия: ${s.status}`);
    const sd = await s.json();
    const title = sd?.query?.search?.[0]?.title;
    if (!title) return { data: 'в Википедии ничего не нашлось' };

    const r = await fetch(
      `https://ru.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title)}`,
      { signal: ctx.signal },
    );
    if (!r.ok) throw new Error(`Википедия: ${r.status}`);
    const d = await r.json();

    const extract = String(d.extract ?? '').slice(0, 700);
    return { data: extract || 'в Википедии ничего не нашлось' };
  },
};
