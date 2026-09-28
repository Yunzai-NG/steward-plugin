/**
 * 模块职责：运维命令 —— 重启实例、关机、更新插件、更新内核
 * 依赖方向：依赖 `@yunzai-ng/core` 的 `definePlugin` 与本目录 config / text / targets / kernel / restart-notice
 * 生命周期：`setup` 时注册命令，随插件卸载由内核一并清理
 * 注意事项：先 `await e.reply(...)` 再做会卸掉插件的事（重启、关机、重载），反了则回话丢失。批量更新先全部
 *          拉完、回完汇总再逐个重载 —— 重载适配器会让当前账号掉线，汇总就发不出去了。`canRestart`
 *          在 `yzng start` 起的实例上恒真（不论有无守护），故探测不到守护时先问一句「确认」：裸起的
 *          实例停机后没人拉起。关机则**一律先问**，且不留重启回执。市场认目录名、宿主认声明名，见 targets.ts。
 */
import { definePlugin, parseDuration } from "@yunzai-ng/core"
import type { MessageEvent } from "@yunzai-ng/types"
import { CONFIG_SCHEMA } from "./config.js"
import type { StewardConfigRO } from "./config.js"
import { updateKernel } from "./kernel.js"
import { dirOf, parseNames, pickTargets } from "./targets.js"
import type { Target } from "./targets.js"
import { describeBatch, describeOutcome, reasonOf } from "./text.js"
import type { BatchItem } from "./text.js"
import { NOTICE_KEY, isFresh, noticeText } from "./restart-notice.js"
import type { RestartKind, RestartNotice } from "./restart-notice.js"

/** 本插件自己的声明名 */
const SELF = "steward"

/** 逐条更新的间隔，让每条更新的日志分得开 —— 批量出问题时那是唯一线索 */
const BATCH_GAP_MS = 200

/** 等使用者回「确认」的时长 */
const CONFIRM_TIMEOUT = "30s"

/** 内核市场对「索引里没有这个插件」的报错开头（market.ts 的 install 与 #tryPull 两处同一句） */
const NOT_IN_INDEX = "插件市场中没有名为"

