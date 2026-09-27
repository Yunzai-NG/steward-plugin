/**
 * 模块职责：`targets.ts` 的用例 —— 批量更新挑谁、目录名与声明名怎么配对、命令尾巴怎么切
 * 依赖方向：测试文件，只依赖被测模块与类型
 * 生命周期：纯函数，无夹具
 * 注意事项：**两条最要紧的**：一律排除自己（不点名与点名两条路各测一次，漏后者的症状是「更新全部
 *          好好的，指名更新本插件时发了指令没下文」）；目录名≠声明名时更新交目录名、重载交声明名
 *          （`mhy-game` 装在 `mhy-game-plugin/`），配错则报「市场里没有名为 X」或重载错对象。
 */
import { describe, expect, it } from "vitest"
import { dirOf, parseNames, pickTargets } from "./targets.js"
import type { PluginState } from "@yunzai-ng/types"

/**
 * 造一个插件状态
 * @param name 声明名
 * @param patch 要盖上的字段（`root` 决定目录名，默认与声明名同名）
 * @returns 插件状态
 */
function state(name: string, patch: Partial<PluginState> = {}): PluginState {
  return {
    name,
    version: "1.0.0",
    root: `/plugins/${name}`,
    status: "loaded",
    loadCost: 1,
    commands: 0,
    tasks: 0,
    middlewares: 0,
    builtin: false,
    configured: false,
    ...patch
  }
}

/** 声明名与安装目录名不同的插件，最常见的一种实际情形 */
function named(name: string, dir: string, patch: Partial<PluginState> = {}): PluginState {
  return state(name, { root: `/plugins/${dir}`, ...patch })
}

describe("dirOf", () => {
  it("取 root 的最后一段作目录名", () => {
    expect(dirOf(named("mhy-game", "mhy-game-plugin"))).toBe("mhy-game-plugin")
  })

  it("root 为空（内置等）时给 undefined，而不是空串", () => {
    expect(dirOf(state("x", { root: "" }))).toBeUndefined()
  })
})

describe("pickTargets", () => {
  it("不点名时取全部已装插件，dir 与 name 都带上", () => {
    const targets = pickTargets({ installed: [state("a"), state("b")], self: "steward", selfDir: "steward" })
    expect(targets).toEqual([
      { dir: "a", name: "a" },
      { dir: "b", name: "b" }
    ])
  })

  it("**目录名≠声明名**：更新用目录名，重载用声明名", () => {
    // 这是本次修复的核心：list() 给的是声明名，而 maint.updatePlugin 要目录名
    const targets = pickTargets({
      installed: [named("mhy-game", "mhy-game-plugin")],
      self: "steward",
      selfDir: "steward"
    })
    expect(targets).toEqual([{ dir: "mhy-game-plugin", name: "mhy-game" }])
  })

  it("**按声明名排除自己** —— 更新本插件会在回话之前把自己卸掉", () => {
    const targets = pickTargets({ installed: [state("a"), state("steward")], self: "steward", selfDir: "steward" })
    expect(targets.map(one => one.name)).toEqual(["a"])
  })

  it("**按目录名排除自己** —— 本插件目录名与声明名不同时也要排掉", () => {
    const targets = pickTargets({
      installed: [state("a"), named("steward", "steward-plugin")],
      self: "steward",
      selfDir: "steward-plugin"
    })
    expect(targets.map(one => one.name)).toEqual(["a"])
  })

  it("点名里写了自己也排掉 —— 那条路要走专门的命令", () => {
    const targets = pickTargets({
      installed: [state("a"), state("steward")],
      self: "steward",
      selfDir: "steward",
      only: ["a", "steward"]
    })
    expect(targets.map(one => one.name)).toEqual(["a"])
  })

  it("点名可用目录名或声明名，都解析到同一目标", () => {
    const installed = [named("mhy-game", "mhy-game-plugin")]
    const byName = pickTargets({ installed, self: "steward", selfDir: "steward", only: ["mhy-game"] })
    const byDir = pickTargets({ installed, self: "steward", selfDir: "steward", only: ["mhy-game-plugin"] })
    expect(byName).toEqual([{ dir: "mhy-game-plugin", name: "mhy-game" }])
    expect(byDir).toEqual([{ dir: "mhy-game-plugin", name: "mhy-game" }])
  })

  it("同一插件被两种名字各写一次，只更新一遍", () => {
    const targets = pickTargets({
      installed: [named("mhy-game", "mhy-game-plugin")],
      self: "steward",
      selfDir: "steward",
      only: ["mhy-game", "mhy-game-plugin"]
    })
    expect(targets).toEqual([{ dir: "mhy-game-plugin", name: "mhy-game" }])
  })

  it("排除随发行版预置的插件：它们不是 git 仓库，内核自己的升级走更新内核", () => {
    const targets = pickTargets({
      installed: [state("a"), state("builtin-one", { builtin: true })],
      self: "steward",
      selfDir: "steward"
    })
    expect(targets.map(one => one.name)).toEqual(["a"])
  })

  it("**加载失败的插件照常更新** —— 那恰恰是最需要更新的一类", () => {
    // 它可能正因为某个与新内核不兼容的缺陷才加载不起来，而修好的代码就在上游
    const targets = pickTargets({
      installed: [state("broken", { status: "error", error: "import 失败" })],
      self: "steward",
      selfDir: "steward"
    })
    expect(targets.map(one => one.name)).toEqual(["broken"])
  })

  it("点名一个没装的名字：不做存在性过滤，dir 与 name 都取原样交给内核", () => {
    // 静默跳过的表现是「我明明写了它却没更新」，比一句报错难查；交给内核报「没有名为 X」
    const targets = pickTargets({ installed: [state("a")], self: "steward", selfDir: "steward", only: ["不存在的"] })
    expect(targets).toEqual([{ dir: "不存在的", name: "不存在的" }])
  })

  it("一个插件都没装时给空数组，而不是抛错", () => {
    expect(pickTargets({ installed: [], self: "steward", selfDir: "steward" })).toEqual([])
  })

  it("只装了本插件时也给空数组", () => {
    expect(pickTargets({ installed: [state("steward")], self: "steward", selfDir: "steward" })).toEqual([])
  })
})

describe("parseNames", () => {
  it("空白分隔多个名字", () => {
    expect(parseNames("a b c")).toEqual(["a", "b", "c"])
  })

  it("**全角空格也当分隔符** —— 中文输入法下最容易打出的就是它", () => {
    // 不归一化的话使用者会看到「没有名为 a<全角空格>b 的插件」这种带奇怪字符的报错。
    // 字面量写成 \u3000 转义而非直接打那个字符：肉眼分不出它与半角空格，而 lint 也不许
    expect(parseNames("a\u3000b")).toEqual(["a", "b"])
  })

  it("中英文逗号与顿号一并接受", () => {
    expect(parseNames("a, b，c、d")).toEqual(["a", "b", "c", "d"])
  })

  it("没写名字时给空数组 —— 调用方据此走「全部」那条路", () => {
    expect(parseNames("")).toEqual([])
    expect(parseNames("   ")).toEqual([])
  })

  it("前后多余的空白不留进名字里", () => {
    expect(parseNames("  a  ")).toEqual(["a"])
  })
})
