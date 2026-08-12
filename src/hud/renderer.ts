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
  }

  async next() {
    if (this.index < this.pages.length - 1) { this.index++; await this.render(); }
  }

  async prev() {
    if (this.index > 0) { this.index--; await this.render(); }
  }

  /**
   * Листание по кругу: с последней страницы попадаем на первую, с
   * первой — на последнюю. Так из любого места ответа можно дойти
   * до любого другого, не упираясь в край.
   */
  async cycleNext() {
    if (!this.pages.length) return;
    this.index = (this.index + 1) % this.pages.length;
    await this.render();
  }

  async cyclePrev() {
    if (!this.pages.length) return;
    this.index = (this.index - 1 + this.pages.length) % this.pages.length;
    await this.render();
  }

  get hasPages() { return this.pages.length > 0; }
  get isMultiPage() { return this.pages.length > 1; }
  get atLastPage() { return this.index >= this.pages.length - 1; }

  /**
   * Автопролистывания намеренно нет.
   *
   * Оно было, и оказалось вредным: пока человек читает первую страницу,
   * таймер уводил его в конец ответа, а на последней странице тап уже
   * начинает новый вопрос — вернуться было некуда. Скорость чтения
   * задаёт человек, а не таймер.
   */

  private async render() {
    // Подвал не только нумерует страницы, но и говорит, что делать
    // дальше: без подсказки неочевидно, что ответ продолжается.
    // Подсказка объясняет, что делать дальше. Без неё неочевидно ни
    // что ответ продолжается, ни что разговор можно закрыть голосом.
    const footer = this.isMultiPage
      ? (this.atLastPage
          ? `${this.index + 1}/${this.pages.length} · свайп — листать · тап — спросить`
          : `${this.index + 1}/${this.pages.length} · тап — дальше`)
      : 'тап — спросить · «хватит» — закрыть';
    const page = { title: this.title, body: this.pages[this.index] ?? '', footer };
    return this.enqueue(async () => {
      if (!this.created) { await this.bridge.createPage(page); this.created = true; return; }
      await this.bridge.rebuildPage(page);
    });
  }
}
