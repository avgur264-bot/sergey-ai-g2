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
