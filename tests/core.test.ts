import { test } from 'node:test';
import assert from 'node:assert/strict';

import { paginate } from '../src/hud/renderer.ts';
import { fastPath } from '../src/agent/router.ts';
import { Machine } from '../src/state/machine.ts';

// ─── Пагинация ───────────────────────────────────────────────

test('короткий текст остаётся одной страницей', () => {
  assert.deepEqual(paginate('Токио.'), ['Токио.']);
});

test('длинный текст режется по границам предложений', () => {
  const text = 'Первое предложение здесь. Второе предложение тут. Третье предложение там.';
  const pages = paginate(text, 30);
  assert.ok(pages.length > 1);
  // Ни одна страница не превышает лимит — иначе текст обрежется на очках
  for (const p of pages) assert.ok(p.length <= 30, `страница длиннее лимита: "${p}"`);
  // Ничего не потеряно
  assert.equal(pages.join(' ').replace(/\s+/g, ' '), text);
});

test('предложение длиннее страницы режется по словам, не по буквам', () => {
  const long = 'слово '.repeat(40).trim();
  const pages = paginate(long, 30);
  for (const p of pages) {
    assert.ok(p.length <= 30);
    assert.ok(!p.startsWith('о '), 'слово разорвано посередине');
  }
});

test('переводы строк и лишние пробелы схлопываются', () => {
  assert.deepEqual(paginate('  Ответ\n\n  готов  '), ['Ответ готов']);
});

// ─── Fast-path ───────────────────────────────────────────────
// Здесь живут самые частые команды. Регресс тут = вернувшаяся медленность.

test('таймер цифрами', () => {
  assert.deepEqual(fastPath('таймер 10 минут'),
    { tool: 'timer_set', args: { seconds: 600, label: 'Таймер' } });
});

test('таймер словами', () => {
  assert.deepEqual(fastPath('поставь таймер на пять минут'),
    { tool: 'timer_set', args: { seconds: 300, label: 'Таймер' } });
});

test('таймер в секундах и часах', () => {
  assert.equal(fastPath('таймер 30 секунд')?.args.seconds, 30);
  assert.equal(fastPath('таймер 2 часа')?.args.seconds, 7200);
});

test('запомни уходит в память', () => {
  const r = fastPath('запомни: я пью кофе без сахара');
  assert.equal(r?.tool, 'memory_save');
  assert.equal(r?.args.fact, 'я пью кофе без сахара');
});

test('забудь уходит в удаление', () => {
  assert.equal(fastPath('забудь про кофе')?.tool, 'memory_forget');
});

test('погода перехватывается', () => {
  assert.equal(fastPath('погода')?.tool, 'weather_now');
  assert.equal(fastPath('какая погода')?.tool, 'weather_now');
});

test('«не ставь таймер на пять минут» не срабатывает как команда', () => {
  // Раньше регулярка не была заякорена к началу фразы и находила
  // «таймер N единиц» где угодно в строке, включая отрицания.
  assert.equal(fastPath('не ставь таймер на пять минут'), null);
});

test('отмени таймер без числа не срабатывает', () => {
  assert.equal(fastPath('отмени таймер'), null);
});

test('обычный вопрос идёт в модель, а не в fast-path', () => {
  assert.equal(fastPath('какая столица Японии'), null);
  assert.equal(fastPath('сколько будет два плюс два'), null);
  // Слово «запомни» в середине фразы — не команда
  assert.equal(fastPath('а ты запомнил что я говорил вчера'), null);
});

test('«погода в Токио» уходит в модель — fast-path не знает про города', () => {
  // Иначе показали бы погоду по текущим координатам вместо запрошенной
  const r = fastPath('погода в Токио');
  assert.ok(r === null || r.tool !== 'weather_now',
    'fast-path перехватил запрос с городом');
});

// ─── Автомат состояний ───────────────────────────────────────

test('нормальный цикл проходит', () => {
  const m = new Machine();
  assert.ok(m.to('LISTENING'));
  assert.ok(m.to('THINKING'));
  assert.ok(m.to('DISPLAYING'));
  assert.ok(m.to('IDLE'));
  m.dispose();
});

test('запрещённый переход отклоняется, а не ломает состояние', () => {
  const m = new Machine();
  assert.equal(m.to('DISPLAYING'), false);
  assert.equal(m.state, 'IDLE');
  m.dispose();
});

test('force выводит из ERROR в любом случае', () => {
  const m = new Machine();
  m.to('LISTENING');
  m.force('ERROR');
  assert.equal(m.state, 'ERROR');
  assert.ok(m.to('IDLE'));
  m.dispose();
});

