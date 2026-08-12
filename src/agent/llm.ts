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

  constructor(apiKey: string, model = 'claude-haiku-4-5-20251001', baseUrl = 'https://api.anthropic.com') {
    this.apiKey = apiKey;
    this.model = model;
    this.baseUrl = baseUrl;
  }

  async complete(o: Parameters<Llm['complete']>[0]): Promise<LlmReply> {
    const body = {
      model: this.model,
      max_tokens: o.maxTokens ?? 200,
      stream: true,
      // Кэшируем системный промпт и схемы инструментов — они не меняются
      // между запросами и составляют почти весь вход. Экономия ~3x.
      system: [{ type: 'text', text: o.system, cache_control: { type: 'ephemeral' } }],
      tools: o.tools.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.schema,
      })),
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
    return parseAnthropicStream(res, o.onDelta);
  }
}

function toAnthropicMessages(msgs: Msg[]) {
  return msgs.map((m) => {
    if (m.role === 'tool') {
      return {
        role: 'user' as const,
        content: [{ type: 'tool_result', tool_use_id: m.toolCallId, content: m.content }],
      };
    }
    return { role: m.role, content: m.content };
  });
}

async function parseAnthropicStream(res: Response, onDelta?: (s: string) => void): Promise<LlmReply> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();

  let text = '';
  const toolCalls: ToolCall[] = [];
  const partials = new Map<number, { id: string; name: string; json: string }>();
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

      if (ev.type === 'content_block_start' && ev.content_block?.type === 'tool_use') {
        partials.set(ev.index, { id: ev.content_block.id, name: ev.content_block.name, json: '' });
      }
      if (ev.type === 'content_block_delta') {
        if (ev.delta?.type === 'text_delta') {
          text += ev.delta.text;
          onDelta?.(text);
        }
        if (ev.delta?.type === 'input_json_delta') {
          const p = partials.get(ev.index);
          if (p) p.json += ev.delta.partial_json;
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
        max_tokens: o.maxTokens ?? 200,
        messages: [
          { role: 'system', content: o.system },
          ...o.messages.map((m) =>
            m.role === 'tool'
              ? { role: 'tool', tool_call_id: m.toolCallId, content: m.content }
              : { role: m.role, content: m.content }),
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
