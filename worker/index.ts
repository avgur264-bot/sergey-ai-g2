/**
 * Прокси для Sergey AI. Cloudflare Workers, бесплатный тариф.
 *
 * Решает три задачи, которые из WebView очков не решаются:
 *   1. OAuth Google Calendar — refresh-токен живёт здесь, не на телефоне
 *   2. Регион — запросы к LLM уходят с сервера, а не с сети телефона
 *   3. CORS для сервисов, которые не отдают заголовки браузеру
 *
 * Развёртывание:
 *   npm i -g wrangler
 *   wrangler secret put PROXY_TOKEN        # придумайте длинную строку
 *   wrangler secret put ANTHROPIC_API_KEY
 *   wrangler secret put GOOGLE_CLIENT_ID
 *   wrangler secret put GOOGLE_CLIENT_SECRET
 *   wrangler secret put GOOGLE_REFRESH_TOKEN
 *   wrangler deploy
 *
 * Refresh-токен Google получается один раз через OAuth Playground:
 *   https://developers.google.com/oauthplayground
 *   Scope: https://www.googleapis.com/auth/calendar.events
 */

interface Env {
  PROXY_TOKEN: string;
  ANTHROPIC_API_KEY?: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  GOOGLE_REFRESH_TOKEN?: string;
}

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'content-type, authorization',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
};

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json', ...CORS },
  });

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });

    const url = new URL(req.url);

    // Простая проверка: один общий токен. Пользователь тут один — вы.
    const auth = req.headers.get('authorization') ?? '';
    if (auth !== `Bearer ${env.PROXY_TOKEN}`) return json({ error: 'unauthorized' }, 401);

    try {
      if (url.pathname === '/calendar/list') return await listEvents(url, env);
      if (url.pathname === '/calendar/create') return await createEvent(req, env);
      if (url.pathname === '/v1/messages') return await proxyAnthropic(req, env);
      return json({ error: 'not found' }, 404);
    } catch (e: any) {
      // Наружу — только категория ошибки. Ключи и токены в ответ не попадают.
      console.error(e);
      return json({ error: e?.message ?? 'internal' }, 500);
    }
  },
};

// ─── Google Calendar ─────────────────────────────────────────

async function googleToken(env: Env): Promise<string> {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID!,
      client_secret: env.GOOGLE_CLIENT_SECRET!,
      refresh_token: env.GOOGLE_REFRESH_TOKEN!,
      grant_type: 'refresh_token',
    }),
  });
  if (!res.ok) throw new Error('google auth failed');
  return (await res.json() as any).access_token;
}

async function listEvents(url: URL, env: Env): Promise<Response> {
  const days = Math.min(Math.max(Number(url.searchParams.get('days')) || 1, 1), 14);
  const token = await googleToken(env);

  const now = new Date();
  const till = new Date(now.getTime() + days * 86400_000);

  const api = new URL('https://www.googleapis.com/calendar/v3/calendars/primary/events');
  api.searchParams.set('timeMin', now.toISOString());
  api.searchParams.set('timeMax', till.toISOString());
  api.searchParams.set('singleEvents', 'true');
  api.searchParams.set('orderBy', 'startTime');
  api.searchParams.set('maxResults', '10');

  const res = await fetch(api, { headers: { authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`calendar ${res.status}`);
  const d = await res.json() as any;

  // Отдаём уже подготовленные короткие строки — на HUD всё равно
  // влезет только это, а токены модели экономятся.
  const events = (d.items ?? []).map((e: any) => {
    const iso = e.start?.dateTime ?? e.start?.date;
    const dt = new Date(iso);
    const time = e.start?.dateTime
      ? dt.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })
      : 'весь день';
    return { time, title: (e.summary ?? 'Без названия').slice(0, 60) };
  });

  return json({ events });
}

async function createEvent(req: Request, env: Env): Promise<Response> {
  const body = await req.json() as any;
  if (!body?.title || !body?.start) return json({ error: 'title and start required' }, 400);

  const token = await googleToken(env);
  const start = new Date(body.start);
  if (isNaN(+start)) return json({ error: 'bad start' }, 400);

  const end = new Date(start.getTime() + (Number(body.durationMin) || 60) * 60_000);

  const res = await fetch(
    'https://www.googleapis.com/calendar/v3/calendars/primary/events',
    {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        summary: String(body.title).slice(0, 200),
        start: { dateTime: start.toISOString() },
        end: { dateTime: end.toISOString() },
      }),
    },
  );

  if (!res.ok) throw new Error(`calendar create ${res.status}`);
  return json({ ok: true });
}

// ─── Прокси LLM ──────────────────────────────────────────────
// Ключ остаётся здесь. В плагине baseUrl меняется на адрес воркера,
// а поле llmKey заполняется значением PROXY_TOKEN.

async function proxyAnthropic(req: Request, env: Env): Promise<Response> {
  if (!env.ANTHROPIC_API_KEY) return json({ error: 'llm key not configured' }, 501);

  const upstream = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: await req.text(),
  });

  // Стрим пробрасываем как есть — иначе потеряется вывод по токенам.
  return new Response(upstream.body, {
    status: upstream.status,
    headers: {
      'content-type': upstream.headers.get('content-type') ?? 'application/json',
      ...CORS,
    },
  });
}
