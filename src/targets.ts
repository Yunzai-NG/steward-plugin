/**
 * 模块职责：决定「更新插件」到底更新哪几个，并把每个目标的两种名字配对
 * 依赖方向：依赖 node:path 与类型
 * 生命周期：纯函数
 * 注意事项：市场按**安装目录名**寻址、宿主按 `definePlugin` 的**声明名**寻址，两者常不同
 *          （`mhy-game` 装在 `mhy-game-plugin/`）。更新交目录名、重载交声明名，混用则报「市场里
 *          没有名为 X 的插件」或重载错对象。点名时两种写法都认。排除自己（重载会在命令还在栈上时
 *          卸掉本插件）与 `builtin`；加载失败的照常更新 —— 那恰是最该更新的一类。
 */
import { basename } from "node:path"
import type { PluginState } from "@yunzai-ng/types"

/** 一个待更新的目标 */
export interface Target {
  /** 安装目录名，交给 `maint.updatePlugin` */
  readonly dir: string
  /** 声明名，交给 `maint.reloadPlugin`；点名了一个没装的名字时与 `dir` 相同 */
  readonly name: string
}

/** 挑选目标时的已知条件 */
export interface PickOptions {
  /** 当前装着的插件 */
  readonly installed: readonly PluginState[]
  /** 本插件自己的声明名 */
  readonly self: string
  /** 本插件自己的安装目录名 */
  readonly selfDir: string
  /** 使用者点名要更新的那几个（声明名或目录名皆可）；为空表示「全部」 */
  readonly only?: readonly string[]
}

/**
 * 取插件的安装目录名
 * @param state 插件状态
 * @returns 目录名；宿主没记下目录时 undefined
 */
export function dirOf(state: PluginState): string | undefined {
  return state.root === "" ? undefined : basename(state.root)
}

/**
 * 挑出要更新的插件
 *
 * 点名时不做存在性过滤：认不出的名字原样交给内核，让使用者得到「没有名为 X 的插件」而非静默跳过。
 * @param opts 已知条件
 * @returns 目标清单，顺序即执行顺序
 */
export function pickTargets(opts: PickOptions): Target[] {
  const isSelf = (name: string, dir: string | undefined): boolean => name === opts.self || dir === opts.selfDir
  const only = opts.only ?? []

  if (only.length > 0) {
    const picked: Target[] = []
    for (const wanted of only) {
      const hit = opts.installed.find(one => one.name === wanted || dirOf(one) === wanted)
      const dir = hit === undefined ? wanted : (dirOf(hit) ?? wanted)
      const name = hit?.name ?? wanted
      if (isSelf(name, dir)) continue
      // 同一个插件被两种名字各写一次时只更新一遍
      if (picked.some(one => one.dir === dir)) continue
      picked.push({ dir, name })
    }
    return picked
  }

  const all: Target[] = []
  for (const one of opts.installed) {
    const dir = dirOf(one)
    if (dir === undefined || one.builtin || isSelf(one.name, dir)) continue
    all.push({ dir, name: one.name })
  }
  return all
}

/**
 * 从命令尾巴上切出插件名，全角空格（`\u3000`，中文输入法下最常打出）也当分隔符 ——
 * 不归一化就会得到带看不出字符的「没有名为 X」报错。
 * @param rest 命令后面剩下的那段文本
 * @returns 插件名清单；没写时空数组
 */
export function parseNames(rest: string): string[] {
  return rest
    .replace(/\u3000/g, " ")
    .split(/[\s,，、]+/)
    .map(one => one.trim())
    .filter(one => one !== "")
}
