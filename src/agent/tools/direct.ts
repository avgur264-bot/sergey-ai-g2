import type { ToolSpec } from '../registry.ts';

// ─── Веб-поиск ───────────────────────────────────────────────
// Tavily отдаёт CORS-заголовки и готовую выжимку вместо десяти ссылок —
// для HUD это важнее, чем полнота выдачи.

export const searchTool: ToolSpec = {
  name: 'web_search',
  description:
    'Найти актуальную информацию в интернете: новости, курсы, факты после обучения модели.',
  kind: 'read',
  transport: 'direct',
  label: 'ИЩУ',
  schema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Поисковый запрос' },
    },
    required: ['query'],
  },
  async run(args, ctx) {
    const key = ctx.cfg.searchKey;
    if (!key) return { data: 'Ключ поиска не настроен', direct: 'ПОИСК НЕ НАСТРОЕН' };

    const res = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      signal: ctx.signal,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        api_key: key,
        query: String(args.query),
        search_depth: 'basic',
        include_answer: true,
        max_results: 3,
      }),
    });

    if (!res.ok) throw new Error(`Поиск: ${res.status}`);
    const d = await res.json();

    // Модели отдаём выжимку и заголовки — не полные тексты страниц,
    // иначе входные токены улетят в разы.
    const brief = [
      d.answer ?? '',
      ...(d.results ?? []).slice(0, 3).map((r: any) => `${r.title}: ${r.content?.slice(0, 200)}`),
    ].filter(Boolean).join('\n');

    return { data: brief.slice(0, 1500) || 'Ничего не нашлось' };
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
