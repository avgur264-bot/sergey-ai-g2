import type { ToolSpec } from '../registry.ts';

// ─── Веб-поиск ───────────────────────────────────────────────
// Tavily отдаёт CORS-заголовки и готовую выжимку вместо десяти ссылок —
// для HUD это важнее, чем полнота выдачи.

export const searchTool: ToolSpec = {
  name: 'web_search_deep',
  description:
    'Глубокий поиск с извлечением текста страниц. Возвращает готовую '
    + 'выжимку и содержимое источников, а не только заголовки. Используй '
    + 'для рейтингов, отзывов, цен, расписаний и всего, что нужно '
    + 'проверить по существу. Для свежих данных ставь days.',
  kind: 'read',
  transport: 'direct',
  label: 'ИЩУ',
  schema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'Запрос как в поисковой строке, с городом и годом',
      },
      days: {
        type: 'number',
        description: 'Ограничить свежестью: за сколько последних дней искать',
      },
    },
    required: ['query'],
  },
  async run(args, ctx) {
    const key = ctx.cfg.searchKey;
    if (!key) return { data: 'Ключ глубокого поиска не настроен' };

    const body: Record<string, unknown> = {
      query: String(args.query),
      // Глубокий режим извлекает текст страниц, а не сниппеты: именно
      // на сниппетах модель и додумывает то, чего в источнике нет.
      search_depth: 'advanced',
      include_answer: 'advanced',
      max_results: 5,
    };

    // Свежесть просим только когда она нужна: ограничение по дате
    // отсекает справочные страницы, которые давно не обновлялись.
    const days = Number(args.days);
    if (Number.isFinite(days) && days > 0) body.days = Math.min(days, 365);

    const res = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      signal: ctx.signal,
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${key}`,
      },
      body: JSON.stringify(body),
    });

    if (res.status === 401) throw new Error('401: ключ поиска не принят');
    if (!res.ok) throw new Error(`Поиск: ${res.status}`);
    const d = await res.json();

    // Модели отдаём выжимку и извлечённый текст источников с датами —
    // по датам она отличит актуальное от прошлогоднего.
    const parts: string[] = [];
    if (d.answer) parts.push(`Кратко: ${d.answer}`);

    for (const r of (d.results ?? []).slice(0, 5)) {
      const when = r.published_date ? ` (${String(r.published_date).slice(0, 10)})` : '';
      const text = String(r.content ?? '').slice(0, 400);
      parts.push(`${r.title}${when}: ${text}`);
    }

    const brief = parts.join('\n').slice(0, 3000);
    return { data: brief || 'по этому запросу ничего не нашлось' };
  },
};

// ─── Telegram: сообщение себе или в свой чат ─────────────────

export const telegramTool: ToolSpec = {
  name: 'send_message',
  description: 'Отправить текстовое сообщение в Telegram.',
  kind: 'write',
  transport: 'direct',
  label: 'TELEGRAM',
  schema: {
    type: 'object',
    properties: {
      text: { type: 'string', description: 'Текст сообщения' },
    },
    required: ['text'],
  },
  confirm: (a) => `Отправить в Telegram:\n${String(a.text).slice(0, 120)}`,
  async run(args, ctx) {
    const token = ctx.cfg.tgToken;
    const chat = ctx.cfg.tgChatId;
    if (!token || !chat) return { data: 'Telegram не настроен', direct: 'TELEGRAM НЕ НАСТРОЕН' };

    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      signal: ctx.signal,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: chat, text: String(args.text) }),
    });

    if (!res.ok) throw new Error(`Telegram: ${res.status}`);
    return { data: 'отправлено', direct: 'ОТПРАВЛЕНО' };
  },
};

// ─── Заметки: локальный список в KVS ─────────────────────────

const NOTES_KEY = 'notes:list';

export const noteAddTool: ToolSpec = {
  name: 'note_add',
  description: 'Записать заметку или пункт в список дел.',
  kind: 'write',
  transport: 'local',
  label: 'ЗАМЕТКА',
  schema: {
    type: 'object',
    properties: { text: { type: 'string' } },
    required: ['text'],
  },
  confirm: (a) => `Записать:\n${String(a.text).slice(0, 120)}`,
  async run(args, ctx) {
    const raw = await ctx.bridge.get(NOTES_KEY);
    const list: { t: string; at: number }[] = raw ? JSON.parse(raw) : [];
    list.push({ t: String(args.text).slice(0, 300), at: Date.now() });
    await ctx.bridge.set(NOTES_KEY, JSON.stringify(list.slice(-200)));
    return { data: 'записано', direct: 'ЗАПИСАНО' };
  },
};

export const noteListTool: ToolSpec = {
  name: 'note_list',
  description: 'Показать последние заметки.',
  kind: 'read',
  transport: 'local',
  label: 'ЗАМЕТКИ',
  schema: {
    type: 'object',
    properties: { limit: { type: 'number' } },
  },
  async run(args, ctx) {
    const raw = await ctx.bridge.get(NOTES_KEY);
    const list: { t: string }[] = raw ? JSON.parse(raw) : [];
    if (!list.length) return { data: 'пусто', direct: 'ЗАМЕТОК НЕТ' };

    const n = Math.min(Number(args.limit) || 5, 10);
    const last = list.slice(-n).reverse().map((x) => x.t);
    return { data: last.join('\n'), direct: last.join('\n') };
  },
};
