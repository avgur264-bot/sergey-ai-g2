/**
 * Адаптер провайдера. Форматы инструментов у вендоров расходятся:
 *   Anthropic — input_schema, аргументы приходят объектом
 *   OpenAI    — parameters, аргументы приходят JSON-строкой
 * Реестр инструментов об этой разнице знать не должен.
 */

import type { ToolSpec } from './registry.ts';

export interface Msg {
  role: 'user' | 'assistant' | 'tool';
  content: string;
  toolCallId?: string;
  toolName?: string;
  /**
   * Вызовы инструментов, сделанные моделью в этом ходе.
   *
   * Хранить обязательно: результат инструмента ссылается на вызов по
   * идентификатору, и если самого вызова в истории нет, провайдер
   * отвергает запрос целиком. Раньше ход записывался просто текстом,
   * и любой инструмент ломал следующий шаг с ошибкой 400.
   */
  toolCalls?: ToolCall[];
}

export interface ToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

export interface LlmReply {
  text: string;
  toolCalls: ToolCall[];
}

export interface Llm {
  complete(opts: {
    system: string;
    messages: Msg[];
    tools: ToolSpec[];
    maxTokens?: number;
    onDelta?: (chunk: string) => void;
    /** Модель пошла искать в интернете — можно показать это на экране. */
    onSearch?: (query: string) => void;
    /** Разрешить поиск в интернете (серверный инструмент провайдера). */
    webSearch?: boolean;
    /** Город пользователя — уточняет локальные запросы («рестораны рядом»). */
    city?: string;
    signal?: AbortSignal;
  }): Promise<LlmReply>;
}

// ─────────────────────────────────────────────────────────────
// Anthropic
// ─────────────────────────────────────────────────────────────

export class AnthropicLlm implements Llm {
  private apiKey: string;
  private model: string;
  /** Адрес API. Замените на URL прокси, если нужен серверный egress. */
  private baseUrl: string;

  constructor(apiKey: string, model = 'claude-sonnet-5', baseUrl = 'https://api.anthropic.com') {
    this.apiKey = apiKey;
    this.model = model;
    this.baseUrl = baseUrl;
  }

  async complete(o: Parameters<Llm['complete']>[0]): Promise<LlmReply> {
    // Инструменты клиента (таймер, память) и серверный поиск живут в
    // одном массиве: поиск выполняет провайдер у себя, нам возвращается
    // уже готовый ответ со ссылками. Отдельный ключ поисковика и обход
    // CORS из WebView при таком подходе не нужны.
    const tools: unknown[] = o.tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.schema,
    }));

    if (o.webSearch) {
      tools.push({
        type: 'web_search_20250305',
        name: 'web_search',
        // Запас нужен, чтобы модель могла переформулировать запрос,
        // проверить факт по второму источнику и уточнить свежесть.
        // Экономия на поисках возвращается неточным ответом.
        max_uses: 8,
        ...(o.city
          ? { user_location: { type: 'approximate', city: o.city } }
          : {}),
      });
    }

    const body = {
      model: this.model,
      max_tokens: o.maxTokens ?? 400,
      stream: true,
      // Кэшируем системный промпт и схемы инструментов — они не меняются
      // между запросами и составляют почти весь вход. Экономия ~3x.
      system: [{ type: 'text', text: o.system, cache_control: { type: 'ephemeral' } }],
      tools,
      messages: toAnthropicMessages(o.messages),
    };

    const res = await fetch(`${this.baseUrl}/v1/messages`, {
      method: 'POST',
      signal: o.signal,
      headers: {
        'content-type': 'application/json',
        'x-api-key': this.apiKey,
        'anthropic-version': '2023-06-01',
        // Нужен для вызова напрямую из WebView/браузера со своим ключом.
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) throw new Error(`LLM ${res.status}: ${await res.text()}`);
    return parseAnthropicStream(res, o.onDelta, o.onSearch);
  }
}

function toAnthropicMessages(msgs: Msg[]) {
  const out: any[] = [];

  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i];

    if (m.role === 'tool') {
      // Все результаты одного хода провайдер ждёт в ОДНОЙ реплике
      // пользователя. Собираем подряд идущие вместе.
      const results: any[] = [];
      while (i < msgs.length && msgs[i].role === 'tool') {
        results.push({
          type: 'tool_result',
          tool_use_id: msgs[i].toolCallId,
          content: msgs[i].content,
        });
        i++;
      }
      i--;
      out.push({ role: 'user', content: results });
      continue;
    }

    if (m.role === 'assistant' && m.toolCalls?.length) {
      // Текст может отсутствовать, если модель сразу пошла за
      // инструментом; пустой текстовый блок отправлять нельзя.
      const blocks: any[] = [];
      if (m.content.trim()) blocks.push({ type: 'text', text: m.content });
      for (const c of m.toolCalls) {
        blocks.push({ type: 'tool_use', id: c.id, name: c.name, input: c.args ?? {} });
      }
      out.push({ role: 'assistant', content: blocks });
      continue;
    }

    out.push({ role: m.role, content: m.content });
  }

  return out;
}

