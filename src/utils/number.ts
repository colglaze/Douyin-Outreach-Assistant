/**
 * 数字工具：解析抖音的中文计数（如 "18.6万" / "1.2W" / "3,456"），以及反向格式化展示。
 */

/** 将中文/缩写计数字符串解析为整数；无法解析时返回 0 */
export function parseChineseCount(text: string | null | undefined): number {
  if (!text) return 0;
  const cleaned = text.replace(/[,，\s]/g, '');
  const m = cleaned.match(/([\d.]+)\s*([万wW千kK]?)/);
  if (!m) return 0;
  const base = parseFloat(m[1]);
  if (Number.isNaN(base)) return 0;
  const unit = m[2];
  if (unit === '万' || unit === 'w' || unit === 'W') return Math.round(base * 10000);
  if (unit === '千' || unit === 'k' || unit === 'K') return Math.round(base * 1000);
  return Math.round(base);
}

/** 格式化为抖音风格展示：186000 -> "18.6W" */
export function formatCount(n: number): string {
  if (n >= 10000) {
    const w = n / 10000;
    return `${w >= 100 ? Math.round(w) : w.toFixed(1)}W`;
  }
  return String(n);
}