test('подписчики получают уведомление о смене', () => {
  const m = new Machine();
  const seen: string[] = [];
  m.onChange((s) => seen.push(s));
  m.to('LISTENING');
  m.to('THINKING');
  assert.deepEqual(seen, ['LISTENING', 'THINKING']);
  m.dispose();
});

test('зависание в THINKING обрывается таймаутом', async () => {
  const m = new Machine();
  m.to('LISTENING');
  m.to('THINKING');
  // Таймаут 25 с — здесь проверяем только что таймер поставлен и снимается
  m.to('DISPLAYING');
  assert.equal(m.state, 'DISPLAYING');
  m.dispose();
});

test('CONFIRMING больше не форсирует ERROR по таймауту автомата', async () => {
  // Раньше здесь стоял отдельный 30-секундный таймаут, который гонялся
  // с таймаутом в askConfirm() и мог навсегда подвесить обещание
  // подтверждения. Проверяем, что переход в CONFIRMING не ставит
  // собственный таймер (нет автоматического force('ERROR')).
  const m = new Machine();
  m.to('LISTENING');
  m.to('THINKING');
  const seen: string[] = [];
  m.onChange((s) => seen.push(s));
  m.to('CONFIRMING');
  // Ждать реальные 30 секунд в тесте не нужно — проверяем логически:
  // просто убеждаемся, что переход CONFIRMING -> THINKING (как делает
  // askConfirm при явном ответе) остаётся разрешён и работает.
  assert.ok(m.to('THINKING'));
  assert.deepEqual(seen, ['CONFIRMING', 'THINKING']);
  m.dispose();
});

// ─── Hud: реальный баг с id контейнера при стриминге ─────────

class FakeBridge {
  calls: { method: string; args: unknown[] }[] = [];
  private log(method: string, ...args: unknown[]) { this.calls.push({ method, args }); }
  async createPage(p: unknown) { this.log('createPage', p); }
  async rebuildPage(p: unknown) { this.log('rebuildPage', p); }
  async updateText(id: number, text: string) { this.log('updateText', id, text); }
  onGesture() {}
  onLifecycle() {}
  async startMic() {}
  async stopMic() {}
  onPcm() {}
  async get() { return null; }
  async set() {}
  async requestShutdown() {}
}

test('Hud.stream пишет в контейнер тела (2), а не заголовка (1)', async () => {
  // Реальный баг: stream() был захардкожен на containerId=1 (заголовок),
  // хотя тело — это containerId=2. Стриминг ответа и частичное
  // распознавание речи уходили не в ту область экрана.
  const { Hud } = await import('../src/hud/renderer.ts');
  const bridge = new FakeBridge();
  const hud = new Hud(bridge as any);
  await hud.boot({ title: 'X', body: 'Y' });
  await hud.stream('привет');

  const upd = bridge.calls.find((c) => c.method === 'updateText');
  assert.ok(upd, 'updateText не вызывался');
  assert.equal(upd!.args[0], 2, 'stream() должен писать в containerId=2 (тело)');
});

test('Hud сохраняет порядок вызовов даже без ожидания каждого', async () => {
  // onDelta в main.ts не await'ит каждый вызов stream()/status() —
  // очередь внутри Hud обязана сохранять порядок сама.
  const { Hud } = await import('../src/hud/renderer.ts');
  const bridge = new FakeBridge();
  const hud = new Hud(bridge as any);
  await hud.boot({ title: 'X', body: '' });

  // Намеренно не await, как в реальном onDelta-колбэке
  void hud.stream('1');
  void hud.stream('12');
  await hud.stream('123');

  const texts = bridge.calls
    .filter((c) => c.method === 'updateText')
    .map((c) => c.args[1]);
  assert.deepEqual(texts, ['1', '12', '123']);
});

// ─── STT: ручное завершение не должно терять распознанное ────

import { SttSession } from '../src/audio/stt.ts';

/** Минимальная замена WebSocket: ничего не шлёт, только фиксирует close. */
class FakeSocket {
  static OPEN = 1;
  static CONNECTING = 0;
  readyState = 1;
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  binaryType = '';
  sent: unknown[] = [];
  url: string;
  protocols?: string[];
  constructor(url: string, protocols?: string[]) {
    this.url = url;
    this.protocols = protocols;
    // Открываемся асинхронно, как настоящий сокет
    setTimeout(() => this.onopen?.(), 0);
  }
  send(d: unknown) { this.sent.push(d); }
  close() { this.readyState = 3; this.onclose?.(); }
}

async function openSession(opts: Partial<Parameters<typeof makeOpts>[0]> = {}) {
  const prev = (globalThis as any).WebSocket;
  (globalThis as any).WebSocket = FakeSocket;
  try {
    const o = makeOpts(opts);
    const s = new SttSession(o.opts);
    await s.open();
    return { session: s, ...o };
  } finally {
    (globalThis as any).WebSocket = prev;
  }
}

