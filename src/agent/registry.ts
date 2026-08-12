import type { Bridge } from '../sdk/bridge.ts';

export interface ToolContext {
  bridge: Bridge;
  /** Ключи и настройки из KVS. */
  cfg: Record<string, string>;
  signal: AbortSignal;
}

export interface ToolResult {
  /** Что уйдёт обратно в модель. */
  data: string;
  /** Если задано — показываем сразу, минуя второй вызов LLM. */
  direct?: string;
}

export interface ToolSpec {
  name: string;
  description: string;
  schema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };

  /**
   * write-инструменты меняют мир и требуют подтверждения на HUD:
   * STT ошибается на именах, и «отправь Ане» легко превращается
   * в «отправь Ване».
   */
  kind: 'read' | 'write';

  /**
   * direct — можно звать прямо из WebView (есть CORS, статичный токен).
   * proxy  — только через ваш воркер (OAuth, нет CORS-заголовков).
   */
  transport: 'direct' | 'proxy' | 'local';

  /** Короткая строка на HUD, пока инструмент работает: «КАЛЕНДАРЬ…» */
  label: string;

  /** Текст подтверждения для write-инструментов. */
  confirm?(args: any): string;

  run(args: any, ctx: ToolContext): Promise<ToolResult>;
}

export class Registry {
  private tools = new Map<string, ToolSpec>();

  add(...specs: ToolSpec[]) {
    for (const s of specs) this.tools.set(s.name, s);
    return this;
  }

  get(name: string) { return this.tools.get(name); }
  all(): ToolSpec[] { return [...this.tools.values()]; }

  /** То, что уходит в LLM. Держите список коротким — это входные токены. */
  specs(): ToolSpec[] { return this.all(); }
}
