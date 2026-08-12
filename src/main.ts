import { getBridge, type Bridge, type Gesture } from './sdk/bridge.ts';
import { Hud } from './hud/renderer.ts';
import { Machine } from './state/machine.ts';
import { SttSession } from './audio/stt.ts';
import { AnthropicLlm, OpenAiLlm, type Llm } from './agent/llm.ts';
import { Registry } from './agent/registry.ts';
import { defaultTools } from './agent/tools/index.ts';
import { Router } from './agent/router.ts';
import { ERR, BRAND } from './hud/strings.ts';
import { endsWithQuestion, isFarewell } from './agent/dialog.ts';
import { loadConfig, type Config } from './config.ts';

let bridge: Bridge;
let hud: Hud;
let fsm: Machine;
let router: Router;
let cfg: Config;

let stt: SttSession | null = null;
let abort: AbortController | null = null;
let pendingConfirm: ((ok: boolean) => void) | null = null;

// ─────────────────────────────────────────────────────────────

async function main() {
  bridge = await getBridge();
  hud = new Hud(bridge);
  fsm = new Machine();

  cfg = await loadConfig(bridge);

  // Без ключей смысла запускаться нет — но и чёрного экрана быть не должно.
  if (!cfg.sttKey || !cfg.llmKey) {
    await hud.boot({
      title: 'SERGEY AI',
      body: 'Откройте настройки на телефоне и введите ключи API.',
    });
    return;
  }

  router = buildRouter();

  bridge.onGesture(onGesture);
  bridge.onLifecycle(onLifecycle);
  fsm.onChange(onStateChange);

  // Возврат со страницы настроек не перезапускает приложение: WebView
  // отдаёт эту страницу из кэша, main() повторно не выполняется, и в
  // памяти остаются ключи, прочитанные при первом открытии. Человек
  // правит ключ, жмёт «Сохранить», возвращается — а работает всё ещё
  // старый. Поэтому перечитываем конфиг каждый раз, когда страница
  // снова становится видимой.
  const refresh = () => { void reloadConfig(); };
  window.addEventListener('pageshow', refresh);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) refresh();
  });

  window.addEventListener('sergey:timer', (e: any) => {
    hud.status('ТАЙМЕР', e.detail?.name ?? 'Время вышло');
  });

  await hud.boot({ title: 'SERGEY AI', body: 'Тап — говорить', footer: '' });
  void startWake();
}

/** Подхватывает изменённые настройки без перезапуска приложения. */
async function reloadConfig() {
  const next = await loadConfig(bridge);
  const changed =
    next.llmKey !== cfg.llmKey ||
    next.sttKey !== cfg.sttKey ||
    next.provider !== cfg.provider ||
    next.model !== cfg.model ||
    next.baseUrl !== cfg.baseUrl;

  cfg = next;
  if (!changed) return;

  if (!cfg.sttKey || !cfg.llmKey) {
    await hud.status('SERGEY AI', 'Откройте настройки на телефоне и введите ключи API.');
    return;
  }

  router = buildRouter();
  await stopWake();
  if (fsm.state === 'IDLE' || fsm.state === 'ERROR') {
    fsm.force('IDLE');
  }
}

function buildRouter(): Router {
  const llm: Llm = cfg.provider === 'openai'
    ? new OpenAiLlm(cfg.llmKey, cfg.model, cfg.baseUrl)
    : new AnthropicLlm(cfg.llmKey, cfg.model, cfg.baseUrl);
  const registry = new Registry().add(...defaultTools);
  return new Router(llm, registry, bridge, cfg as any);
}

// ─────────────────────────────────────────────────────────────
// Жесты
// ─────────────────────────────────────────────────────────────