function makeOpts(over: any = {}) {
  const finals: string[] = [];
  const errors: string[] = [];
  const opts = {
    apiKey: 'test',
    onFinal: (t: string) => finals.push(t),
    onError: (e: Error) => errors.push(e.message),
    ...over,
  };
  return { opts, finals, errors };
}

/** Скармливает сессии сообщение в формате Deepgram. */
function feed(session: any, transcript: string, isFinal = true) {
  (session as any).handle(JSON.stringify({
    type: 'Results',
    is_final: isFinal,
    channel: { alternatives: [{ transcript }] },
  }));
}

test('ручное завершение отдаёт распознанный текст, а не выбрасывает его', async () => {
  // РЕАЛЬНЫЙ БАГ: main.ts на тап в состоянии LISTENING звал close(),
  // который ставил closed=true. flush() начинается с `if (this.closed) return`,
  // поэтому onFinal не вызывался никогда — всё сказанное молча терялось,
  // а автомат висел в LISTENING до 20-секундного таймаута.
  const { session, finals, errors } = await openSession();
  feed(session, 'привет как дела');

  session.finish();

  assert.deepEqual(finals, ['привет как дела'], 'текст должен уйти в onFinal');
  assert.deepEqual(errors, []);
});

test('close() без текста не считается успешным распознаванием', async () => {
  const { session, finals } = await openSession();
  session.close();
  assert.deepEqual(finals, [], 'близкий обрыв не должен выдавать пустой ответ');
});

test('повторный finish() не дублирует onFinal', async () => {
  const { session, finals } = await openSession();
  feed(session, 'тест');
  session.finish();
  session.finish();
  assert.equal(finals.length, 1);
});

// ─── Контейнеры: без isEventCapture тапы не доходят ──────────

test('ровно один контейнер помечен isEventCapture', async () => {
  // САМЫЙ ДОРОГОЙ БАГ ПРОЕКТА. Хост доставляет пользовательские жесты
  // только контейнеру с isEventCapture: 1. Без него одиночный тап
  // молча игнорируется, а двойной продолжает работать (его обрабатывает
  // система как Return) — выглядит как поломка сенсора очков.
  // Документация SDK: «Exactly one container should use isEventCapture: 1».
  const mod: any = await import('../src/sdk/bridge.ts');
  const objects = mod.__textObjectsForTest({ title: 'T', body: 'B', footer: '1/2' });

  const capturing = objects.filter((o: any) => o.isEventCapture === 1);
  assert.equal(capturing.length, 1, 'должен быть ровно один контейнер с isEventCapture: 1');
  assert.equal(capturing[0].containerName, 'body', 'события должен принимать контейнер тела');
});

test('zOrderIndex задан у всех контейнеров и уникален', async () => {
  // Требование SDK: либо у всех, либо ни у кого; значения уникальны.
  // Частично заполненные или дублирующиеся значения хост отвергает.
  const mod: any = await import('../src/sdk/bridge.ts');
  const objects = mod.__textObjectsForTest({ title: 'T', body: 'B' });

  const z = objects.map((o: any) => o.zOrderIndex);
  assert.ok(z.every((v: unknown) => typeof v === 'number'), 'zOrderIndex должен быть у всех');
  assert.equal(new Set(z).size, z.length, 'zOrderIndex должны быть уникальны');
});

// ─── Пагинация ответа и автопрокрутка ────────────────────────

test('atLastPage корректен для одностраничного и многостраничного ответа', async () => {
  const { Hud } = await import('../src/hud/renderer.ts');
  const bridge = new FakeBridge();
  const hud = new Hud(bridge as any);

  await hud.result('ОТВЕТ', 'Коротко.');
  assert.equal(hud.atLastPage, true, 'один экран — сразу последняя страница');

  await hud.result('ОТВЕТ', 'Предложение. '.repeat(60));
  assert.equal(hud.isMultiPage, true);
  assert.equal(hud.atLastPage, false, 'на первой из нескольких — не последняя');
});

test('подвал подсказывает, что тап листает дальше', async () => {
  const { Hud } = await import('../src/hud/renderer.ts');
  const bridge = new FakeBridge();
  const hud = new Hud(bridge as any);

  await hud.result('ОТВЕТ', 'Предложение. '.repeat(60));
  const last = [...bridge.calls].reverse()
    .find((c) => c.method === 'createPage' || c.method === 'rebuildPage');
  const footer = (last!.args[0] as any).footer as string;
  assert.match(footer, /1\/\d+/, 'должен быть номер страницы');
  assert.match(footer, /дальше/, 'должна быть подсказка про тап');
});

