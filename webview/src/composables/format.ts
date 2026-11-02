/** 表单取值与展示格式化的小工具。 */
import type { Severity } from '../../../src/shared/types';

/** 数字输入框清空后 v-model.number 会给出空字符串，提交前统一走这里。 */
export function toNumber(value: unknown, fallback = 0): number {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : fallback;
  }
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

export function formatTime(ms: number | undefined): string {
  if (!ms) return '—';
  const date = new Date(ms);
  if (Number.isNaN(date.getTime())) return '—';
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export const severityLabel: Record<Severity, string> = {
  error: '错误',
  warning: '警告',
  info: '提示',
};
