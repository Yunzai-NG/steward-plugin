/**
 * 模块职责：本插件的配置 schema —— 重启与更新两件事各自的默认行为
 * 依赖方向：仅依赖 `@yunzai-ng/core` 的 schema 工具
 * 生命周期：模块加载期构造一次，之后只读
 * 注意事项：`allowRestart` 不是防误触（命令已限主人），而是**唯一能真正拦住重启的开关** ——
 *          `yzng start` 起的实例上 `canRestart` 恒真（不论有没有守护），插件据它拦不住谁。
 *          没有守护的实例停机后没人拉起，那种实例应当把本项关掉。
 */

import { s } from "@yunzai-ng/core"
import type { Infer } from "@yunzai-ng/core"
import type { DeepReadonly } from "@yunzai-ng/types"

/** 撞上本地改动时怎么办，三项与内核市场的同名取值一一对应 */
const DIRTY_MODES = [
  {
    value: "abort",
    label: "停手不改",
    description: "插件目录里有未提交的改动时原地中止，磁盘一点不动（最稳，也是缺省）"
  },
  {
    value: "stash",
    label: "暂存后更新",
    description: "先 git stash 收起改动再更新，事后可在该目录 git stash pop 取回"
  },
  {
    value: "discard",
    label: "丢弃改动",
    description: "直接丢掉本地改动再更新，**取不回来**。适合确知那些改动是编辑器或装依赖留下的垃圾"
  }
] as const

/** 本插件的配置 schema */
export const CONFIG_SCHEMA = s.object({
  /* ────────────────────────────── 重启 ────────────────────────────── */

  allowRestart: s
    .boolean()
    .default(true)
    .title("允许指令重启")
    .desc(
      "关掉后「重启」命令只回一句说明、不动实例。" +
        "内核自己没有重启能力，它做的是「优雅停机」，再由守护把它拉起来。" +
        "CLI 0.6.0 起 yzng start 缺省自带守护，裸起也能重启；只有以 --no-supervise 关掉自带守护、" +
        "又没挂 pm2 / systemd 时，重启才会「停了没人拉」，那种实例应把本项关掉（探测不到守护时本插件会先问一句再动手）。"
    )
    .group("重启")
    .order(1),

  allowShutdown: s
    .boolean()
    .default(true)
    .title("允许指令关机")
    .desc(
      "关机之后**没有任何聊天指令能把它开回来**，只能到机器上手动启动，故本插件每次都会先要一句确认。" +
        "另外守护认不认「别重启」取决于你的配置：pm2 要写 `stop_exit_codes: [0]`，" +
        "systemd 用 `Restart=always` 的要写 `RestartPreventExitStatus=0`，否则关了又会被拉起来"
    )
    .group("重启")
    .order(2),

  /* ────────────────────────────── 更新插件 ────────────────────────────── */

  onDirty: s
    .select([...DIRTY_MODES])
    .default("abort")
    .title("撞上本地改动时")
    .desc(
      "更新一个插件时，如果它的目录里有未提交的改动（含新放进去的文件）该怎么办。" +
        "改过插件源码、或在插件目录里试过东西的人会撞到这一项。"
    )
    .group("更新插件")
    .order(10),

  dependencies: s
    .boolean()
    .default(true)
    .title("更新后装依赖")
    .desc("插件的 package.json 变过时必须装，否则新代码 import 不到新依赖。关掉只为省时间，风险自负")
    .group("更新插件")
    .order(11),

  reload: s
    .boolean()
    .default(true)
    .title("更新后自动重载")
    .desc(
      "重载即让新代码生效，多数插件无须重启整个进程。" +
        "关掉则要自己去面板的插件页点重载，或重启实例"
    )
    .group("更新插件")
    .order(12),

  /* ────────────────────────────── 更新内核 ────────────────────────────── */

  kernelTarget: s
    .string()
    .default("latest")
    .pattern(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/)
    .title("内核目标版本")
    .desc(
      "填 dist-tag（如 latest）或具体版本号（如 0.6.1）。" +
        "**不收版本范围**（`^0.6.0` 一类）：那些符号在 Windows 的 cmd 里有特殊含义，而升级要经包管理器执行"
    )
    .group("更新内核")
    .order(20),

  kernelTimeout: s
    .duration()
    .default("15m")
    .title("内核更新超时")
    .desc("国内网络下一次冷装十几分钟并不罕见。超时的后果是留下一个装了一半的 node_modules，故不宜调得太短")
    .group("更新内核")
    .order(21),

  restartAfterKernel: s
    .boolean()
    .default(true)
    .title("更新内核后自动重启")
    .desc(
      "新内核代码不可能热替换进正在跑的进程，**不重启就仍是旧内核在跑**。" +
        "关掉则更新完只回一句提示，由自己决定何时重启"
    )
    .group("更新内核")
    .order(22)
})

/** 本插件的配置类型，由 schema 推导 */
export type StewardConfig = Infer<typeof CONFIG_SCHEMA>

/** 从 `ctx.config.get()` 取到的只读配置 */
export type StewardConfigRO = DeepReadonly<StewardConfig>