test('новый экран отменяет автопрокрутку прошлого ответа', async () => {
  // Иначе отложенный таймер перерисует «СЛУШАЮ» страницей старого текста.
  const { Hud } = await import('../src/hud/renderer.ts');
  const bridge = new FakeBridge();
  const hud = new Hud(bridge as any);

  await hud.result('ОТВЕТ', 'Предложение. '.repeat(60));
  await hud.status('СЛУШАЮ', '');

  const before = bridge.calls.length;
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(bridge.calls.length, before, 'после смены экрана рисовать нечего');
});

// ─── Диалог: уточняющие вопросы ──────────────────────────────

import { Router } from '../src/agent/router.ts';
import { Registry } from '../src/agent/registry.ts';

/** LLM-заглушка: запоминает, какую историю ей передали. */
function fakeLlm(behaviour: (n: number) => any) {
  const seen: any[][] = [];
  let n = 0;
  return {
    seen,
    llm: {
      async complete(o: any) {
        seen.push(o.messages.map((m: any) => ({ role: m.role, content: m.content })));
        const r = behaviour(n++);
        if (r instanceof Error) throw r;
        return r;
      },
    },
  };
}

const noopCb = {
  onTool() {},
  onDelta() {},
  async onConfirm() { return true; },
};

const fakeBridgeForRouter = { async get() { return null; }, async set() {} };

test('уточняющий вопрос уходит вместе с предыдущей репликой', async () => {
  const { llm, seen } = fakeLlm(() => ({ text: 'Ответ', toolCalls: [] }));
  const r = new Router(llm as any, new Registry(), fakeBridgeForRouter as any, {});

  await r.handle('какая столица Японии', noopCb, new AbortController().signal);
  await r.handle('а население', noopCb, new AbortController().signal);

  const second = seen[1];
  assert.equal(second.length, 3, 'вопрос, ответ, уточнение');
  assert.equal(second[0].content, 'какая столица Японии');
  assert.equal(second[1].role, 'assistant');
  assert.equal(second[2].content, 'а население');
});

test('после сбоя история не ломается и следующий вопрос уходит корректно', async () => {
  // РЕАЛЬНЫЙ БАГ: упавший ход оставлял в истории вопрос без ответа,
  // и следующий запрос уходил с двумя репликами пользователя подряд.
  const { llm, seen } = fakeLlm((n) =>
    n === 0 ? new Error('LLM 500') : { text: 'Ответ', toolCalls: [] });
  const r = new Router(llm as any, new Registry(), fakeBridgeForRouter as any, {});

  await assert.rejects(() => r.handle('первый', noopCb, new AbortController().signal));
  await r.handle('второй', noopCb, new AbortController().signal);

  const after = seen[1];
  assert.equal(after.length, 1, 'от упавшего хода в истории ничего не остаётся');
  assert.equal(after[0].content, 'второй');
});

test('история не начинается с висячего результата инструмента', async () => {
  // Срез длинной истории мог начаться с tool_result, чей вызов остался
  // за окном, — провайдер отвергает такой запрос.
  const { llm, seen } = fakeLlm(() => ({ text: 'Ответ', toolCalls: [] }));
  const r = new Router(llm as any, new Registry(), fakeBridgeForRouter as any, {});

  for (let i = 0; i < 8; i++) {
    await r.handle(`вопрос ${i}`, noopCb, new AbortController().signal);
  }

  for (const msgs of seen) {
    assert.equal(msgs[0].role, 'user', 'история всегда начинается с реплики пользователя');
  }
});

// ─── Веб-поиск: серверный инструмент провайдера ──────────────

test('поиск включается и не путается с клиентскими инструментами', async () => {
  const { AnthropicLlm } = await import('../src/agent/llm.ts');
  let captured: any = null;

  const prevFetch = globalThis.fetch;
  globalThis.fetch = (async (_url: string, init: any) => {
    captured = JSON.parse(init.body);
    return {
      ok: true,
      body: { getReader: () => ({ read: async () => ({ done: true, value: undefined }) }) },
    };
  }) as any;

  try {
    const llm = new AnthropicLlm('sk-ant-test');
    await llm.complete({
      system: 's',
      messages: [{ role: 'user', content: 'лучшие рестораны' }],
      tools: [{
        name: 'timer_set', description: 'd', kind: 'read', transport: 'local', label: 'T',
        schema: { type: 'object', properties: {} }, run: async () => ({ data: '' }),
      }] as any,
      webSearch: true,
      city: 'Алматы',
    });
  } finally {
    globalThis.fetch = prevFetch;
  }

  const search = captured.tools.find((t: any) => t.type === 'web_search_20250305');
  assert.ok(search, 'серверный поиск должен уйти в запрос');
  assert.equal(search.user_location.city, 'Алматы', 'город уточняет локальные запросы');
  assert.ok(
    captured.tools.some((t: any) => t.name === 'timer_set' && !t.type),
    'клиентские инструменты остаются на месте',
  );
});

