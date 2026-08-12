import type { ToolSpec, ToolContext } from '../registry.ts';

/**
 * Google Calendar через свой воркер.
 *
 * Почему не напрямую: OAuth-редиректы внутри WebView очков — это боль,
 * а refresh-токен на устройстве хранить не хочется. Воркер держит токены
 * у себя и отдаёт наружу два простых эндпоинта с нормальным CORS.
 *
 * Код воркера — в папке worker/.
 */

async function callProxy(ctx: ToolContext, path: string, body?: unknown) {
  const base = ctx.cfg.proxyUrl;
  if (!base) throw new Error('Прокси не настроен');

  const res = await fetch(`${base}${path}`, {
    method: body ? 'POST' : 'GET',
    signal: ctx.signal,
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${ctx.cfg.proxyToken ?? ''}`,
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  if (res.status === 401) throw new Error('401: прокси не авторизован');
  if (!res.ok) throw new Error(`Прокси ${res.status}`);
  return res.json();
}

export const calendarListTool: ToolSpec = {
  name: 'calendar_list',
  description: 'Показать ближайшие события календаря.',
  kind: 'read',
  transport: 'proxy',
  label: 'КАЛЕНДАРЬ',
  schema: {
    type: 'object',
    properties: {
      days: { type: 'number', description: 'На сколько дней вперёд, по умолчанию 1' },
    },
  },
  async run(args, ctx) {
    const days = Math.min(Math.max(Number(args.days) || 1, 1), 14);
    const d = await callProxy(ctx, `/calendar/list?days=${days}`);

    const events: { time: string; title: string }[] = d.events ?? [];
    if (!events.length) return { data: 'событий нет', direct: 'СВОБОДНО' };

    const lines = events.slice(0, 6).map((e) => `${e.time} ${e.title}`);
    return { data: lines.join('\n'), direct: lines.join('\n') };
  },
};

export const calendarCreateTool: ToolSpec = {
  name: 'calendar_create',
  description:
    'Создать событие в календаре. Время передавать в ISO 8601 с учётом часового пояса пользователя.',
  kind: 'write',
  transport: 'proxy',
  label: 'КАЛЕНДАРЬ',
  schema: {
    type: 'object',
    properties: {
      title: { type: 'string' },
      start: { type: 'string', description: 'ISO 8601, например 2026-08-14T19:30:00+05:00' },
      durationMin: { type: 'number', description: 'Длительность в минутах, по умолчанию 60' },
    },
    required: ['title', 'start'],
  },
  confirm: (a) => {
    const when = new Date(String(a.start));
    const t = isNaN(+when)
      ? String(a.start)
      : when.toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
    return `Создать событие:\n${a.title}\n${t}`;
  },
  async run(args, ctx) {
    await callProxy(ctx, '/calendar/create', {
      title: String(args.title),
      start: String(args.start),
      durationMin: Number(args.durationMin) || 60,
    });
    return { data: 'создано', direct: 'СОЗДАНО' };
  },
};