async function parseAnthropicStream(
  res: Response,
  onDelta?: (s: string) => void,
  onSearch?: (q: string) => void,
): Promise<LlmReply> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();

  let text = '';
  const toolCalls: ToolCall[] = [];
  // Только НАШИ инструменты. Серверный поиск исполняет провайдер,
  // возвращать его нам как вызов нельзя — иначе роутер станет искать
  // несуществующий инструмент «web_search» в своём реестре.
  const partials = new Map<number, { id: string; name: string; json: string }>();
  const serverPartials = new Map<number, string>();
  let buf = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });

    const lines = buf.split('\n');
    buf = lines.pop() ?? '';

    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      let ev: any;
      try { ev = JSON.parse(line.slice(6)); } catch { continue; }

      if (ev.type === 'content_block_start') {
        const b = ev.content_block;
        if (b?.type === 'tool_use') {
          partials.set(ev.index, { id: b.id, name: b.name, json: '' });
        }
        if (b?.type === 'server_tool_use') {
          // Аргументы поиска приходят потоком; накапливаем, чтобы
          // показать человеку, что именно ищется.
          serverPartials.set(ev.index, '');
        }
      }

      if (ev.type === 'content_block_delta') {
        if (ev.delta?.type === 'text_delta') {
          text += ev.delta.text;
          onDelta?.(text);
        }
        if (ev.delta?.type === 'input_json_delta') {
          const p = partials.get(ev.index);
          if (p) p.json += ev.delta.partial_json;
          const s = serverPartials.get(ev.index);
          if (s !== undefined) serverPartials.set(ev.index, s + ev.delta.partial_json);
        }
      }

      if (ev.type === 'content_block_stop') {
        const p = partials.get(ev.index);
        if (p) {
          let args = {};
          try { args = p.json ? JSON.parse(p.json) : {}; } catch { /* модель прислала мусор */ }
          toolCalls.push({ id: p.id, name: p.name, args });
          partials.delete(ev.index);
        }
        const s = serverPartials.get(ev.index);
        if (s !== undefined) {
          try {
            const q = JSON.parse(s || '{}')?.query;
            if (q) onSearch?.(String(q));
          } catch { /* не критично: это только для индикации */ }
          serverPartials.delete(ev.index);
        }
      }
    }
  }

  return { text: text.trim(), toolCalls };
}

// ─────────────────────────────────────────────────────────────
// OpenAI-совместимый (OpenAI, локальные шлюзы, YandexGPT-прокси)
// ─────────────────────────────────────────────────────────────

export class OpenAiLlm implements Llm {
  private apiKey: string;
  private model: string;
  private baseUrl: string;

  constructor(apiKey: string, model = 'gpt-4o-mini', baseUrl = 'https://api.openai.com') {
    this.apiKey = apiKey;
    this.model = model;
    this.baseUrl = baseUrl;
  }

  async complete(o: Parameters<Llm['complete']>[0]): Promise<LlmReply> {
    const res = await fetch(`${this.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      signal: o.signal,
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.model,
        max_tokens: o.maxTokens ?? 400,
        messages: [
          { role: 'system', content: o.system },
          ...o.messages.map((m) => {
            if (m.role === 'tool') {
              return { role: 'tool', tool_call_id: m.toolCallId, content: m.content };
            }
            if (m.role === 'assistant' && m.toolCalls?.length) {
              // Та же причина, что и у Anthropic: без самого вызова
              // результат ссылается в пустоту и запрос отвергается.
              return {
                role: 'assistant',
                content: m.content || null,
                tool_calls: m.toolCalls.map((c) => ({
                  id: c.id,
                  type: 'function',
                  function: { name: c.name, arguments: JSON.stringify(c.args ?? {}) },
                })),
              };
            }
            return { role: m.role, content: m.content };
          }),
        ],
        tools: o.tools.map((t) => ({
          type: 'function',
          function: { name: t.name, description: t.description, parameters: t.schema },
        })),
      }),
    });

    if (!res.ok) throw new Error(`LLM ${res.status}: ${await res.text()}`);
    const data = await res.json();
    const choice = data.choices?.[0]?.message ?? {};

    return {
      text: (choice.content ?? '').trim(),
      // У OpenAI аргументы — JSON-строка, у Anthropic уже объект.
      toolCalls: (choice.tool_calls ?? []).map((c: any) => ({
        id: c.id,
        name: c.function.name,
        args: safeJson(c.function.arguments),
      })),
    };
  }
}

function safeJson(s: string): Record<string, unknown> {
  try { return JSON.parse(s); } catch { return {}; }
}
