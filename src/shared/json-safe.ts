/**
 * 无损 JSON 清理（DSH 工具返回值的硬性要求）。
 *
 * DSH 会校验工具返回值是**无损 JSON**：对象里只要出现 `undefined` 键，整个调用
 * 就失败并报 `value is not lossless JSON`。而我们大量字段天然是"成功路径上缺席"
 * 的（`required_action`、`request_id`、失败项的 `submit_id` …），直接放进返回对象
 * 必然踩雷 —— `dreamina_account` 与 `dreamina_canvas` 都真实踩过一次。
 *
 * 因此**任何面向 DSH 的工具返回值都应经过 `jsonSafe`**。
 *
 * @module dsh-media-plugins/shared/json-safe
 */

/** 递归剔除 `undefined` 键（数组保序，其余类型原样返回）。 */
export function jsonSafe<T>(value: T): T {
  if (Array.isArray(value)) return value.map((entry) => jsonSafe(entry)) as unknown as T
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      if (entry === undefined) continue
      out[key] = jsonSafe(entry)
    }
    return out as T
  }
  return value
}