async function onGesture(g: Gesture) {
  // Двойной тап на корневом экране обязан отдавать управление системе.
  // Свой диалог выхода здесь не проходит ревью и ломает запуск других
  // приложений без перезагрузки очков.
  if (g.type === 'double_click' && fsm.state === 'IDLE') {
    await bridge.requestShutdown();
    return;
  }

  // Подтверждение изменяющего действия
  if (fsm.state === 'CONFIRMING') {
    if (g.type === 'click') resolveConfirm(true);
    if (g.type === 'scroll_down' || g.type === 'double_click') resolveConfirm(false);
    return;
  }

  // Вне корневого экрана двойной тап — это «назад», как и во всей системе
  // Even (Gesture customization: Double tap = Return). Без этой ветки он
  // просто проваливался в switch и не делал ничего: из показанного ответа
  // или из зависшего «ДУМАЮ» нельзя было выйти ничем, кроме таймаута.
  if (g.type === 'double_click') {
    cancel();
    return;
  }

  switch (g.type) {
    case 'click':
      if (fsm.state === 'DISPLAYING' && !hud.atLastPage) {
        // Пока ответ не дочитан, тап листает его дальше. Начинать новый
        // вопрос с середины чужого ответа человек почти никогда не хочет,
        // а свайп может не долететь — тап надёжнее.
        await hud.cycleNext();
      }
      else if (fsm.state === 'IDLE' || fsm.state === 'DISPLAYING') await startListening();
      else if (fsm.state === 'LISTENING') stt?.finish();       // ручное завершение
      else if (fsm.state === 'THINKING') cancel();             // прервать
      else if (fsm.state === 'ERROR') fsm.force('IDLE');       // «Тап — повторить»
      break;

    // Свайпы листают по кругу в обе стороны: с последней страницы
    // можно вернуться в начало, с первой — сразу в конец. Ни один край
    // не становится тупиком.
    case 'scroll_up':
      if (fsm.state === 'DISPLAYING') await hud.cyclePrev();
      break;

    case 'scroll_down':
      if (fsm.state === 'DISPLAYING') await hud.cycleNext();
      break;
  }
}

function onLifecycle(e: string) {
  // Забытый включённый микрофон = разряженные очки за пару часов.
  if (e === 'foreground_exit' || e === 'force_exit') {
    void stopWake();
    stt?.close();
    void setMic(false);
    cancel();
  }
}

let errorExitTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Причина текущей ошибки. Раньше её показывали в catch, а следующей же
 * строкой звали force('ERROR') — и обработчик состояния немедленно
 * затирал точное сообщение общим «ОШИБКА». Диагностика уничтожалась
 * ровно в тот момент, когда она нужнее всего.
 */
let pendingError: { title: string; body: string } | null = null;

/** Показать конкретную ошибку и уйти в состояние ERROR, не потеряв текст. */
function failWith(kind: { title: string; body: string }, cause?: unknown) {
  // Короткий технический хвост помогает понять, что именно сломалось:
  // «МОДЕЛЬ НЕДОСТУПНА» без кода ответа не отличить от «нет сети».
  const detail = shortReason(cause);
  pendingError = {
    title: kind.title,
    body: detail ? `${kind.body}\n${detail}` : kind.body,
  };
  fsm.force('ERROR');
}

/** Первая строка причины, обрезанная до читаемого на HUD размера. */
function shortReason(e: unknown): string {
  const m = String((e as any)?.message ?? '').split('\n')[0].trim();
  if (!m) return '';
  return m.length > 90 ? m.slice(0, 89) + '…' : m;
}

async function onStateChange(s: string) {
  // Любой уход из ERROR снимает отложенный автовыход. Без этого таймер
  // доживал до конца и звал force('IDLE') уже поверх нового состояния:
  // тап сразу после ошибки начинал запись, а через пару секунд
  // просроченный таймер молча её обрывал.
  if (s !== 'ERROR' && errorExitTimer) {
    clearTimeout(errorExitTimer);
    errorExitTimer = null;
  }

  if (s === 'ERROR') {
    const screen = pendingError ?? ERR.generic;
    pendingError = null;
    await hud.status(screen.title, screen.body);
    stt?.close();
    await setMic(false);
    if (errorExitTimer) clearTimeout(errorExitTimer);
    // Ошибку с подробностями держим на экране дольше — её надо успеть
    // прочитать, а не поймать взглядом за две секунды.
    errorExitTimer = setTimeout(() => {
      errorExitTimer = null;
      fsm.force('IDLE');
    }, 8000);
  }
  if (s === 'IDLE') {
    await hud.status('SERGEY AI', 'Тап — говорить');
    void startWake();
  } else {
    void stopWake();
  }
}

