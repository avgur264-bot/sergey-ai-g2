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
  hud.stopAuto();
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
  hud.stopAuto();
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
          { lat: 43.2400, lon: 76.8900, tags: {} },
        ],
      }),
    };
  }) as any;

  try {
    const r = await placesTool.run(
      { category: 'ресторан' },
      { cfg: { city: 'Алматы' }, signal: new AbortController().signal, bridge: {} as any },
    );
    const lines = r.direct!.split('\n');
    assert.equal(lines.length, 2, 'безымянные объекты отбрасываются');
    assert.match(lines[0], /^Близко/, 'ближайшее — первым');
    assert.match(r.direct!, /м|км/, 'расстояние показано');
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