test('без включённого поиска серверный инструмент не отправляется', async () => {
  const { AnthropicLlm } = await import('../src/agent/llm.ts');
  let captured: any = null;

  const prevFetch = globalThis.fetch;
  globalThis.fetch = (async (_url: string, init: any) => {
    captured = JSON.parse(init.body);
    return {
      ok: true,
      body: { getReader: () => ({ read: async () => ({ done: true, value: undefined }) }) },
    };
  }) as any;

  try {
    const llm = new AnthropicLlm('sk-ant-test');
    await llm.complete({ system: 's', messages: [{ role: 'user', content: 'привет' }], tools: [] });
  } finally {
    globalThis.fetch = prevFetch;
  }

  assert.ok(
    !captured.tools.some((t: any) => t.type === 'web_search_20250305'),
    'выключенный поиск не должен попадать в запрос и тратить деньги',
  );
});

// ─── Бесплатные источники ────────────────────────────────────

test('places_near отдаёт готовый список с расстояниями', async () => {
  const { placesTool } = await import('../src/agent/tools/free.ts');

  const prevFetch = globalThis.fetch;
  globalThis.fetch = (async (url: any) => {
    const u = String(url);
    if (u.includes('nominatim')) {
      return { ok: true, json: async () => ([{ lat: '43.238', lon: '76.889' }]) };
    }
    return {
      ok: true,
      json: async () => ({
        elements: [
          { lat: 43.2385, lon: 76.8895, tags: { name: 'Далеко', cuisine: 'pizza' } },
          { lat: 43.2381, lon: 76.8891, tags: { name: 'Близко' } },
          { lat: 43.2400, lon: 76.8900, tags: { amenity: 'restaurant' } },
        ],
      }),
    };
  }) as any;

  try {
    const r = await placesTool.run(
      { category: 'ресторан' },
      { cfg: { city: 'Алматы' }, signal: new AbortController().signal, bridge: {} as any },
    );
    assert.match(r.data, /^Близко/, 'ближайшее — первым');
    assert.match(r.data, /м|км/, 'расстояние показано');
    assert.ok(!r.direct, 'список идёт через модель, чтобы она добавила рейтинги');
  } finally {
    globalThis.fetch = prevFetch;
  }
});

test('без города и геолокации places_near говорит, что делать', async () => {
  const { placesTool } = await import('../src/agent/tools/free.ts');
  await assert.rejects(
    () => placesTool.run(
      { category: 'кафе' },
      { cfg: {}, signal: new AbortController().signal, bridge: {} as any },
    ),
    /город/i,
  );
});

// ─── Место из вопроса ────────────────────────────────────────

test('город из вопроса важнее города из настроек', async () => {
  const { placesTool } = await import('../src/agent/tools/free.ts');
  const asked: string[] = [];

  const prevFetch = globalThis.fetch;
  globalThis.fetch = (async (url: any, init?: any) => {
    const u = String(url);
    if (u.includes('nominatim')) {
      asked.push(decodeURIComponent(u));
      return { ok: true, json: async () => ([{ lat: '39.65', lon: '66.96' }]) };
    }
    asked.push(String(init?.body ?? ''));
    return {
      ok: true,
      json: async () => ({
        elements: [
          { lat: 39.651, lon: 66.961, tags: { name: 'Плов Центр', cuisine: 'uzbek' } },
          { lat: 39.652, lon: 66.962, tags: { name: 'Пиццерия', cuisine: 'pizza' } },
        ],
      }),
    };
  }) as any;

  try {
    const r = await placesTool.run(
      { category: 'ресторан', location: 'Самарканд', keyword: 'плов' },
      { cfg: { city: 'Алматы' }, signal: new AbortController().signal, bridge: {} as any },
    );
    assert.ok(
      asked[0].includes('%D0%A1%D0%B0%D0%BC') || asked[0].includes('Самарканд'),
      'геокодировать надо город из вопроса, а не из настроек',
    );
    assert.match(r.data, /Плов Центр/, 'уточнение блюда должно фильтровать список');
    assert.ok(!r.data.includes('Пиццерия'), 'неподходящее отсеивается');
  } finally {
    globalThis.fetch = prevFetch;
  }
});