// ─────────────────────────────────────────────────────────────
// Микрофон
// ─────────────────────────────────────────────────────────────

/**
 * Микрофоном командуют из нескольких мест: ожидание голосовой команды,
 * приём вопроса, обработка ошибок, уход в фон. Вызовы асинхронные, и без
 * общей очереди они могут дойти до очков не в том порядке — например,
 * запоздавшее «выключить» от закрытого ожидания глушит микрофон уже
 * посреди заданного вопроса.
 *
 * Здесь команды выстроены в цепочку, и перед выполнением каждая
 * сверяется с последним намерением: устаревшие просто не выполняются.
 */
let micWanted = false;
let micQueue: Promise<void> = Promise.resolve();

function setMic(on: boolean): Promise<void> {
  micWanted = on;
  micQueue = micQueue.then(async () => {
    if (micWanted !== on) return;   // намерение уже устарело
    try {
      if (on) await bridge.startMic();
      else await bridge.stopMic();
    } catch (e) {
      console.warn('[mic]', on ? 'не включился' : 'не выключился', e);
    }
  });
  return micQueue;
}

// ─────────────────────────────────────────────────────────────
// Голосовая активация
// ─────────────────────────────────────────────────────────────

let wake: SttSession | null = null;

/**
 * Слушает в фоне и ждёт обращения по имени.
 *
 * Микрофон остаётся включённым всё время ожидания — иначе поймать
 * обращение нечем. Это расходует батарею и оплачивается по времени
 * распознавания, поэтому режим выключен по умолчанию.
 */
async function startWake() {
  if (!cfg.wakeEnabled || wake || fsm.state !== 'IDLE') return;

  wake = new SttSession({
    apiKey: cfg.sttKey,
    hints: [cfg.wakeWord, ...cfg.hints],
    continuous: true,
    onFinal: (t) => { void onWakeHeard(t); },
    onError: (e) => {
      console.warn('[wake] сбой ожидания:', e);
      void stopWake();
    },
  });

  try {
    await wake.open();
    bridge.onPcm((chunk) => wake?.push(chunk));
    await setMic(true);
    await hud.status('SERGEY AI', `Скажите «${cfg.wakeWord}» или тапните`);
  } catch (e) {
    console.warn('[wake] не удалось начать ожидание:', e);
    await stopWake();
  }
}

async function stopWake() {
  if (!wake) return;
  wake.close();
  wake = null;
  // Микрофон гасим только если он не нужен активной сессии вопроса.
  if (!stt) await setMic(false);
}

/** Обращение прозвучало — отделяем вопрос от имени. */
async function onWakeHeard(text: string) {
  // Непрерывное распознавание может прислать несколько фраз подряд.
  // Реагируем только в покое: иначе второе срабатывание перезапустит
  // ожидание уже посреди принимаемого вопроса.
  if (fsm.state !== 'IDLE') return;

  const word = cfg.wakeWord.toLowerCase().trim();
  if (!word) return;

  const lower = text.toLowerCase();
  const at = lower.indexOf(word);
  if (at === -1) return;   // говорили не с нами

  const rest = text.slice(at + word.length).replace(/^[\s,.:!?—-]+/, '').trim();

  await stopWake();

  if (rest.length >= 3) {
    // Вопрос прозвучал сразу за именем — не заставляем повторять.
    if (!fsm.to('LISTENING')) { void startWake(); return; }
    await hud.status('ДУМАЮ', rest);
    void think(rest);
  } else {
    // Позвали и молчат — переходим к обычному приёму вопроса.
    await startListening();
  }
}


