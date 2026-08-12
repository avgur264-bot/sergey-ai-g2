/**
 * ЕДИНСТВЕННЫЙ файл в проекте, который напрямую трогает Even Hub SDK.
 *
 * Сверено с @evenrealities/even_hub_sdk@0.0.12 (dist/index.d.ts).
 * При обновлении SDK — перечитать типы и править ТОЛЬКО здесь:
 *   cat node_modules/@evenrealities/even_hub_sdk/dist/index.d.ts
 */

import {
  waitForEvenAppBridge,
  CreateStartUpPageContainer,
  RebuildPageContainer,
  TextContainerProperty,
  TextContainerUpgrade,
  AudioInputSource,
  OsEventTypeList,
  EventSourceType,
  Sys_ItemEvent,
  type AudioEvent,
  type EvenAppBridge,
  type EvenHubEvent,
} from '@evenrealities/even_hub_sdk';

import type { HudPage } from '../hud/renderer.ts';

// ─────────────────────────────────────────────────────────────
// Геометрия HUD. 576×288 на глаз, монохром, 16 градаций.
// Размер шрифта через SDK не меняется — раскладка задаётся
// только координатами и размерами контейнеров.
// ─────────────────────────────────────────────────────────────

const SCREEN_W = 576;
const PAD = 24;

const C_TITLE = 1;
const C_BODY = 2;
const C_FOOTER = 3;

/** Лимиты хоста: 1000 символов на создании страницы, 2000 на апгрейде. */
const MAX_CREATE = 1000;
const MAX_UPGRADE = 2000;

export const BODY_CONTAINER = C_BODY;

// ─────────────────────────────────────────────────────────────

export type GestureSource = 'right' | 'left' | 'ring' | 'unknown';

export type Gesture =
  | { type: 'click'; source: GestureSource }
  | { type: 'double_click'; source: GestureSource }
  | { type: 'scroll_up'; source: GestureSource }
  | { type: 'scroll_down'; source: GestureSource };

export type LifecycleEvent = 'foreground_enter' | 'foreground_exit' | 'force_exit';

export interface Bridge {
  createPage(page: HudPage): Promise<void>;
  rebuildPage(page: HudPage): Promise<void>;
  /** Точечное обновление текста — без вспышки экрана. Для стриминга. */
  updateText(containerId: number, text: string): Promise<void>;

  onGesture(cb: (g: Gesture) => void): void;
  onLifecycle(cb: (e: LifecycleEvent) => void): void;

  startMic(): Promise<void>;
  stopMic(): Promise<void>;
  onPcm(cb: (chunk: Uint8Array) => void): void;

  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;

  requestShutdown(): Promise<void>;
}

// ─────────────────────────────────────────────────────────────

