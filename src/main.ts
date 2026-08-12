import { getBridge, type Bridge, type Gesture } from './sdk/bridge.ts';
import { Hud } from './hud/renderer.ts';
import { Machine } from './state/machine.ts';
import { SttSession } from './audio/stt.ts';
import { AnthropicLlm, OpenAiLlm, type Llm } from './agent/llm.ts';
import { Registry } from './agent/registry.ts';
import { defaultTools } from './agent/tools/index.ts';
import { Router } from './agent/router.ts';
import { ERR } from './hud/strings.ts';
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

  const llm: Llm = cfg.provider === 'openai'
    ? new OpenAiLlm(cfg.llmKey, cfg.model, cfg.baseUrl)
    : new AnthropicLlm(cfg.llmKey, cfg.model, cfg.baseUrl);

  const registry = new Registry().add(...defaultTools);
  router = new Router(llm, registry, bridge, cfg as any);

  bridge.onGesture(onGesture);
  bridge.onLifecycle(onLifecycle);
  fsm.onChange(onStateChange);

  window.addEventListener('sergey:timer', (e: any) => {
    hud.status('ТАЙМЕР', e.detail?.name ?? 'Время вышло');
  });

  await hud.boot({ title: 'SERGEY AI', body: 'Тап — говорить', footer: '' });
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

  switch (g.type) {
    case 'click':
      if (fsm.state === 'IDLE' || fsm.state === 'DISPLAYING') await startListening();
      else if (fsm.state === 'LISTENING') stt?.close();      // ручное завершение
      else if (fsm.state === 'THINKING') cancel();            // прервать
      break;

    case 'scroll_up':
      if (fsm.state === 'DISPLAYING') await hud.prev();
      break;

    case 'scroll_down':
      if (fsm.state === 'DISPLAYING') await hud.next();
      break;
  }
}

function onLifecycle(e: string) {
  // Забытый включённый микрофон = разряженные очки за пару часов.
  if (e === 'foreground_exit' || e === 'force_exit') {
    stt?.close();
    bridge.stopMic().catch(() => {});
    cancel();
  }
}

async function onStateChange(s: string) {
  if (s === 'ERROR') {
    await hud.status(ERR.generic.title, ERR.generic.body);
    stt?.close();
    await bridge.stopMic().catch(() => {});
    setTimeout(() => fsm.force('IDLE'), 2500);
  }
  if (s === 'IDLE') {
    await hud.status('SERGEY AI', 'Тап — говорить');
  }
}

// ─────────────────────────────────────────────────────────────
// Основной цикл
// ─────────────────────────────────────────────────────────────

async function startListening() {
  if (!fsm.to('LISTENING')) return;
  await hud.status('СЛУШАЮ', '');

  stt = new SttSession({
    apiKey: cfg.sttKey,
    hints: cfg.hints,
    onPartial: (t) => { hud.stream(t).catch(() => {}); },
    onFinal: (t) => { void think(t); },
    onError: (e) => { console.error(e); fsm.force('ERROR'); },
  });

  try {
    await stt.open();
    bridge.onPcm((chunk) => stt?.push(chunk));
    await bridge.startMic();
  } catch (e) {
    console.error(e);
    await hud.status(ERR.mic.title, ERR.mic.body);
    fsm.force('ERROR');
  }
}

async function think(question: string) {
  await bridge.stopMic().catch(() => {});
  stt = null;

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
    }, abort.signal);

    if (!fsm.to('DISPLAYING')) return;
    await hud.result(turn.instant ? '' : 'ОТВЕТ', turn.text);
  } catch (e: any) {
    if (e?.name === 'AbortError') { fsm.force('IDLE'); return; }
    console.error(e);
    const kind = classify(e);
    await hud.status(kind.title, kind.body);
    fsm.force('ERROR');
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
  bridge.stopMic().catch(() => {});
  fsm.force('IDLE');
}

function classify(e: any) {
  const m = String(e?.message ?? '');
  if (!navigator.onLine || /fetch|network|Failed to fetch/i.test(m)) return ERR.network;
  if (/401|403|api.?key/i.test(m)) return ERR.auth;
  if (/STT|Soniox/i.test(m)) return ERR.stt;
  if (/LLM|429|5\d\d/.test(m)) return ERR.llm;
  return ERR.generic;
}

main().catch((e) => {
  console.error('Фатальная ошибка старта:', e);
  document.body.textContent = 'SERGEY AI: ошибка запуска. Смотрите консоль.';
});
