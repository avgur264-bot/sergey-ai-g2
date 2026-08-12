export type State =
  | 'IDLE'
  | 'LISTENING'
  | 'THINKING'
  | 'CONFIRMING'
  | 'DISPLAYING'
  | 'ERROR';

const ALLOWED: Record<State, State[]> = {
  IDLE:       ['LISTENING', 'ERROR'],
  LISTENING:  ['THINKING', 'IDLE', 'ERROR'],
  THINKING:   ['DISPLAYING', 'CONFIRMING', 'IDLE', 'ERROR'],
  CONFIRMING: ['THINKING', 'IDLE', 'ERROR'],
  DISPLAYING: ['IDLE', 'LISTENING', 'ERROR'],
  ERROR:      ['IDLE'],
};

/**
 * Ни одно состояние не живёт вечно. Зависший THINKING — главный враг.
 * CONFIRMING сюда намеренно не входит: у него свой таймаут в askConfirm()
 * (main.ts), который корректно трактует молчание как отказ и возвращает
 * управление в THINKING. Второй, «жёсткий» таймаут здесь создавал бы
 * гонку: если он срабатывал первым, обещание подтверждения зависало
 * навсегда, а последующий рендер ответа тихо проваливался.
 */
const TIMEOUT_MS: Partial<Record<State, number>> = {
  LISTENING:  20_000,
  THINKING:   25_000,
};

export class Machine {
  private current: State = 'IDLE';
  private timer?: ReturnType<typeof setTimeout>;
  private listeners: ((s: State, prev: State) => void)[] = [];

  get state() { return this.current; }

  onChange(cb: (s: State, prev: State) => void) { this.listeners.push(cb); }

  /** Возвращает false, если переход недопустим — вместо тихой поломки. */
  to(next: State): boolean {
    if (next === this.current) return true;
    if (!ALLOWED[this.current].includes(next)) {
      console.warn(`[fsm] запрещённый переход ${this.current} → ${next}`);
      return false;
    }

    const prev = this.current;
    this.current = next;
    clearTimeout(this.timer);

    const t = TIMEOUT_MS[next];
    if (t) {
      this.timer = setTimeout(() => {
        console.warn(`[fsm] таймаут в ${next}`);
        this.force('ERROR');
      }, t);
    }

    this.listeners.forEach((cb) => cb(next, prev));
    return true;
  }

  /** Аварийный переход в обход графа — только для ошибок и таймаутов. */
  force(next: State) {
    const prev = this.current;
    this.current = next;
    clearTimeout(this.timer);
    this.listeners.forEach((cb) => cb(next, prev));
  }

  dispose() { clearTimeout(this.timer); }
}
