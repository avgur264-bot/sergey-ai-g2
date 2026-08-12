import type { Bridge } from '../sdk/bridge.ts';
import { BODY_CONTAINER } from '../sdk/bridge.ts';

export interface HudPage {
  title: string;
  body: string;
  footer?: string;
}

/**
 * Сколько символов реально влезает на экран 576×288 — подбирается
 * эмпирически: API смены размера шрифта в SDK нет, поэтому единственный
 * способ узнать — посмотреть на очках.
 *
 * Значение намеренно занижено. Ошибка в большую сторону обрезает текст
 * молча, и человек видит оборванный ответ, не понимая, что часть
 * потерялась. Ошибка в меньшую сторону всего лишь добавляет страницу,
 * которая перелистнётся сама.
 */
const CHARS_PER_PAGE = 180;

/** Режет текст на страницы по границам предложений, не рвя слова. */
export function paginate(text: string, limit = CHARS_PER_PAGE): string[] {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (clean.length <= limit) return [clean];

  const sentences = clean.match(/[^.!?…]+[.!?…]*\s*/g) ?? [clean];
  const pages: string[] = [];
  let buf = '';

  for (const s of sentences) {
    if ((buf + s).length > limit && buf) {
      pages.push(buf.trim());
      buf = '';
    }
    // Предложение само длиннее страницы — режем по словам
    if (s.length > limit) {
      for (const word of s.split(' ')) {
        if ((buf + ' ' + word).length > limit) { pages.push(buf.trim()); buf = ''; }
        buf += (buf ? ' ' : '') + word;
      }
    } else {
      buf += s;
    }
  }
  if (buf.trim()) pages.push(buf.trim());
  return pages;
}

/**
 * Держит текущий многостраничный ответ и навигацию по нему.
 * Стриминг идёт через updateText — экран не мигает.
 */
export class Hud {
  private pages: string[] = [];
  private index = 0;
  private title = '';
  private created = false;

  private bridge: Bridge;

  // Все операции с экраном идут строго по очереди. Колбэк onDelta в
  // main.ts не дожидается каждого вызова перед следующим (иначе стриминг
  // токенов подвисал бы на каждой сетевой round-trip к очкам), поэтому
  // без такой очереди быстрые токены могли бы прийти на нативную сторону
  // не в том порядке, в котором сгенерированы.
  private queue: Promise<void> = Promise.resolve();
  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.then(() => {}, () => {});
    return run;
  }

  constructor(bridge: Bridge) { this.bridge = bridge; }

  /** Первый экран приложения. Вызывается один раз при старте. */
  async boot(page: HudPage) {
    this.created = true;
    return this.enqueue(() => this.bridge.createPage(page));
  }

  /** Полная замена экрана. Даёт вспышку — не использовать для стриминга. */
  async show(page: HudPage) {
    // Любой новый экран отменяет автопрокрутку прошлого ответа: иначе
    // отложенный таймер перерисует «СЛУШАЮ» страницей старого текста.
    this.stopAuto();
    this.pages = [];
    this.title = page.title;
    const wasCreated = this.created;
    this.created = true;
    return this.enqueue(async () => {
      if (!wasCreated) await this.bridge.createPage(page);
      else await this.bridge.rebuildPage(page);
    });
  }

  /** Короткий статус: СЛУШАЮ / ДУМАЮ / КАЛЕНДАРЬ… */
  async status(title: string, body = '') {
    await this.show({ title, body });
  }

  /** Стриминг ответа. Обновляет только тело, без мигания. */
  async stream(chunk: string) {
    return this.enqueue(() => this.bridge.updateText(BODY_CONTAINER, chunk));
  }

  /** Финальный многостраничный ответ. */
  async result(title: string, text: string) {
    this.title = title;
    this.pages = paginate(text);
    this.index = 0;
    await this.render();
    this.scheduleAuto();
  }

  async next() {
    if (this.index < this.pages.length - 1) { this.index++; await this.render(); }
  }

  async prev() {
    if (this.index > 0) { this.index--; await this.render(); }
  }

  /** Листание руками: отменяет автопрокрутку, дальше человек сам. */
  async nextManual() { this.stopAuto(); await this.next(); }
  async prevManual() { this.stopAuto(); await this.prev(); }

  get hasPages() { return this.pages.length > 0; }
  get isMultiPage() { return this.pages.length > 1; }
  get atLastPage() { return this.index >= this.pages.length - 1; }

  /**
   * Автопролистывание длинного ответа.
   *
   * Полагаться только на свайп нельзя: если жест не долетит, человек
   * увидит первую страницу и решит, что ответ обрезан. Штатный Even AI
   * прокручивает текст сам — здесь тот же принцип. Ручные жесты
   * продолжают работать и просто отменяют автопрокрутку.
   */
  private autoTimer?: ReturnType<typeof setTimeout>;

  private scheduleAuto() {
    this.stopAuto();
    if (this.atLastPage) return;

    // Время на страницу — по длине текста, но в разумных пределах:
    // читать HUD быстрее, чем книгу, и медленнее, чем заголовок.
    const chars = this.pages[this.index]?.length ?? 0;
    const ms = Math.min(9000, Math.max(3500, chars * 55));

    this.autoTimer = setTimeout(() => {
      void this.next().then(() => this.scheduleAuto());
    }, ms);
  }

  stopAuto() {
    if (this.autoTimer) { clearTimeout(this.autoTimer); this.autoTimer = undefined; }
  }

  private async render() {
    // Подвал не только нумерует страницы, но и говорит, что делать
    // дальше: без подсказки неочевидно, что ответ продолжается.
    const footer = this.isMultiPage
      ? (this.atLastPage
          ? `${this.index + 1}/${this.pages.length} · тап — новый вопрос`
          : `${this.index + 1}/${this.pages.length} · тап — дальше`)
      : '';
    const page = { title: this.title, body: this.pages[this.index] ?? '', footer };
    return this.enqueue(async () => {
      if (!this.created) { await this.bridge.createPage(page); this.created = true; return; }
      await this.bridge.rebuildPage(page);
    });
  }
}
