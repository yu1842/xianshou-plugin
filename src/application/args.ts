import { DomainError } from '../domain/model.js';

/**
 * 工具入参校验
 *
 * 模型给的参数经常"差一点点"（数字写成字符串、必填漏传）。
 * 这里的错误信息是写给模型看的 —— 必须说清哪个字段错了、应该传什么，
 * 否则它会在同一处连续失败三次。所以所有消息都带字段名与期望类型。
 */

export type Args = Record<string, unknown>;

export function asArgs(raw: unknown): Args {
  if (typeof raw === 'object' && raw !== null && !Array.isArray(raw)) return raw as Args;
  throw new DomainError('INVALID_ARGUMENT', '工具参数必须是对象。');
}

export function str(args: Args, key: string, opts: { max?: number; min?: number } = {}): string {
  const value = args[key];
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new DomainError('INVALID_ARGUMENT', `缺少必填参数 ${key}（非空字符串）。`);
  }
  const trimmed = value.trim();
  if (opts.min !== undefined && trimmed.length < opts.min) {
    throw new DomainError('INVALID_ARGUMENT', `参数 ${key} 至少 ${opts.min} 个字符。`);
  }
  if (opts.max !== undefined && trimmed.length > opts.max) {
    throw new DomainError('INVALID_ARGUMENT', `参数 ${key} 最多 ${opts.max} 个字符。`);
  }
  return trimmed;
}

export function optStr(args: Args, key: string): string | undefined {
  const value = args[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw new DomainError('INVALID_ARGUMENT', `参数 ${key} 必须是字符串。`);
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

export function optNum(args: Args, key: string): number | undefined {
  const value = args[key];
  if (value === undefined || value === null) return undefined;
  const num = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  if (!Number.isFinite(num)) throw new DomainError('INVALID_ARGUMENT', `参数 ${key} 必须是数字。`);
  return num;
}

export function optBool(args: Args, key: string): boolean | undefined {
  const value = args[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'boolean') return value;
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new DomainError('INVALID_ARGUMENT', `参数 ${key} 必须是布尔值。`);
}

export function optStrArray(args: Args, key: string): string[] | undefined {
  const value = args[key];
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) throw new DomainError('INVALID_ARGUMENT', `参数 ${key} 必须是字符串数组。`);
  return value.map((v, i) => {
    if (typeof v !== 'string') throw new DomainError('INVALID_ARGUMENT', `参数 ${key}[${i}] 必须是字符串。`);
    return v;
  });
}

export function optNumArray(args: Args, key: string): number[] | undefined {
  const value = args[key];
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) throw new DomainError('INVALID_ARGUMENT', `参数 ${key} 必须是数字数组。`);
  return value.map((v, i) => {
    const num = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
    if (!Number.isFinite(num)) throw new DomainError('INVALID_ARGUMENT', `参数 ${key}[${i}] 必须是数字。`);
    return num;
  });
}

export function oneOf<T extends string>(args: Args, key: string, allowed: readonly T[]): T {
  const value = str(args, key);
  if (!(allowed as readonly string[]).includes(value)) {
    throw new DomainError('INVALID_ARGUMENT', `参数 ${key} 只能是 ${allowed.join(' / ')}，收到 ${value}。`);
  }
  return value as T;
}

/** JSON Schema 片段生成器：让 8 个工具的 parameters 描述保持同一种写法。 */
export function schemaObject(properties: Record<string, unknown>, required: readonly string[]): Record<string, unknown> {
  return {
    type: 'object',
    properties,
    required: [...required],
    additionalProperties: false,
  };
}

export function stringProp(description: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { type: 'string', description, ...extra };
}

export function numberProp(description: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { type: 'number', description, ...extra };
}

export function booleanProp(description: string): Record<string, unknown> {
  return { type: 'boolean', description };
}

export function enumProp(description: string, values: readonly string[]): Record<string, unknown> {
  return { type: 'string', description, enum: [...values] };
}

export function arrayProp(description: string, items: Record<string, unknown>): Record<string, unknown> {
  return { type: 'array', description, items };
}
