/**
 * 模块职责：运维命令 —— 重启实例、更新插件、更新内核
 * 依赖方向：依赖 `@yunzai-ng/core` 的 `definePlugin` 与本目录 config / text / targets / kernel
 * 生命周期：`setup` 时注册命令，随插件卸载由内核一并清理
 * 注意事项：每条命令先 `await e.reply(...)` 再动手 —— 重启与「更新+重载」都会卸掉本插件，反了
 *          则回话丢失，表现为「发了指令没下文」。能否重启看 `maint.canRestart`（确定事实），
 *          `supervisor` 只探测、不拦截。更新全部排除自己（见 targets.ts），更新自己走单独命令
 *          且不自动重载。更新内核后必须重启才生效，重启不可用时要明说「跑的仍是旧内核」。
 */
import { definePlugin, parseDuration } from "@yunzai-ng/core"
import type { MessageEvent } from "@yunzai-ng/types"
import { CONFIG_SCHEMA } from "./config.js"
import type { StewardConfigRO } from "./config.js"
import { updateKernel } from "./kernel.js"
import { parseNames, pickTargets } from "./targets.js"
import { describeBatch, describeOutcome, reasonOf } from "./text.js"
import type { BatchItem } from "./text.js"

/** 本插件自己的名字，批量更新时据此排除 */
const SELF = "steward"

/** 逐条更新的间隔，让每条更新的日志分得开 —— 批量出问题时那是唯一线索 */
const BATCH_GAP_MS = 200