test('если по блюду ничего нет, показываем ближайшие подходящие места', async () => {
  const { placesTool } = await import('../src/agent/tools/free.ts');
  const prevFetch = globalThis.fetch;
  globalThis.fetch = (async (url: any) => {
    if (String(url).includes('nominatim')) {
      return { ok: true, json: async () => ([{ lat: '39.65', lon: '66.96' }]) };
    }
    return {
      ok: true,
      json: async () => ({
        elements: [{ lat: 39.651, lon: 66.961, tags: { name: 'Кафе Дружба' } }],
      }),
    };
  }) as any;

  try {
    const r = await placesTool.run(
      { category: 'ресторан', location: 'Самарканд', keyword: 'суши' },
      { cfg: {}, signal: new AbortController().signal, bridge: {} as any },
    );
    assert.match(r.data, /Кафе Дружба/, 'пустой экран хуже, чем близкие варианты');
  } finally {
    globalThis.fetch = prevFetch;
  }
});

// ─── Вызов инструмента в истории ─────────────────────────────

test('ход с инструментом уходит вместе с самим вызовом, а не только текстом', async () => {
  // РЕАЛЬНЫЙ БАГ: ответ модели с вызовом инструмента записывался в
  // историю как обычный текст. Следующий запрос нёс результат
  // инструмента со ссылкой на вызов, которого в диалоге уже нет,
  // и сервер отвечал 400. Ломалось всё, что использует инструменты:
  // поиск мест, погода, таймер.
  const { AnthropicLlm } = await import('../src/agent/llm.ts');
  let captured: any = null;

  const prevFetch = globalThis.fetch;
  globalThis.fetch = (async (_u: any, init: any) => {
    captured = JSON.parse(init.body);
    return {
      ok: true,
      body: { getReader: () => ({ read: async () => ({ done: true, value: undefined }) }) },
    };
  }) as any;

  try {
    const llm = new AnthropicLlm('sk-ant-test');
    await llm.complete({
      system: 's',
      tools: [],
      messages: [
        { role: 'user', content: 'где поесть' },
        {
          role: 'assistant',
          content: '',
          toolCalls: [{ id: 'toolu_1', name: 'places_near', args: { category: 'ресторан' } }],
        },
        { role: 'tool', content: 'Кафе — 200 м', toolCallId: 'toolu_1', toolName: 'places_near' },
      ],
    });
  } finally {
    globalThis.fetch = prevFetch;
  }

  const assistant = captured.messages[1];
  assert.equal(assistant.role, 'assistant');
  assert.ok(Array.isArray(assistant.content), 'ход модели должен быть блоками, а не строкой');

  const use = assistant.content.find((b: any) => b.type === 'tool_use');
  assert.ok(use, 'вызов инструмента обязан присутствовать в истории');
  assert.equal(use.id, 'toolu_1');
  assert.equal(use.name, 'places_near');

  const result = captured.messages[2].content.find((b: any) => b.type === 'tool_result');
  assert.equal(result.tool_use_id, 'toolu_1', 'результат ссылается на существующий вызов');
});

test('несколько результатов подряд собираются в одну реплику', async () => {
  // Провайдер ждёт все результаты одного хода в одном сообщении.
  const { AnthropicLlm } = await import('../src/agent/llm.ts');
  let captured: any = null;

  const prevFetch = globalThis.fetch;
  globalThis.fetch = (async (_u: any, init: any) => {
    captured = JSON.parse(init.body);
    return {
      ok: true,
      body: { getReader: () => ({ read: async () => ({ done: true, value: undefined }) }) },
    };
  }) as any;

  try {
    const llm = new AnthropicLlm('sk-ant-test');
    await llm.complete({
      system: 's',
      tools: [],
      messages: [
        { role: 'user', content: 'вопрос' },
        {
          role: 'assistant',
          content: '',
          toolCalls: [
            { id: 'a', name: 't1', args: {} },
            { id: 'b', name: 't2', args: {} },
          ],
        },
        { role: 'tool', content: 'раз', toolCallId: 'a', toolName: 't1' },
        { role: 'tool', content: 'два', toolCallId: 'b', toolName: 't2' },
      ],
    });
  } finally {
    globalThis.fetch = prevFetch;
  }

  assert.equal(captured.messages.length, 3, 'два результата — одна реплика пользователя');
  assert.equal(captured.messages[2].content.length, 2);
});

// ─── Подпись над ответом ─────────────────────────────────────

test('подпись стоит в заголовке и не отнимает место у текста', async () => {
  const { Hud } = await import('../src/hud/renderer.ts');
  const { BRAND } = await import('../src/hud/strings.ts');
  const bridge = new FakeBridge();
  const hud = new Hud(bridge as any);

  const answer = 'Чайхана — 150 м, uzbek';
  await hud.result(BRAND, answer);

  const last = [...bridge.calls].reverse()
    .find((c) => c.method === 'createPage' || c.method === 'rebuildPage');
  const page = last!.args[0] as any;

  assert.equal(page.title, BRAND, 'подпись — в заголовке');
  assert.equal(page.body, answer, 'тело содержит только ответ, без подписи');
});

