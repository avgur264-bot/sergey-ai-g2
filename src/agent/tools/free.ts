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

/** Место из вопроса или город из настроек → координаты. */
async function resolveCoords(ctx: ToolContext, place?: string): Promise<Coords> {
  // Место, названное в самом вопросе, всегда главнее: «рестораны в
  // Самарканде» нельзя искать вокруг города из настроек.
  const named = String(place ?? '').trim();
  if (named) return geocodeCity(named, ctx.signal);

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
    if (!city) throw new Error('Укажите город в настройках или назовите его в вопросе');
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
    'Найти заведения: рестораны, кафе, бары, аптеки, банкоматы, заправки, '
    + 'магазины, отели, парки. Возвращает название, адрес и расстояние. '
    + 'Если пользователь назвал город или район — '
    + 'обязательно передай его в location, иначе поиск пойдёт вокруг '
    + 'текущего места. Если названо блюдо или кухня («плов», «пицца», '
    + '«суши») — передай это в keyword. Рейтингов и отзывов нет.',
  kind: 'read',
  transport: 'direct',
  label: 'ИЩУ МЕСТА',
  schema: {
    type: 'object',
    properties: {
      category: {
        type: 'string',
        description: 'Тип места одним словом: ресторан, кафе, аптека, банкомат…',
      },
      location: {
        type: 'string',
        description: 'Город, район или улица из вопроса. Например: Самарканд.',
      },
      keyword: {
        type: 'string',
        description: 'Блюдо или кухня из вопроса: плов, пицца, суши.',
      },
      radius: { type: 'number', description: 'Радиус поиска в метрах' },
    },
    required: ['category'],
  },
  async run(args, ctx) {
    const place = args.location ? String(args.location) : '';
    const { lat, lon } = await resolveCoords(ctx, place);

    // Названный город ищем широко — человек имеет в виду весь город,
    // а не полтора километра вокруг его геометрического центра.
    const fallback = place ? 6000 : 1500;
    const maxR = place ? 15000 : 5000;
    const radius = Math.min(Math.max(Number(args.radius) || fallback, 200), maxR);
    const tag = tagFor(String(args.category));

    // Просим только именованные объекты: безымянная точка на карте
    // человеку в очках ничего не даёт.
    const q = `[out:json][timeout:20];
      nwr[${tag}][name](around:${radius},${lat},${lon});
      out center 60;`;

    const res = await fetch(OVERPASS, {
      method: 'POST',
      signal: ctx.signal,
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'data=' + encodeURIComponent(q),
    });
    if (!res.ok) throw new Error(`Карты: ${res.status}`);

    const d = await res.json();
    const kw = String(args.keyword ?? '').toLowerCase().trim();

    let items = (d.elements ?? [])
      .map((e: any) => {
        const elat = e.lat ?? e.center?.lat;
        const elon = e.lon ?? e.center?.lon;
        if (typeof elat !== 'number' || typeof elon !== 'number') return null;
        const t = e.tags ?? {};
        return {
          name: String(t.name ?? '').slice(0, 40),
          cuisine: t.cuisine ? String(t.cuisine).split(';')[0] : '',
          address: formatAddress(t),
          hours: t.opening_hours ? String(t.opening_hours).slice(0, 24) : '',
          dist: Math.round(haversine(lat, lon, elat, elon)),
        };
      })
      .filter((x: any) => x && x.name);

    if (kw) {
      // Блюдо в OSM отдельным полем не хранится: ищем по кухне и по
      // названию — «Plov Center» найдётся именно так.
      const root = kw.slice(0, 4);
      const matched = items.filter((i: any) =>
        i.cuisine.toLowerCase().includes(root) || i.name.toLowerCase().includes(root));
      // Если по слову ничего нет, лучше показать ближайшие места
      // подходящей категории, чем пустой экран.
      if (matched.length) items = matched;
    }

    // Место с адресом полезнее безымянной точки на карте: до него можно
    // дойти. При прочих равных показываем такие выше, а уже потом
    // сортируем по расстоянию.
    items = items
      .sort((a: any, b: any) => {
        const byAddr = Number(Boolean(b.address)) - Number(Boolean(a.address));
        return byAddr !== 0 ? byAddr : a.dist - b.dist;
      })
      .slice(0, 4);

    if (!items.length) return { data: 'ничего не найдено', direct: 'НИЧЕГО НЕ НАШЁЛ' };

    // Отдаём подробности модели и НЕ показываем список напрямую.
    //
    // Прямой показ был быстрее, но перескакивал через модель — а именно
    // она добавляет к адресам рейтинги, найденные поиском. Без этого
    // шага ответ выходил половинчатым: адрес есть, оценки нет.
    const forModel = items.map((i: any) =>
      [i.name, i.address, i.cuisine, i.hours, fmtDist(i.dist)].filter(Boolean).join(' · '));

    return { data: forModel.join('\n') };
  },
};

/** Улица и дом из тегов OSM. Без города — он и так известен из вопроса. */
function formatAddress(t: any): string {
  const street = t['addr:street'] ? String(t['addr:street']) : '';
  const house = t['addr:housenumber'] ? String(t['addr:housenumber']) : '';
  if (street && house) return `${street}, ${house}`;
  if (street) return street;
  // Некоторые объекты несут только общий адресный тег.
  if (t['addr:full']) return String(t['addr:full']).slice(0, 60);
  return '';
}

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
