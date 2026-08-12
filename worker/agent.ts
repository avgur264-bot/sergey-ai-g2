/**
 * Агент для штатного Even AI.
 *
 * ЗАЧЕМ. В приложении Even есть «Add Agent»: имя, URL, токен. Указав
 * сюда адрес этого воркера, вы получаете голосовую активацию, микрофон
 * и экран силами самих очков, а отвечает наш агент. Отдельный плагин,
 * свой ключ распознавания и своя кнопка становятся не нужны.
 *
 * ПРОТОКОЛ. Публичной документации нет; формат восстановлен по
 * наблюдениям сообщества. Очки шлют POST с телом в стиле OpenAI:
 *   { "model": "...", "messages": [{ "role": "user", "content": "..." }] }
 * и заголовком Authorization: Bearer <токен из настроек>.
 * Ответ ожидается тоже в форме OpenAI chat completions.
 *
 * ТАЙМАУТ. Очки ждут ответа около 30 секунд и молча обрывают связь.
 * Поэтому здесь свой дедлайн в 22 секунды: лучше вернуть честное
 * «не успел», чем оставить человека смотреть в пустой экран.
 */

import { buildSystemPrompt } from '../src/agent/prompt.ts';

interface Env {
  AGENT_TOKEN: string;
  ANTHROPIC_API_KEY: string;
  /** Необязательно: модель и город для локальных запросов. */
  MODEL?: string;
  CITY?: string;
}

const DEADLINE_MS = 22_000;
const MODEL_DEFAULT = 'claude-sonnet-5';

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    if (req.method === 'OPTIONS') return new Response(null, { headers: cors() });
    if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405);

    // Настройка не доделана — говорим об этом прямо на экране очков.
    // Код ошибки тут бесполезен: очки покажут своё «network error», и
    // человек останется без единой подсказки, что именно не так.
    if (!env.ANTHROPIC_API_KEY) {
      return chatReply('Не задан ANTHROPIC_API_KEY в настройках воркера.');
    }
    if (!env.AGENT_TOKEN) {
      return chatReply('Не задан AGENT_TOKEN в настройках воркера.');
    }

    const auth = req.headers.get('authorization') ?? '';
    if (auth !== `Bearer ${env.AGENT_TOKEN}`) {
      return chatReply('Токен не совпадает с AGENT_TOKEN воркера.');
    }

    let body: any;
    try {
      body = await req.json();
    } catch {
      return json({ error: 'bad json' }, 400);
    }

    const messages = Array.isArray(body?.messages) ? body.messages : [];
    const question = lastUserText(messages);
    if (!question) return chatReply('Не расслышал вопрос.');

    try {
      const text = await withDeadline(
        answer(messages, env),
        DEADLINE_MS,
        'Не успел найти ответ. Спросите ещё раз.',
      );
      return chatReply(text);
    } catch (e: any) {
      console.error(e);
      // Ошибку возвращаем как обычный ответ, а не кодом: иначе очки
      // покажут своё системное сообщение вместо объяснения.
      return chatReply(`Не получилось: ${String(e?.message ?? 'сбой').slice(0, 80)}`);
    }
  },
};

/** Последняя реплика человека — то, на что отвечаем. */
function lastUserText(messages: any[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.role !== 'user') continue;
    if (typeof m.content === 'string') return m.content.trim();
    if (Array.isArray(m.content)) {
      const t = m.content.find((b: any) => b?.type === 'text')?.text;
      if (t) return String(t).trim();
    }
  }
  return '';
}

async function answer(messages: any[], env: Env): Promise<string> {
  // Историю прокидываем целиком: Even AI ведёт диалог сам, и без неё
  // уточняющие вопросы («а сколько там стоит?») теряют смысл.
  const history = messages
    .filter((m: any) => m?.role === 'user' || m?.role === 'assistant')
    .map((m: any) => ({
      role: m.role,
      content: typeof m.content === 'string'
        ? m.content
        : (m.content?.find?.((b: any) => b?.type === 'text')?.text ?? ''),
    }))
    .filter((m: any) => m.content)
    .slice(-8);

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: env.MODEL || MODEL_DEFAULT,
      max_tokens: 400,
      system: buildSystemPrompt(),
      messages: history.length ? history : [{ role: 'user', content: 'Привет' }],
      tools: [{
        type: 'web_search_20250305',
        name: 'web_search',
        max_uses: 5,
        ...(env.CITY ? { user_location: { type: 'approximate', city: env.CITY } } : {}),
      }],
    }),
  });

  if (!res.ok) throw new Error(`LLM ${res.status}`);
  const d: any = await res.json();

  // Ответ приходит блоками: берём только текст, служебные блоки
  // поиска человеку показывать не надо.
  const text = (d.content ?? [])
    .filter((b: any) => b?.type === 'text')
    .map((b: any) => b.text)
    .join('')
    .trim();

  return text || 'Ничего не нашёл.';
}

/** Возвращает запасной текст, если основной путь не уложился в срок. */
async function withDeadline<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: any;
  const guard = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(fallback), ms);
  });
  try {
    return await Promise.race([p, guard]);
  } finally {
    clearTimeout(timer);
  }
}

/** Ответ в форме, которую ожидают очки. */
function chatReply(text: string): Response {
  return json({
    id: `chatcmpl-${Date.now()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: 'sergey-ai',
    choices: [{
      index: 0,
      message: { role: 'assistant', content: text },
      finish_reason: 'stop',
    }],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  });
}

function cors() {
  return {
    'access-control-allow-origin': '*',
    'access-control-allow-headers': 'content-type, authorization',
    'access-control-allow-methods': 'POST, OPTIONS',
  };
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json', ...cors() },
  });
}
