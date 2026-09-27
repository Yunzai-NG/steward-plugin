/**
 * 模块职责：`targets.ts` 的用例 —— 批量更新挑谁、命令尾巴怎么切
 * 依赖方向：测试文件，只依赖被测模块与类型
 * 生命周期：纯函数，无夹具
 * 注意事项：**最要紧的一条是「一律排除自己」**，而它有两条路要各测一次：不点名（全部）与
 *          点名（写了自己的名字）。漏掉后者的症状是「更新全部好好的，指名更新本插件时
 *          发了指令没有下文」—— 重载把还在栈上的命令处理函数连同它的回话一起卸掉了。
 */
import { describe, expect, it } from "vitest"
import { parseNames, pickTargets } from "./targets.js"
import type { PluginState } from "@yunzai-ng/types"

/**
 * 造一个插件状态
 * @param name 插件名
 * @param patch 要盖上的字段
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

describe("pickTargets", () => {
  it("不点名时取全部已装插件", () => {
    const targets = pickTargets({ installed: [state("a"), state("b")], self: "steward" })
    expect(targets.map(one => one.name)).toEqual(["a", "b"])
  })

  it("**一律排除自己** —— 更新本插件会在回话之前把自己卸掉", () => {
    const targets = pickTargets({ installed: [state("a"), state("steward"), state("b")], self: "steward" })
    expect(targets.map(one => one.name)).toEqual(["a", "b"])
  })

  it("点名里写了自己也排掉 —— 那条路要走专门的命令", () => {
    const targets = pickTargets({ installed: [], self: "steward", only: ["a", "steward", "b"] })
    expect(targets.map(one => one.name)).toEqual(["a", "b"])
  })

  it("排除随发行版预置的插件：它们不是 git 仓库，内核自己的升级走 yzng update", () => {
    const targets = pickTargets({ installed: [state("a"), state("builtin-one", { builtin: true })], self: "steward" })
    expect(targets.map(one => one.name)).toEqual(["a"])
  })

  it("**加载失败的插件照常更新** —— 那恰恰是最需要更新的一类", () => {
    // 它可能正因为某个与新内核不兼容的缺陷才加载不起来，而修好的代码就在上游
    const targets = pickTargets({
      installed: [state("broken", { status: "error", error: "import 失败" })],
      self: "steward"
    })
    expect(targets.map(one => one.name)).toEqual(["broken"])
  })

  it("点名时不做存在性过滤 —— 写错名字该得到内核那句「没有名为 X 的插件」", () => {
    // 静默跳过的表现是「我明明写了它却没更新」，比一句报错难查得多
    const targets = pickTargets({ installed: [state("a")], self: "steward", only: ["不存在的"] })
    expect(targets.map(one => one.name)).toEqual(["不存在的"])
  })

  it("点名优先于「全部」：给了 only 就不再看 installed", () => {
    const targets = pickTargets({ installed: [state("a"), state("b")], self: "steward", only: ["b"] })
    expect(targets.map(one => one.name)).toEqual(["b"])
  })

  it("一个插件都没装时给空数组，而不是抛错", () => {
    expect(pickTargets({ installed: [], self: "steward" })).toEqual([])
  })

  it("只装了本插件时也给空数组", () => {
    expect(pickTargets({ installed: [state("steward")], self: "steward" })).toEqual([])
  })
})

describe("parseNames", () => {
  it("空白分隔多个名字", () => {
    expect(parseNames("a b c")).toEqual(["a", "b", "c"])
  })

  it("**全角空格也当分隔符** —— 中文输入法下最容易打出的就是它", () => {
    // 不归一化的话使用者会看到「没有名为 a<全角空格>b 的插件」这种带奇怪字符的报错。
    // 字面量写成 \u3000 而非直接打那个字符：肉眼分不出它与半角空格，而 lint 也不许
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