async function startListening() {
  // Один микрофон на двоих не делится: перед приёмом вопроса
  // останавливаем фоновое ожидание.
  await stopWake();
  if (!fsm.to('LISTENING')) return;
  await hud.status('СЛУШАЮ', '');

  stt = new SttSession({
    apiKey: cfg.sttKey,
    hints: cfg.hints,
    onPartial: (t) => { hud.stream(t).catch(() => {}); },
    onFinal: (t) => { void think(t); },
    onError: (e) => { console.error(e); failWith(classify(e), e); },
  });

  try {
    await stt.open();
    bridge.onPcm((chunk) => stt?.push(chunk));
    await setMic(true);
  } catch (e) {
    console.error(e);
    // Сюда попадает и сбой открытия сокета распознавания, и отказ
    // микрофона — их надо различать, поэтому классифицируем, а не
    // показываем всегда «нет микрофона».
    failWith(classify(e), e);
  }
}

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function think(question: string) {
  await setMic(false);
  stt = null;

  // Разговор окончен: чистим контекст, чтобы следующая тема начиналась
  // с нуля, и возвращаемся в покой.
  if (isFarewell(question)) {
    router.reset();
    await hud.status(BRAND, 'До связи');
    await delay(1200);
    fsm.force('IDLE');
    return;
  }

  if (!fsm.to('THINKING')) return;
  await hud.status('ДУМАЮ', question);

  abort = new AbortController();
  let streamed = false;

  try {
    const turn = await router.handle(question, {
      onTool: (label) => { hud.status(label + '…', '').catch(() => {}); },
      onDelta: (text) => {
        // Первое предложение появляется до конца генерации —
        // именно это убирает ощущение медленности.
        if (!streamed) { streamed = true; hud.status('', text).catch(() => {}); }
        else hud.stream(text).catch(() => {});
      },
      onConfirm: askConfirm,
      onSearch: (q) => {
        // Поиск добавляет несколько секунд. Без этой подсказки пауза
        // выглядит как зависание, и человек тапает снова, обрывая ход.
        hud.status('ИЩУ…', q.slice(0, 80)).catch(() => {});
        streamed = false;
      },
    }, abort.signal);

    if (!fsm.to('DISPLAYING')) return;
    // Подпись стоит над любым ответом — и над мгновенным от инструмента,
    // и над обычным от модели.
    await hud.result(BRAND, turn.text);

    // Ассистент задал уточняющий вопрос — включаем приём ответа сам.
    // Заставлять тапать после вопроса неестественно: в разговоре на
    // вопрос отвечают сразу, а не нажимают кнопку.
    if (endsWithQuestion(turn.text)) {
      await delay(1600);          // успеть прочитать вопрос
      if (fsm.state === 'DISPLAYING') await startListening();
    }
  } catch (e: any) {
    if (e?.name === 'AbortError') { fsm.force('IDLE'); return; }
    console.error(e);
    failWith(classify(e), e);
  } finally {
    abort = null;
  }
}

function askConfirm(text: string): Promise<boolean> {
  fsm.to('CONFIRMING');
  hud.status(text.split('\n')[0], text.split('\n').slice(1).join('\n') + '\n\nТап — да · Свайп вниз — нет');

  return new Promise((resolve) => {
    pendingConfirm = resolve;
    // Молча висеть нельзя: через 30 с считаем отказом.
    setTimeout(() => resolveConfirm(false), 30_000);
  });
}

function resolveConfirm(ok: boolean) {
  const r = pendingConfirm;
  pendingConfirm = null;
  if (!r) return;
  fsm.to('THINKING');
  r(ok);
}

function cancel() {
  abort?.abort();
  stt?.close();
  void setMic(false);
  fsm.force('IDLE');
}

function classify(e: any) {
  const m = String(e?.message ?? '');
  // Порядок важен: 401 из Deepgram — это «ключ не принят», а не «не слышу»,
  // поэтому проверка авторизации идёт раньше проверки на STT.
  if (/audio|microphone|микрофон|NotAllowedError/i.test(m)) return ERR.mic;
  if (/401|403|api.?key|unauthor/i.test(m)) return ERR.auth;
  if (!navigator.onLine || /fetch|network|Failed to fetch/i.test(m)) return ERR.network;
  if (/STT|Deepgram/i.test(m)) return ERR.stt;
  if (/LLM|429|5\d\d/.test(m)) return ERR.llm;
  return ERR.generic;
}

main().catch((e) => {
  console.error('Фатальная ошибка старта:', e);
  document.body.textContent = 'SERGEY AI: ошибка запуска. Смотрите консоль.';
});