function clamp(s: string, max: number) {
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

function textObjects(page: HudPage): TextContainerProperty[] {
  const hasFooter = Boolean(page.footer);
  return [
    new TextContainerProperty({
      containerID: C_TITLE,
      containerName: 'title',
      xPosition: PAD, yPosition: 20,
      width: SCREEN_W - PAD * 2, height: 34,
      zOrderIndex: 0,
      content: clamp(page.title, 60),
    }),
    new TextContainerProperty({
      containerID: C_BODY,
      containerName: 'body',
      xPosition: PAD, yPosition: 62,
      width: SCREEN_W - PAD * 2, height: hasFooter ? 170 : 200,
      zOrderIndex: 1,
      content: clamp(page.body, MAX_CREATE),
    }),
    new TextContainerProperty({
      containerID: C_FOOTER,
      containerName: 'footer',
      xPosition: PAD, yPosition: 244,
      width: SCREEN_W - PAD * 2, height: 24,
      zOrderIndex: 2,
      content: page.footer ?? '',
    }),
  ];
}

function mapSource(src?: EventSourceType): GestureSource {
  switch (src) {
    case EventSourceType.TOUCH_EVENT_FROM_GLASSES_R: return 'right';
    case EventSourceType.TOUCH_EVENT_FROM_GLASSES_L: return 'left';
    case EventSourceType.TOUCH_EVENT_FROM_RING: return 'ring';
    default: return 'unknown';
  }
}

/**
 * ⚠️ ГЛАВНАЯ ГРАБЛЯ ПРОЕКТА.
 *
 * OsEventTypeList.CLICK_EVENT === 0, а protobuf не сериализует поля
 * с нулевым значением. Одиночный тап приходит конвертом, в котором
 * поля eventType просто НЕТ — обычный switch его не увидит.
 *
 * Поэтому отсутствие eventType трактуем как одиночный клик.
 * Нормализуем через OsEventTypeList.fromJson: хост может прислать
 * и число, и строку "CLICK_EVENT", и сокращение "CLICK".
 */
function decodeSys(sys: Sys_ItemEvent): Gesture | LifecycleEvent | null {
  const src = mapSource(sys.eventSource);
  const raw = sys.eventType;
  const t = raw === undefined || raw === null
    ? OsEventTypeList.CLICK_EVENT
    : (OsEventTypeList.fromJson(raw) ?? OsEventTypeList.CLICK_EVENT);

  switch (t) {
    case OsEventTypeList.CLICK_EVENT:            return { type: 'click', source: src };
    case OsEventTypeList.SCROLL_TOP_EVENT:       return { type: 'scroll_up', source: src };
    case OsEventTypeList.SCROLL_BOTTOM_EVENT:    return { type: 'scroll_down', source: src };
    case OsEventTypeList.DOUBLE_CLICK_EVENT:     return { type: 'double_click', source: src };
    case OsEventTypeList.FOREGROUND_ENTER_EVENT: return 'foreground_enter';
    case OsEventTypeList.FOREGROUND_EXIT_EVENT:  return 'foreground_exit';
    case OsEventTypeList.ABNORMAL_EXIT_EVENT:
    case OsEventTypeList.SYSTEM_EXIT_EVENT:      return 'force_exit';
    default: return null;  // IMU и прочее нам не нужно
  }
}

const isGesture = (v: Gesture | LifecycleEvent): v is Gesture => typeof v === 'object';

// ─────────────────────────────────────────────────────────────

class SdkBridge implements Bridge {
  private gestureCb?: (g: Gesture) => void;
  private lifecycleCb?: (e: LifecycleEvent) => void;
  private pcmCb?: (c: Uint8Array) => void;

  private sdk: EvenAppBridge;

  constructor(sdk: EvenAppBridge) {
    this.sdk = sdk;
    this.sdk.onEvenHubEvent((ev: EvenHubEvent) => this.dispatch(ev));
  }

  private dispatch(ev: any) {
    const audio: AudioEvent | undefined = ev?.audioEvent ?? ev?.payload?.audioEvent;
    if (audio?.audioPcm) {
      this.pcmCb?.(audio.audioPcm);
      return;
    }

    const sysRaw = ev?.sysEvent ?? ev?.payload?.sysEvent;
    if (!sysRaw) return;

    const sys = sysRaw instanceof Sys_ItemEvent ? sysRaw : Sys_ItemEvent.fromJson(sysRaw);
    const decoded = decodeSys(sys);
    if (!decoded) return;

    if (isGesture(decoded)) this.gestureCb?.(decoded);
    else this.lifecycleCb?.(decoded);
  }

  // ── дисплей ──
  async createPage(page: HudPage) {
    const objects = textObjects(page);
    await this.sdk.createStartUpPageContainer(new CreateStartUpPageContainer({
      containerTotalNum: objects.length,
      textObject: objects,
    }));
  }

  async rebuildPage(page: HudPage) {
    const objects = textObjects(page);
    await this.sdk.rebuildPageContainer(new RebuildPageContainer({
      containerTotalNum: objects.length,
      textObject: objects,
    }));
  }

  async updateText(containerId: number, text: string) {
    const content = clamp(text, MAX_UPGRADE);
    await this.sdk.textContainerUpgrade(new TextContainerUpgrade({
      containerID: containerId,
      contentOffset: 0,
      contentLength: content.length,
      content,
    }));
  }

  // ── ввод ──
  onGesture(cb: (g: Gesture) => void) { this.gestureCb = cb; }
  onLifecycle(cb: (e: LifecycleEvent) => void) { this.lifecycleCb = cb; }

  // ── аудио ──
  async startMic() { await this.sdk.audioControl(true, AudioInputSource.Glasses); }
  async stopMic()  { await this.sdk.audioControl(false); }
  onPcm(cb: (c: Uint8Array) => void) { this.pcmCb = cb; }

  // ── KVS (строковый) ──
  async get(key: string) {
    const v = await this.sdk.getLocalStorage(key);
    return v || null;
  }
  async set(key: string, value: string) {
    await this.sdk.setLocalStorage(key, value);
  }

  // ── выход ──
  async requestShutdown() {
    // Режим 1 = системный диалог подтверждения.
    // Режим 0 и собственный UI выхода на корневой странице не проходят ревью.
    await this.sdk.shutDownPageContainer(1);
  }
}

// ─────────────────────────────────────────────────────────────
// Мок для отладки в браузере без очков
// ─────────────────────────────────────────────────────────────

class MockBridge implements Bridge {
  private root = document.getElementById('hud-preview');

  async createPage(p: HudPage) { this.render(p); }
  async rebuildPage(p: HudPage) { this.render(p); }
  async updateText(id: number, text: string) {
    const node = document.getElementById(`hud-c${id}`);
    if (node) node.textContent = text;
  }

  private render(p: HudPage) {
    if (!this.root) return;
    this.root.innerHTML = '';
    const mk = (id: number, cls: string, text: string) => {
      const d = document.createElement('div');
      d.id = `hud-c${id}`; d.className = cls; d.textContent = text;
      return d;
    };
    this.root.append(
      mk(C_TITLE, 'hud-title', p.title),
      mk(C_BODY, 'hud-body', p.body),
      mk(C_FOOTER, 'hud-footer', p.footer ?? ''),
    );
  }

  onGesture(cb: (g: Gesture) => void) {
    window.addEventListener('keydown', (e) => {
      const source: GestureSource = 'right';
      if (e.key === 'Enter') cb({ type: 'click', source });
      else if (e.key.toLowerCase() === 'd') cb({ type: 'double_click', source });
      else if (e.key === 'ArrowUp') cb({ type: 'scroll_up', source });
      else if (e.key === 'ArrowDown') cb({ type: 'scroll_down', source });
    });
  }

  onLifecycle(cb: (e: LifecycleEvent) => void) {
    document.addEventListener('visibilitychange', () => {
      cb(document.hidden ? 'foreground_exit' : 'foreground_enter');
    });
  }

  async startMic() { console.log('[mock] микрофон включён'); }
  async stopMic()  { console.log('[mock] микрофон выключен'); }
  onPcm() { /* звук в моке идёт через even-dev симулятор */ }

  async get(k: string) { return localStorage.getItem(k); }
  async set(k: string, v: string) { localStorage.setItem(k, v); }
  async requestShutdown() { console.log('[mock] запрошен выход'); }
}

// ─────────────────────────────────────────────────────────────

let instance: Bridge | null = null;
export let lastBackend: 'native' | 'mock' | null = null;

export async function getBridge(): Promise<Bridge> {
  if (instance) return instance;

  // ⚠️ КЛЮЧЕВОЙ МОМЕНТ, подтверждён эмпирически (перехватом обращений к window):
  // EvenAppBridge из SDK сам инициализируется при импорте модуля и сразу
  // помечает себя готовым (_ready = true) — ДАЖЕ в обычном браузере без
  // реальных очков. waitForEvenAppBridge() поэтому всегда резолвится,
  // и полагаться на неё для выбора мока нельзя — она не отличает
  // Even App от простого Safari.
  //
  // Настоящий сигнал — нативный канал, который Even App (написан на
  // Flutter) внедряет в WebView: window.flutter_inappwebview.callHandler.
  // Без него SDK не бросает исключение, а молча логирует
  // "Flutter handler not available" и ничего не делает — поэтому раньше
  // код выбирал боевой SdkBridge и просто ничего не рисовал на экране.
  const hasNativeHost =
    typeof (window as any).flutter_inappwebview?.callHandler === 'function';

  if (!hasNativeHost) {
    console.warn('[bridge] flutter_inappwebview не найден — работаю в моке для браузера');
    lastBackend = 'mock';
    instance = new MockBridge();
    return instance;
  }

  try {
    const sdk = await waitForEvenAppBridge();
    lastBackend = 'native';
    instance = new SdkBridge(sdk);
  } catch (e) {
    console.warn('[bridge] нативный хост есть, но SDK не инициализировался:', e);
    lastBackend = 'mock';
    instance = new MockBridge();
  }
  return instance;
}
