// Полный прогон главного экрана: тап → распознавание → вызов
// инструмента → второй запрос к модели → ответ на экране.
// Проверяем именно ту цепочку, которая падала с ошибкой 400.
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';

const html = readFileSync('./dist/index.html', 'utf8');
const dom = new JSDOM(html, { runScripts: 'outside-only', url: 'https://example.test/' });
const { window } = dom;
globalThis.window = window;
globalThis.document = window.document;
globalThis.localStorage = window.localStorage;
Object.defineProperty(globalThis, 'navigator', { value: window.navigator, configurable: true });
globalThis.Event = window.Event;
globalThis.CustomEvent = window.CustomEvent;
globalThis.HTMLElement = window.HTMLElement;

const WAKE = process.env.WAKE === '1';
window.localStorage.setItem('cfg', JSON.stringify({
  sttKey: 'dg', llmKey: 'sk-ant-x', city: 'Алматы',
  wakeEnabled: WAKE, wakeWord: 'сергей',
}));

// Ловим все обращения к сети.
const calls = [];
globalThis.fetch = async (url, init) => {
  const u = String(url);
  calls.push(u);

  if (u.includes('nominatim')) {
    return { ok: true, json: async () => ([{ lat: '43.2', lon: '76.9' }]) };
  }
  if (u.includes('overpass')) {
    return { ok: true, json: async () => ({
      elements: [{ lat: 43.201, lon: 76.901, tags: { name: 'Чайхана', cuisine: 'uzbek' } }],
    })};
  }
  if (u.includes('anthropic')) {
    const body = JSON.parse(init.body);
    // Проверяем корректность истории при повторном запросе.
    const bad = body.messages.find((m) =>
      Array.isArray(m.content) &&
      m.content.some((b) => b.type === 'tool_result') &&
      !body.messages.some((x) => Array.isArray(x.content) &&
        x.content.some((b) => b.type === 'tool_use' &&
          m.content.some((r) => r.tool_use_id === b.id))));
    if (bad) throw new Error('РЕГРЕСС: результат инструмента без вызова');

    const first = !body.messages.some((m) =>
      Array.isArray(m.content) && m.content.some((b) => b.type === 'tool_use'));

    const events = first
      ? [
          `data: ${JSON.stringify({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_1', name: 'places_near' } })}`,
          `data: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"category":"ресторан"}' } })}`,
          `data: ${JSON.stringify({ type: 'content_block_stop', index: 0 })}`,
        ]
      : [
          `data: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Чайхана в 150 м.' } })}`,
        ];

    const chunk = new TextEncoder().encode(events.join('\n') + '\n');
    let sent = false;
    return {
      ok: true,
      body: { getReader: () => ({
        read: async () => sent ? { done: true } : (sent = true, { done: false, value: chunk }),
      })},
    };
  }
  throw new Error('неожиданный запрос: ' + u);
};

// WebSocket-заглушка распознавания.
class FakeWS {
  static OPEN = 1;
  static last = null;
  readyState = 1;
  constructor() { FakeWS.last = this; setTimeout(() => this.onopen?.(), 0); }
  send() {}
  close() { this.readyState = 3; this.onclose?.(); }
  /** Присылает распознанную фразу так, как это делает Deepgram. */
  say(text) {
    this.onmessage?.({ data: JSON.stringify({
      type: 'Results', is_final: true, speech_final: true,
      channel: { alternatives: [{ transcript: text }] },
    })});
  }
}
globalThis.WebSocket = FakeWS;

await import('../src/main.ts');
await new Promise((r) => setTimeout(r, 100));

const hud = () => window.document.getElementById('hud-preview')?.textContent ?? '';
assert.match(hud(), /SERGEY AI/, 'стартовый экран должен нарисоваться');

if (WAKE) {
  // Ожидание должно подняться само, без тапа.
  assert.ok(FakeWS.last, 'ожидание команды должно подняться само');
  assert.match(hud(), /Скажите/, 'экран должен подсказывать про голос');

  FakeWS.last.say('сергей где поесть рядом');
  await new Promise((r) => setTimeout(r, 300));
  assert.match(hud(), /Чайхана/, 'вопрос после имени должен отработать целиком');
  console.log('✓ голосовая активация: обращение услышано, ответ получен');
  process.exit(0);
}

// Тап
window.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter' }));
await new Promise((r) => setTimeout(r, 60));
assert.match(hud(), /СЛУШАЮ/, 'тап должен включать приём вопроса');

// Имитируем распознанную фразу
const sock = FakeWS.last;
assert.ok(sock, 'распознавание должно открыться');
sock.say('где поесть рядом');
await new Promise((r) => setTimeout(r, 300));

assert.match(hud(), /Чайхана/, 'ответ должен появиться на экране');
assert.match(hud(), /АРХИТЕКТОР/, 'подпись должна стоять над ответом');
assert.equal(calls.filter((c) => c.includes('anthropic')).length, 2,
  'после инструмента модель обязана вызваться второй раз');
assert.equal(calls.filter((c) => c.includes('overpass')).length, 1,
  'инструмент карт должен отработать ровно один раз');
console.log('✓ полный цикл: тап → речь → инструмент → ответ');