export default definePlugin({
  name: SELF,
  version: "0.1.0",
  description: "指令运维：重启实例、更新插件与内核。全部限主人",
  configSchema: CONFIG_SCHEMA,

  setup(ctx) {
    /**
     * 取当前配置，每次现取不存快照 —— 面板改完设置下一条命令即按新值走
     * @returns 只读配置
     */
    const conf = (): StewardConfigRO => ctx.config.get() as StewardConfigRO

    /** 维护面 —— 内核 0.6.1 起提供 */
    const maint = ctx.app.maintenance

    /**
     * 说明这台实例重启不了，以及为什么。两种原因措辞分开：使用者关掉的（改配置）与没有守护的（装 pm2）。
     * @param allowed 使用者是否允许重启
     * @returns 拦截原因；可以重启时 undefined
     */
    const restartBlockedBy = (allowed: boolean): string | undefined => {
      if (!allowed) return "本插件的「允许指令重启」已关闭，可在面板的配置页打开"
      if (!maint.canRestart) {
        return (
          "这台实例没有外部守护接管重启 —— 内核自己只能停机，停了就起不来了。\n" +
          "装上 pm2 / systemd / Windows 服务之一再用本命令，或手动重启"
        )
      }
      return undefined
    }

    /**
     * 更新一个插件并按设置重载
     * @param name 插件名
     * @returns 这一个的结局
     */
    const updateOne = async (name: string): Promise<BatchItem> => {
      const settings = conf()
      try {
        const outcome = await maint.updatePlugin(name, {
          dependencies: settings.dependencies,
          onDirty: settings.onDirty as "abort" | "stash" | "discard"
        })
        // 没有新提交时不重载：重载会重建那个插件的状态（计时器、连接、缓存），白付代价还可能打断它
        if (settings.reload && outcome.changed !== false) {
          const ok = await maint.reloadPlugin(name)
          if (!ok) ctx.logger.warn(`${name} 已更新但重载失败，可在面板的插件页手动重载，或重启实例`)
        }
        return { name, outcome }
      } catch (err) {
        return { name, error: reasonOf(err) }
      }
    }

    /* ────────────────────────────── 重启 ────────────────────────────── */

    ctx
      .command("#重启", { master: true })
      .alias("#重启内核", "#重启实例")
      .desc("优雅停机后由外部守护拉起（需 pm2 / systemd 一类）")
      .action(async (e: MessageEvent) => {
        const blocked = restartBlockedBy(conf().allowRestart)
        if (blocked !== undefined) {
          await e.reply(blocked)
          return
        }

        // 先把话说完：这之后本插件就要被卸载了，见文件头第 1 条
        const via = maint.supervisor === undefined ? "" : `（由 ${maint.supervisor} 拉起）`
        await e.reply(`正在重启${via}，稍等十几秒再看看我在不在`)

        await maint.requestRestart({ reason: `主人 ${e.sender.uid} 通过指令重启` })
      })

    /* ────────────────────────────── 更新插件 ────────────────────────────── */

    ctx
      .command("#更新插件", { master: true })
      .desc("更新指定插件并重载；不写名字则更新全部（本插件自己除外）")
      .action(async (e: MessageEvent) => {
        const names = parseNames(e.command?.rest ?? "")
        const targets = pickTargets({
          installed: ctx.app.plugins.list(),
          self: SELF,
          only: names
        })

        if (targets.length === 0) {
          // 点了名却一个都不剩，只能是「只写了本插件的名字」
          const why =
            names.length > 0
              ? `更新本插件要用「#更新自己」—— 更新完它自己会被重载，那会打断正在执行的这条命令`
              : "没有可更新的插件"
          await e.reply(why)
          return
        }

        // 一个插件时不必先报「开始」：那句话与结果几乎同时到达，只是噪声
        if (targets.length > 1) await e.reply(`开始更新 ${targets.length} 个插件，逐个来，请稍候`)

        const items: BatchItem[] = []
        for (const [i, target] of targets.entries()) {
          if (i > 0) await new Promise(resolve => setTimeout(resolve, BATCH_GAP_MS))
          items.push(await updateOne(target.name))
        }

        await e.reply(targets.length === 1 ? singleLine(items[0]) : describeBatch(items))
      })

    ctx
      .command("#更新自己", { master: true })
      .desc("更新本插件；更新后需重载或重启才生效")
      .action(async (e: MessageEvent) => {
        const settings = conf()
        try {
          const outcome = await maint.updatePlugin(SELF, {
            dependencies: settings.dependencies,
            onDirty: settings.onDirty as "abort" | "stash" | "discard"
          })
          if (outcome.changed === false) {
            await e.reply(describeOutcome(outcome))
            return
          }
          // 不自动重载自己：重载会在这条命令还在栈上时把本插件卸掉，回话就此消失。交给使用者决定何时重载或重启
          await e.reply(
            `${describeOutcome(outcome)}\n新代码尚未生效：请在面板的插件页重载本插件，或执行 #重启`
          )
        } catch (err) {
          await e.reply(`更新失败：${reasonOf(err)}`)
        }
      })

    /* ────────────────────────────── 更新内核 ────────────────────────────── */

    ctx
      .command("#更新内核", { master: true })
      .alias("#升级内核")
      .desc("经包管理器把内核升到目标版本，之后重启才生效")
      .action(async (e: MessageEvent) => {
        const settings = conf()
        const target = settings.kernelTarget

        // 先判重启可用性再装：装完才发现重启不了，会停在「盘上新内核、跑着旧内核」而使用者以为已完成
        const blocked = settings.restartAfterKernel ? restartBlockedBy(settings.allowRestart) : undefined

        await e.reply(
          `开始把内核升到 ${target}，要跑包管理器，国内网络下可能要几分钟。\n` +
            (blocked === undefined ? "装好后会自动重启" : `注意：装好后无法自动重启（${blocked}）`)
        )

        const result = await updateKernel({
          home: ctx.app.paths.home,
          spec: target,
          timeoutMs: parseDuration(settings.kernelTimeout, 900_000)
        })

        if (!result.ok) {
          // `message` 里已经把「超时留下半装的依赖」与「装失败」分开讲过了，原样转达
          await e.reply(`${result.message}\n实例未受影响，仍在按原版本运行`)
          return
        }

        // 版本没变就别重启：已是最新时升级命令照样成功，但跑的还是同一份代码，重启纯属白停一次机
        if (!result.changed) {
          await e.reply(`${result.message}\n版本未变，无需重启`)
          return
        }

        if (blocked !== undefined || !settings.restartAfterKernel) {
          const why = blocked ?? "「更新内核后自动重启」已关闭"
          await e.reply(
            `${result.message}\n` +
              `**但现在跑的仍是旧内核** —— 新代码不能热替换进正在运行的进程。${why}`
          )
          return
        }

        await e.reply(`${result.message}\n正在重启以生效，稍等十几秒`)
        await maint.requestRestart({ reason: `更新内核至 ${target} 后重启` })
      })

    /* ────────────────────────────── 查看 ────────────────────────────── */

    ctx
      .command("#运维状态", { master: true })
      .desc("看看这台实例能不能重启、装了几个插件")
      .action(async (e: MessageEvent) => {
        const settings = conf()
        const installed = ctx.app.plugins.list()
        const updatable = pickTargets({ installed, self: SELF })

        const lines = [
          `内核 ${ctx.app.version}`,
          `插件 ${installed.length} 个，其中 ${updatable.length} 个可经本插件更新`,
          `重启：${describeRestart(maint.canRestart, settings.allowRestart, maint.supervisor)}`,
          `撞上本地改动时：${settings.onDirty}`
        ]
        await e.reply(lines.join("\n"))
      })

    ctx.logger.info("运维命令已就绪：#重启、#更新插件、#更新自己、#更新内核、#运维状态")
  }
})

/**
 * 把单个插件的结局讲成一句（批量走 describeBatch 汇总计数，单个直说结果）
 * @param item 结局；不存在时给一句兜底
 * @returns 一句话
 */
function singleLine(item: BatchItem | undefined): string {
  if (item === undefined) return "没有可更新的插件"
  if (item.error !== undefined) return `${item.name} 更新失败：${item.error}`
  return item.outcome === undefined ? `${item.name} 更新结果未知` : describeOutcome(item.outcome)
}

/**
 * 讲清重启这件事此刻的可用性
 *
 * 三种情形各自的下一步不同：使用者关掉了（去配置页）、没有守护（去装 pm2）、可用。
 * @param canRestart 内核是否有人接管重启
 * @param allowed 使用者是否允许
 * @param supervisor 探测到的守护
 * @returns 一句说明
 */
function describeRestart(
  canRestart: boolean,
  allowed: boolean,
  supervisor: string | undefined
): string {
  if (!allowed) return "已在本插件配置里关闭"
  if (!canRestart) return "不可用（没有外部守护接管，停机后起不来）"
  return supervisor === undefined ? "可用" : `可用（探测到 ${supervisor}）`
}
