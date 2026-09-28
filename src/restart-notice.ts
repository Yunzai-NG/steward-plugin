/**
 * 模块职责：重启回执 —— 重启前记下「发回哪个会话」，重启后由那个账号上线时补发一句
 * 依赖方向：依赖 `@yunzai-ng/types` 的 SendTarget；不认识 ctx，读写 KV 由调用方传入
 * 生命周期：纯逻辑，一条回执跨一次进程重启存活于 KV
 * 注意事项：**信息必须持久化。** 进程重启后内存全清，「谁在哪触发的、是普通重启还是更新后
 *          重启、原来什么版本」只能落在 KV 里，故这里只处理可 JSON 序列化的朴素数据。
 *
 *          **只补发新近的回执。** 记下 `at`（毫秒时刻），重启后超过 `FRESH_MS` 的一律丢弃：
 *          进程隔几天才被守护拉起时补一句「重启完成」是噪声，且那次重启多半与本命令无关
 *          （崩溃、断电）。丢弃的判断在 `isFresh`，可单测。
 *
 *          **发完即删，且只认领一次。** 回执由「那个账号上线」触发，而一个账号可能上线多次
 *          （断线重连）。不删的话每次重连都补发一遍，表现为「重启一次、之后每次断网重连都
 *          再说一遍我回来了」。删除的时机在调用方（发送成功后），这里只提供判据。
 */
import type { SendTarget } from "@yunzai-ng/types"

/** KV 里存回执用的键 */
export const NOTICE_KEY = "restart-notice"

/** 一次重启的缘由 */
export type RestartKind = "restart" | "kernel-update"

/** 落在 KV 里的重启回执 */
export interface RestartNotice {
  /** 触发重启的账号 id —— 重启后要等这个账号回来才发得出去 */
  readonly selfId: string
  /** 发回哪个会话 */
  readonly target: SendTarget
  /** 缘由，决定补发的措辞 */
  readonly kind: RestartKind
  /** 记录时刻（毫秒），用于「只补发新近的」 */
  readonly at: number
  /** 内核更新时的版本变化，如 `0.6.1 → 0.6.2`；普通重启时不填 */
  readonly versionChange?: string
}

/** 回执的新鲜期：超过这段时间的重启不再补发 */
export const FRESH_MS = 10 * 60 * 1000

/**
 * 判定一条回执是否仍值得补发
 *
 * 抽出来单测：`now - at` 落在窗口内才补。窗口一开始拉得太大就成了「隔天被拉起也报一句」的噪声，
 * 太小又会让一次正常重启（十几秒到一两分钟）赶不上补发。
 * @param notice 回执
 * @param now 当前时刻（毫秒）
 * @returns 是否补发
 */
export function isFresh(notice: RestartNotice, now: number): boolean {
  const age = now - notice.at
  // age 为负（时钟回拨）也算过期：无从判断新鲜，宁可不发
  return age >= 0 && age < FRESH_MS
}

/**
 * 计算重启耗时；无法计算（负值 / 非有限）时返回空串
 * @param ms 毫秒
 * @returns 「耗时 X.XXs」或空串
 */
function tookText(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return ""
  return `耗时 ${(ms / 1000).toFixed(2)}s`
}

/**
 * 一条回执要补发的话
 *
 * `now` 用于算「从下达重启指令到账号重新上线」的耗时 —— `notice.at` 记于命令处理时、`now` 取于
 * 补发时（`bot/online`），两者都在同一台机器的墙钟上，故差值即这次重启对使用者可感的总时长
 * （含停机、被守护拉起、启动、账号重连）。取不到合理耗时时略去那半句，不硬凑一个数。
 * @param notice 回执
 * @param now 补发时刻（毫秒）
 * @returns 补发文本
 */
export function noticeText(notice: RestartNotice, now: number): string {
  const took = tookText(now - notice.at)
  const tail = took === "" ? "" : `，${took}`
  if (notice.kind === "kernel-update") {
    const ver = notice.versionChange === undefined ? "" : `（${notice.versionChange}）`
    return `内核已更新${ver}并重启完成${tail}，现在跑的是新版本`
  }
  return `重启完成${tail}`
}