export default definePlugin({
  name: SELF,
  version: "0.2.2",
  description: "指令运维：重启、关机、更新插件与内核。全部限主人",
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
     * 本插件的安装目录名；宿主没记下目录时退回声明名
     * @returns 目录名
     */
    const selfDir = (): string => {
      const state = ctx.app.plugins.get(SELF)
      return (state === undefined ? undefined : dirOf(state)) ?? SELF
    }

    /**
     * 重启前记下「发回哪个会话」，供重启后补发一句回执。写失败只记日志、不挡重启
     * @param e 触发命令的消息事件
     * @param kind 缘由
     * @param versionChange 内核更新时的版本变化
     */
    const saveRestartNotice = async (e: MessageEvent, kind: RestartKind, versionChange?: string): Promise<void> => {
      const notice: RestartNotice = {
        selfId: e.selfId,
        target: e.target,
        kind,
        at: Date.now(),
        ...(versionChange === undefined ? {} : { versionChange })
      }
      try {
        await ctx.kv.set(NOTICE_KEY, notice)
      } catch (err) {
        ctx.logger.warn(`重启回执写入失败，重启后不会补发提示：${reasonOf(err)}`)
      }
    }

    // 挂 bot/online 而非 app/ready：ready 时账号未必已重连。先删再发，见 restart-notice.ts 文件头
    ctx.on("bot/online", async bot => {
      let notice: RestartNotice | undefined
      try {
        notice = await ctx.kv.get<RestartNotice>(NOTICE_KEY)
      } catch (err) {
        ctx.logger.warn(`读取重启回执失败：${reasonOf(err)}`)
        return
      }
      // 只认当初那个账号：多账号实例上别的账号先上线不该替它领走
      if (notice === undefined || notice.selfId !== bot.selfId) return
      try {
        await ctx.kv.del(NOTICE_KEY)
      } catch {
        // 删不掉就不发，宁可漏一句也不在每次重连时刷屏
        return
      }
      // now 取一次，同时用于「够不够新鲜」与「耗时多少」：两者都以 notice.at 为起点
      const now = Date.now()
      if (!isFresh(notice, now)) return
      try {
        await bot.sendMessage(notice.target, noticeText(notice, now))
      } catch (err) {
        ctx.logger.warn(`重启回执补发失败：${reasonOf(err)}`)
      }
    })

    /**
     * 这台实例此刻能否执行重启；两种原因措辞分开，下一步不同
     * @param allowed 使用者是否允许重启
     * @returns 拦截原因；可以重启时 undefined
     */
    const restartBlockedBy = (allowed: boolean): string | undefined => {
      if (!allowed) return "本插件的「允许指令重启」已关闭，可在面板的配置页打开"
      if (!maint.canRestart) {
        return "这台实例的宿主没有接管重启（内核嵌在别的程序里时即如此），指令重启不可用，请按你的部署方式重启"
      }
      return undefined
    }

    /**
     * 要一句「确认」，回别的即取消
     * @param e 触发命令的消息事件
     * @param tip 问什么
     * @returns 是否继续
     */
    const askConfirm = async (e: MessageEvent, tip: string): Promise<boolean> => {
      const answer = await e.prompt({
        tip: `${tip}\n回复「确认」继续，${CONFIRM_TIMEOUT} 内不回或回别的即取消`,
        timeout: CONFIRM_TIMEOUT
      })
      if (answer?.text.trim() === "确认") return true
      await e.reply("已取消")
      return false
    }

    /**
     * 探测不到守护时先要一句「确认」
     *
     * 探测不到不等于没有守护（Windows 服务不留痕迹），故不拦，只问 —— 裸起的实例停机后没人拉起。
     * @param e 触发命令的消息事件
     * @param what 要做的事，拼进提示里
     * @returns 是否继续
     */
    const confirmUnsupervised = async (e: MessageEvent, what: string): Promise<boolean> => {
      if (maint.supervisor !== undefined) return true
      return askConfirm(
        e,
        `未检测到 pm2 / systemd。${what}会停机，若是裸 yzng start 起的实例，停机后不会自动拉起，` +
          `得你手动再启动（装了 Windows 服务一类守护的可忽略）。`
      )
    }

    /**
     * 更新一个插件（只更新，不重载 —— 重载放在回完话之后，见文件头）
     * @param target 目标
     * @param skipUnknown 是否把「不在索引里」归为跳过而非失败；只在「更新全部」时开
     * @returns 这一个的结局
     */
    const updateOne = async (target: Target, skipUnknown: boolean): Promise<BatchItem> => {
      const settings = conf()
      try {
        const outcome = await maint.updatePlugin(target.dir, {
          dependencies: settings.dependencies,
          onDirty: settings.onDirty as "abort" | "stash" | "discard"
        })
        return { name: target.name, outcome }
      } catch (err) {
        const reason = reasonOf(err)
        // 手装、不在索引里的插件本就更新不了，「全部」时算作失败只是噪声；点名时照常报错
        if (skipUnknown && reason.includes(NOT_IN_INDEX)) return { name: target.name, skipped: true }
        return { name: target.name, error: reason }
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
        if (!(await confirmUnsupervised(e, "重启"))) return

        const via = maint.supervisor === undefined ? "" : `（由 ${maint.supervisor} 拉起）`
        await e.reply(`正在重启${via}，稍等十几秒`)
        await saveRestartNotice(e, "restart")
        await maint.requestRestart({ reason: `主人 ${e.sender.uid} 通过指令重启` })
      })

    /* ────────────────────────────── 关机 ────────────────────────────── */

    ctx
      .command("#关机", { master: true })
      .alias("#停机", "#关闭实例")
      .desc("优雅停机且不再起来；之后只能在那台机器上手动启动")
      .action(async (e: MessageEvent) => {
        if (!conf().allowShutdown) {
          await e.reply("本插件的「允许指令关机」已关闭，可在面板的配置页打开")
          return
        }
        if (!maint.canShutdown) {
          await e.reply("这台实例的宿主没有接管关机，指令关机不可用，请按你的部署方式停机")
          return
        }

        /*
         * 关机一律先问，且措辞随守护而变
         *
         * 关掉之后没有任何聊天指令能把它启动回来，风险与重启不是一个量级。自带守护天然认得退出码
         * 0；外部守护则要反过来提醒：退出码 0 得靠 pm2 的 stop_exit_codes 一类配置才被认作「别重启」，
         * 没配就是关了又被拉起。
         */
        const caveat =
          maint.supervisor === "yzng"
            ? "由 yzng 自带守护托管：关机以退出码 0 退出，守护天然认作『别再拉起』，无需额外配置。"
            : maint.supervisor === "pm2"
              ? "检测到 pm2：需在其配置里写 stop_exit_codes: [0]，否则关掉会被立刻拉起来。"
              : maint.supervisor === "systemd"
                ? "检测到 systemd：Restart=on-failure 的单元不会拉起，Restart=always 的还需 RestartPreventExitStatus=0。"
                : "未检测到守护，关掉后应当不会有人拉起它。"
        if (!(await askConfirm(e, `关机之后**没有任何指令能把它启动回来**，只能在那台机器上手动启动。\n${caveat}`))) {
          return
        }

        // 不留重启回执：它是给「还会回来」的场景用的，关机后那条记录只会在下次手动启动时冒出来
        await e.reply("正在关机，再见")
        await maint.requestShutdown({ reason: `主人 ${e.sender.uid} 通过指令关机` })
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
          selfDir: selfDir(),
          only: names
        })

        if (targets.length === 0) {
          // 点了名却一个都不剩，只能是「只写了本插件的名字」
          await e.reply(
            names.length > 0
              ? "更新本插件要用「#更新自己」—— 重载自己会打断正在执行的这条命令"
              : "没有可更新的插件"
          )
          return
        }

        if (targets.length > 1) await e.reply(`开始更新 ${targets.length} 个插件，逐个来，请稍候`)

        const items: BatchItem[] = []
        for (const [i, target] of targets.entries()) {
          if (i > 0) await new Promise(resolve => setTimeout(resolve, BATCH_GAP_MS))
          items.push(await updateOne(target, names.length === 0))
        }

        // 没有新提交的不重载：重载会重建那个插件的状态，白付代价还可能打断它
        const toReload = conf().reload
          ? targets.filter((_, i) => {
              const outcome = items[i]?.outcome
              return outcome !== undefined && outcome.changed !== false
            })
          : []
        const tail =
          toReload.length === 0
            ? ""
            : `\n接下来重载 ${toReload.map(one => one.name).join("、")} 使新代码生效；失败会记在日志里，可在面板插件页手动重载`
        await e.reply((targets.length === 1 ? singleLine(items[0]) : describeBatch(items)) + tail)

        for (const target of toReload) {
          const ok = await maint.reloadPlugin(target.name)
          if (!ok) ctx.logger.warn(`${target.name} 已更新但重载失败，可在面板的插件页手动重载，或重启实例`)
        }
      })

    ctx
      .command("#更新自己", { master: true })
      .desc("更新本插件；更新后需重载或重启才生效")
      .action(async (e: MessageEvent) => {
        const settings = conf()
        try {
          const outcome = await maint.updatePlugin(selfDir(), {
            dependencies: settings.dependencies,
            onDirty: settings.onDirty as "abort" | "stash" | "discard"
          })
          if (outcome.changed === false) {
            await e.reply(describeOutcome(outcome))
            return
          }
          // 不自动重载自己：会在这条命令还在栈上时把本插件卸掉
          await e.reply(`${describeOutcome(outcome)}\n新代码尚未生效：请在面板的插件页重载本插件，或执行 #重启`)
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
        const plan =
          blocked !== undefined
            ? `注意：装好后无法自动重启（${blocked}）`
            : !settings.restartAfterKernel
              ? "装好后不自动重启（已在配置里关闭）"
              : maint.supervisor === undefined
                ? "装好且版本有变时会重启，重启前先问你一句（未检测到守护）"
                : "装好且版本有变时会自动重启"
        await e.reply(`开始把内核升到 ${target}，要跑包管理器，国内网络下可能要几分钟。\n${plan}`)

        const result = await updateKernel({
          home: ctx.app.paths.home,
          spec: target,
          timeoutMs: parseDuration(settings.kernelTimeout, 900_000)
        })

        if (!result.ok) {
          await e.reply(`${result.message}\n实例未受影响，仍在按原版本运行`)
          return
        }

        // 版本没变就别重启：已是最新时升级命令照样成功，跑的还是同一份代码
        if (!result.changed) {
          await e.reply(`${result.message}\n版本未变，无需重启`)
          return
        }

        const stale = `${result.message}\n**但现在跑的仍是旧内核** —— 新代码不能热替换进正在运行的进程。`
        if (blocked !== undefined || !settings.restartAfterKernel) {
          await e.reply(stale + (blocked ?? "「更新内核后自动重启」已关闭"))
          return
        }
        if (!(await confirmUnsupervised(e, "新内核生效需要重启，"))) {
          await e.reply(`${stale}想生效时执行 #重启 或手动重启`)
          return
        }

        await e.reply(`${result.message}\n正在重启以生效，稍等十几秒`)
        await saveRestartNotice(e, "kernel-update", result.versionChange)
        await maint.requestRestart({ reason: `更新内核至 ${target} 后重启` })
      })

    /* ────────────────────────────── 查看 ────────────────────────────── */

    ctx
      .command("#运维状态", { master: true })
      .desc("看看这台实例能不能重启、装了几个插件")
      .action(async (e: MessageEvent) => {
        const settings = conf()
        const installed = ctx.app.plugins.list()
        const updatable = pickTargets({ installed, self: SELF, selfDir: selfDir() })

        const lines = [
          `内核 ${ctx.app.version}`,
          `插件 ${installed.length} 个，其中 ${updatable.length} 个可经本插件更新`,
          `重启：${describeRestart(maint.canRestart, settings.allowRestart, maint.supervisor)}`,
          `关机：${describeShutdown(maint.canShutdown, settings.allowShutdown)}`,
          `撞上本地改动时：${settings.onDirty}`
        ]
        await e.reply(lines.join("\n"))
      })

    ctx.logger.info("运维命令已就绪：#重启、#关机、#更新插件、#更新自己、#更新内核、#运维状态")
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
  if (item.skipped === true) return `${item.name} 不在插件索引里，无法更新`
  return item.outcome === undefined ? `${item.name} 更新结果未知` : describeOutcome(item.outcome)
}

/**
 * 讲清重启这件事此刻的可用性
 * @param canRestart 宿主是否接管了重启
 * @param allowed 使用者是否允许
 * @param supervisor 探测到的守护
 * @returns 一句说明
 */
function describeRestart(canRestart: boolean, allowed: boolean, supervisor: string | undefined): string {
  if (!allowed) return "已在本插件配置里关闭"
  if (!canRestart) return "不可用（宿主没有接管重启）"
  return supervisor === undefined
    ? "可执行，但未检测到守护 —— 裸 yzng start 起的实例停机后不会自动拉起"
    : `可用（由 ${supervisor} 拉起）`
}

/**
 * 讲清关机这件事此刻的可用性
 * @param canShutdown 宿主是否接管了关机
 * @param allowed 使用者是否允许
 * @returns 一句说明
 */
function describeShutdown(canShutdown: boolean, allowed: boolean): string {
  if (!allowed) return "已在本插件配置里关闭"
  if (!canShutdown) return "不可用（宿主没有接管关机）"
  return "可用，执行前会问一句确认"
}
