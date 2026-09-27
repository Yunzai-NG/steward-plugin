/**
 * 模块职责：把更新结果讲成一句人话
 * 依赖方向：只依赖类型
 * 生命周期：纯函数
 * 注意事项：`stashed` 与 `discarded` 分开讲，不合成一句 —— 对刚丢弃改动的人说「可 git stash
 *          pop 取回」，他照做得到「没有 stash 可弹出」，会以为改动还在。「已是最新」单独成句，
 *          不写成「0.1.0 → 0.1.0」那种像更新过一次的样子。
 */
import type { PluginUpdateOutcome } from "@yunzai-ng/types"

/**
 * 一个插件的更新结果讲成一行
 * @param outcome 内核给出的更新结果
 * @returns 一行说明，不含前后缀
 */
export function describeOutcome(outcome: PluginUpdateOutcome): string {
  const parts: string[] = []

  if (outcome.changed === false) {
    parts.push(`${outcome.name} 已是最新（${outcome.version}）`)
  } else if (outcome.fromVersion !== undefined && outcome.fromVersion !== outcome.version) {
    parts.push(`${outcome.name} ${outcome.fromVersion} → ${outcome.version}`)
  } else if (outcome.fromVersion !== undefined) {
    // 有新提交但版本号没变：改了代码没抬 package.json，只报版本号会让人以为什么都没发生
    parts.push(`${outcome.name} 已更新（有新提交，版本号仍为 ${outcome.version}）`)
  } else {
    parts.push(`${outcome.name} 已更新到 ${outcome.version}`)
  }

  if (outcome.stashed === true) parts.push("本地改动已暂存，可在该插件目录执行 git stash pop 取回")
  if (outcome.discarded === true) parts.push("本地改动已按设置丢弃，取不回来")

  return parts.join("；")
}

/** 批量更新里单个插件的结局 */
export interface BatchItem {
  /** 插件名（安装目录名） */
  readonly name: string
  /** 成功时的结果 */
  readonly outcome?: PluginUpdateOutcome
  /** 失败时的原因 */
  readonly error?: string
  /** 不在插件索引里、本就更新不了而被跳过（只在「更新全部」时出现） */
  readonly skipped?: boolean
}

/**
 * 批量更新的汇总
 *
 * 三类分开数（更新了 / 已最新 / 失败）：只报「成功 N 个」会把「一个都没动」说成有效更新，
 * 而这几种情形使用者的下一步不同。
 * @param items 逐个插件的结局，顺序即执行顺序
 * @returns 多行文本
 */
export function describeBatch(items: readonly BatchItem[]): string {
  if (items.length === 0) return "没有可更新的插件"

  const updated: string[] = []
  const latest: string[] = []
  const failed: string[] = []
  const skipped: string[] = []

  for (const item of items) {
    if (item.error !== undefined) {
      failed.push(`${item.name}：${item.error}`)
      continue
    }
    if (item.skipped === true) {
      skipped.push(item.name)
      continue
    }
    if (item.outcome === undefined) continue
    if (item.outcome.changed === false) latest.push(item.outcome.name)
    else updated.push(describeOutcome(item.outcome))
  }

  const lines: string[] = []
  lines.push(`共 ${items.length} 个插件：更新 ${updated.length}、已最新 ${latest.length}、失败 ${failed.length}`)
  for (const one of updated) lines.push(`· ${one}`)
  // 已最新的只报名字挤一行，逐条列会把真正有变化的淹掉
  if (latest.length > 0) lines.push(`已是最新：${latest.join("、")}`)
  // 手装、不在索引里的本就更新不了，单列一行而不算失败
  if (skipped.length > 0) lines.push(`不在索引里，已跳过：${skipped.join("、")}`)
  for (const one of failed) lines.push(`× ${one}`)
  return lines.join("\n")
}

/**
 * 取一段文本里的错误信息
 * @param err 抓到的东西
 * @returns 一句可读的原因
 */
export function reasonOf(err: unknown): string {
  if (err instanceof Error && err.message !== "") return err.message
  const text = String(err)
  return text === "" ? "未知原因" : text
}
