import type { Bridge } from '../sdk/bridge.ts';

export interface HudPage {
  title: string;
  body: string;
  footer?: string;
}

/**
 * Сколько символов реально влезает на экран 576×288 — подбирается
 * эмпирически: API смены размера шрифта в SDK нет, поэтому единственный
 * способ узнать — посмотреть на очках. Начните с этого значения и правьте.
 */
const CHARS_PER_PAGE = 260;

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

  constructor(bridge: Bridge) { this.bridge = bridge; }

  /** Первый экран приложения. Вызывается один раз при старте. */
  async boot(page: HudPage) {
    await this.bridge.createPage(page);
    this.created = true;
  }

  /** Полная замена экрана. Даёт вспышку — не использовать для стриминга. */
  async show(page: HudPage) {
    this.pages = [];
    this.title = page.title;
    if (!this.created) return this.boot(page);
    await this.bridge.rebuildPage(page);
  }

  /** Короткий статус: СЛУШАЮ / ДУМАЮ / КАЛЕНДАРЬ… */
  async status(title: string, body = '') {
    await this.show({ title, body });
  }

  /** Стриминг ответа. Обновляет только тело, без мигания. */
  async stream(chunk: string) {
    await this.bridge.updateText(1, chunk);
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

  get hasPages() { return this.pages.length > 0; }
  get isMultiPage() { return this.pages.length > 1; }

  private async render() {
    const footer = this.isMultiPage ? `${this.index + 1}/${this.pages.length}` : '';
    const page = { title: this.title, body: this.pages[this.index] ?? '', footer };
    if (!this.created) { await this.bridge.createPage(page); this.created = true; return; }
    await this.bridge.rebuildPage(page);
  }
}
