/**
 * 模块职责：决定「更新全部插件」到底更新哪几个
 * 依赖方向：只依赖类型
 * 生命周期：纯函数
 * 注意事项：排除自己 —— 更新本插件会重写其目录，随后的重载在命令还在栈上时把它卸掉，回话就此
 *          消失；更新自己走单独命令。排除 `builtin`（内核安装目录里、非 git 仓库，更新等于让市场
 *          clone 盖上去）。加载失败的插件照常更新 —— 那恰是最该更新的一类，按目录更新与它能否跑无关。
 */
import type { PluginState } from "@yunzai-ng/types"

/** 一个待更新的目标 */
export interface Target {
  /** 插件名（同时也是安装目录名，市场按它寻址） */
  readonly name: string
}

/** 挑选目标时的已知条件 */
export interface PickOptions {
  /** 当前装着的插件 */
  readonly installed: readonly PluginState[]
  /** 本插件自己的名字，一律排除 */
  readonly self: string
  /** 使用者点名要更新的那几个；为空表示「全部」 */
  readonly only?: readonly string[]
}

/**
 * 挑出要更新的插件
 *
 * 点名时不做存在性过滤：写错名字应得到内核那句「没有名为 X 的插件」，而非被静默跳过。
 * @param opts 已知条件
 * @returns 目标清单，顺序即执行顺序
 */
export function pickTargets(opts: PickOptions): Target[] {
  const only = opts.only ?? []

  // 点名里含自己时也排掉，见文件头
  if (only.length > 0) {
    return only.filter(name => name !== opts.self).map(name => ({ name }))
  }

  return opts.installed
    .filter(one => one.name !== opts.self && !one.builtin)
    .map(one => ({ name: one.name }))
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