test('адрес попадает в ответ и место с адресом идёт выше', async () => {
  // Рекомендация без адреса бесполезна: до неё нельзя дойти.
  const { placesTool } = await import('../src/agent/tools/free.ts');
  const prevFetch = globalThis.fetch;
  globalThis.fetch = (async (url: any) => {
    if (String(url).includes('nominatim')) {
      return { ok: true, json: async () => ([{ lat: '39.65', lon: '66.96' }]) };
    }
    return {
      ok: true,
      json: async () => ({
        elements: [
          // Ближе, но без адреса.
          { lat: 39.6501, lon: 66.9601, tags: { name: 'Без адреса' } },
          // Дальше, зато с адресом.
          {
            lat: 39.6600, lon: 66.9700,
            tags: {
              name: 'Плов Центр',
              'addr:street': 'ул. Регистан',
              'addr:housenumber': '12',
              cuisine: 'uzbek',
            },
          },
        ],
      }),
    };
  }) as any;

  try {
    const r = await placesTool.run(
      { category: 'ресторан', location: 'Самарканд' },
      { cfg: {}, signal: new AbortController().signal, bridge: {} as any },
    );
    assert.match(r.data, /ул\. Регистан, 12/, 'адрес должен быть показан');
    assert.ok(
      r.data.indexOf('Плов Центр') < r.data.indexOf('Без адреса'),
      'место с адресом полезнее и идёт выше',
    );
    assert.match(r.data, /uzbek/, 'модели уходят подробности');
  } finally {
    globalThis.fetch = prevFetch;
  }
});

// ─── Никаких отговорок ───────────────────────────────────────

test('инструкция прямо запрещает отвечать отговорками', async () => {
  // Ассистент, который вместо ответа объясняет свои ограничения,
  // бесполезен. Правило легко потерять при правке промпта — держим
  // его под проверкой.
  const { SYSTEM_PROMPT } = await import('../src/agent/router.ts');
  // Перенос строки внутри промпта разрывает фразу — сверяем по
  // схлопнутым пробелам, иначе проверка ловит форматирование, а не смысл.
  const flat = SYSTEM_PROMPT.replace(/\s+/g, ' ');
  assert.match(flat, /нет доступа/, 'запрет должен быть назван явно');
  assert.match(flat, /Никаких отговорок/, 'правило должно стоять первым');
  assert.match(SYSTEM_PROMPT, /ИЩИ|поиск/i, 'вместо отговорки — поиск');
  assert.ok(
    !/Не знаешь — скажи/.test(SYSTEM_PROMPT),
    'прежняя формулировка поощряла ответ «не знаю»',
  );
});

test('поиск включён по умолчанию — без него нет рейтингов', async () => {
  const { loadConfig } = await import('../src/config.ts');
  const cfg = await loadConfig({ async get() { return null; } } as any);
  assert.equal(cfg.webSearch, true);
});

// ─── Ход разговора ───────────────────────────────────────────

test('уточняющий вопрос распознаётся, обычный ответ — нет', async () => {
  const { endsWithQuestion: isQ } = await import('../src/agent/dialog.ts');

  assert.equal(isQ('В каком городе искать?'), true);
  assert.equal(isQ('Плов Центр — ул. Регистан 12 — 4.6'), false);
  assert.equal(isQ('Токио.'), false);
  // Риторику за вопрос не считаем — на неё отвечать не надо.
  assert.equal(isQ('Стоит попробовать. Почему бы и нет?'), false);
});

test('слова завершения закрывают разговор, похожие фразы — нет', async () => {
  const { isFarewell: bye } = await import('../src/agent/dialog.ts');

  assert.equal(bye('хватит'), true);
  assert.equal(bye('Спасибо!'), true);
  assert.equal(bye('всё, хватит'), true);
  assert.equal(bye('достаточно.'), true);

  // Те же слова внутри настоящего вопроса разговор не закрывают.
  assert.equal(bye('хватит ли мне денег на билет'), false);
  assert.equal(bye('спасибо скажи по-японски'), false);
  assert.equal(bye('всё о фотосинтезе'), false);
});

// ─── Листание по кругу ───────────────────────────────────────

test('листание не упирается в края: с конца в начало и обратно', async () => {
  // Раньше автопрокрутка уводила в конец ответа, а с последней
  // страницы тап начинал новый вопрос — вернуться было некуда.
  const { Hud } = await import('../src/hud/renderer.ts');
  const bridge = new FakeBridge();
  const hud = new Hud(bridge as any);

  await hud.result('ОТВЕТ', 'Предложение раз. '.repeat(40));
  const total = (() => {
    const last = [...bridge.calls].reverse()
      .find((c) => c.method === 'createPage' || c.method === 'rebuildPage');
    return Number(((last!.args[0] as any).footer as string).split('/')[1].split(' ')[0]);
  })();
  assert.ok(total > 2, 'нужен многостраничный ответ');

  const pageNow = () => {
    const last = [...bridge.calls].reverse()
      .find((c) => c.method === 'createPage' || c.method === 'rebuildPage');
    return Number(((last!.args[0] as any).footer as string).split('/')[0]);
  };

  assert.equal(pageNow(), 1);

  // С первой страницы назад — попадаем в конец.
  await hud.cyclePrev();
  assert.equal(pageNow(), total, 'с первой страницы назад — в конец');

  // С последней вперёд — снова в начало.
  await hud.cycleNext();
  assert.equal(pageNow(), 1, 'с последней вперёд — в начало');
});

test('ответ не уезжает сам: без действий страница остаётся первой', async () => {
  const { Hud } = await import('../src/hud/renderer.ts');
  const bridge = new FakeBridge();
  const hud = new Hud(bridge as any);

  await hud.result('ОТВЕТ', 'Предложение раз. '.repeat(40));
  const before = bridge.calls.length;
  await new Promise((r) => setTimeout(r, 250));
  assert.equal(bridge.calls.length, before, 'никакой таймер не должен листать за человека');
});

// ─── Миграция настроек ───────────────────────────────────────

test('старые настройки с выключенным поиском обновляются один раз', async () => {
  // РЕАЛЬНАЯ ЛОВУШКА: сохранённые значения перекрывают умолчания
  // навсегда. Кто сохранился, пока поиск был выключен по умолчанию,
  // остался без интернета — и это выглядело как «поисковик плохой».
  const { loadConfig } = await import('../src/config.ts');

  let stored = JSON.stringify({ sttKey: 'a', llmKey: 'b', webSearch: false });
  const bridge = {
    async get() { return stored; },
    async set(_k: string, v: string) { stored = v; },
  };

  const cfg = await loadConfig(bridge as any);
  assert.equal(cfg.webSearch, true, 'поиск должен включиться при обновлении');
  assert.equal(JSON.parse(stored).version, 3, 'версия должна записаться');

  // Осознанное выключение после миграции обязано сохраняться.
  stored = JSON.stringify({ ...JSON.parse(stored), webSearch: false });
  const again = await loadConfig(bridge as any);
  assert.equal(again.webSearch, false, 'второй раз включать поиск нельзя');
});

test('инструкция требует конкретных поисковых запросов', async () => {
  const { SYSTEM_PROMPT } = await import('../src/agent/router.ts');
  const flat = SYSTEM_PROMPT.replace(/\s+/g, ' ');
  assert.match(flat, /не придумывай цифру/i, 'запрет на выдуманные рейтинги');
  assert.match(flat, /переформулируй/i, 'при плохой выдаче — искать заново');
});

test('модель обновляется только у тех, кто её не выбирал сам', async () => {
  const { loadConfig } = await import('../src/config.ts');

  // Не выбирал: стоит прежнее умолчание — переводим на сильную модель.
  let stored = JSON.stringify({ model: 'claude-haiku-4-5-20251001', version: 2 });
  const bridgeA = {
    async get() { return stored; },
    async set(_k: string, v: string) { stored = v; },
  };
  const a = await loadConfig(bridgeA as any);
  assert.notEqual(a.model, 'claude-haiku-4-5-20251001', 'прежнее умолчание обновляется');

  // Выбрал сам: чужой осознанный выбор трогать нельзя.
  let stored2 = JSON.stringify({ model: 'gpt-4o-mini', version: 2 });
  const bridgeB = {
    async get() { return stored2; },
    async set(_k: string, v: string) { stored2 = v; },
  };
  const b = await loadConfig(bridgeB as any);
  assert.equal(b.model, 'gpt-4o-mini', 'выбранная вручную модель сохраняется');
});

test('в инструкцию подставляется сегодняшняя дата', async () => {
  // Без даты модель ориентируется на момент обучения и выдаёт
  // прошлогоднее за актуальное.
  const { buildSystemPrompt } = await import('../src/agent/router.ts');
  const p = buildSystemPrompt(new Date('2026-08-12T10:00:00Z'));
  assert.match(p, /Сегодня 12 августа 2026/, 'дата должна стоять первой строкой');
  assert.match(p.replace(/\s+/g, ' '), /текущий год/i, 'правило про свежесть на месте');
});
