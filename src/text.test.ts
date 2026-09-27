/**
 * 模块职责：`text.ts` 的用例 —— 更新结果讲成的那几句话
 * 依赖方向：测试文件，只依赖被测模块与类型
 * 生命周期：纯函数，无夹具
 * 注意事项：这一族里最要紧的一条是**「暂存」与「丢弃」绝不可讲成同一句**。对一个刚把改动
 *          丢掉的人说「可以 git stash pop 取回」，他照做、得到一句「没有 stash 可弹出」，
 *          并由此以为改动还在某处。内核把这两个字段分开报正是为了这件事，故此处对二者的
 *          断言写成互斥的两条，而不是各测一句包含关系。
 */
import { describe, expect, it } from "vitest"
import { describeBatch, describeOutcome, reasonOf, type BatchItem } from "./text.js"
import type { PluginUpdateOutcome } from "@yunzai-ng/types"

/**
 * 造一个更新结果
 * @param patch 要盖上的字段
 * @returns 更新结果
 */
function outcome(patch: Partial<PluginUpdateOutcome> = {}): PluginUpdateOutcome {
  return { name: "demo", version: "1.0.0", ...patch }
}

describe("describeOutcome", () => {
  it("版本变了就写成「旧 → 新」", () => {
    const text = describeOutcome(outcome({ fromVersion: "0.9.0", version: "1.0.0" }))
    expect(text).toBe("demo 0.9.0 → 1.0.0")
  })

  it("**已是最新时不写箭头** —— 「1.0.0 → 1.0.0」读着像更新过一次", () => {
    const text = describeOutcome(outcome({ changed: false, fromVersion: "1.0.0" }))
    expect(text).toContain("已是最新")
    expect(text).not.toContain("→")
  })

  it("有新提交而版本号没变时明说，不能只报版本号", () => {
    // 改了代码没抬版本号在插件仓库里很常见；只报版本号会让人以为什么都没发生
    const text = describeOutcome(outcome({ changed: true, fromVersion: "1.0.0", version: "1.0.0" }))
    expect(text).toContain("有新提交")
  })

  it("取不到旧版本时只报新版本 —— 整目录重装那条路不经 git", () => {
    expect(describeOutcome(outcome())).toBe("demo 已更新到 1.0.0")
  })

  it("暂存过改动时给出取回的办法", () => {
    const text = describeOutcome(outcome({ fromVersion: "0.9.0", stashed: true }))
    expect(text).toContain("stash pop")
  })

  it("**丢弃改动时绝不能提 stash pop** —— 那会让人以为改动还在", () => {
    const text = describeOutcome(outcome({ fromVersion: "0.9.0", discarded: true }))
    expect(text).toContain("取不回来")
    expect(text).not.toContain("stash pop")
  })

  it("两者都没有时不提本地改动", () => {
    const text = describeOutcome(outcome({ fromVersion: "0.9.0" }))
    expect(text).not.toContain("stash")
    expect(text).not.toContain("丢弃")
  })
})

describe("describeBatch", () => {
  it("一个都没有时明说，而不是回一句空话", () => {
    expect(describeBatch([])).toBe("没有可更新的插件")
  })

  it("**三类分开数**：真更新了、已最新、失败了", () => {
    const items: BatchItem[] = [
      { name: "a", outcome: outcome({ name: "a", fromVersion: "0.9.0", version: "1.0.0" }) },
      { name: "b", outcome: outcome({ name: "b", changed: false }) },
      { name: "c", error: "网络不通" }
    ]
    const text = describeBatch(items)
    expect(text).toContain("共 3 个插件")
    expect(text).toContain("更新 1")
    expect(text).toContain("已最新 1")
    expect(text).toContain("失败 1")
  })

  it("只报「成功 N 个」是不够的：N 个里一个都没动时要看得出来", () => {
    const items: BatchItem[] = [
      { name: "a", outcome: outcome({ name: "a", changed: false }) },
      { name: "b", outcome: outcome({ name: "b", changed: false }) }
    ]
    const text = describeBatch(items)
    expect(text).toContain("更新 0")
    expect(text).toContain("已是最新：a、b")
  })

  it("更新过的逐条列出，已最新的挤在一行", () => {
    const items: BatchItem[] = [
      { name: "a", outcome: outcome({ name: "a", fromVersion: "0.9.0", version: "1.0.0" }) },
      { name: "b", outcome: outcome({ name: "b", changed: false }) },
      { name: "c", outcome: outcome({ name: "c", changed: false }) }
    ]
    const lines = describeBatch(items).split("\n")
    // 汇总、一条更新、一行「已是最新」
    expect(lines).toHaveLength(3)
    expect(lines[1]).toContain("· a 0.9.0 → 1.0.0")
    expect(lines[2]).toBe("已是最新：b、c")
  })

  it("失败的带上原因，且与成功的用不同前缀区分", () => {
    const text = describeBatch([{ name: "a", error: "目录里有改动" }])
    expect(text).toContain("× a：目录里有改动")
  })
})

describe("reasonOf", () => {
  it("Error 取 message", () => {
    expect(reasonOf(new Error("坏了"))).toBe("坏了")
  })

  it("message 为空的 Error 不返回空串", () => {
    // 回一句空话等于什么都没说，使用者看到的是「更新失败：」
    expect(reasonOf(new Error(""))).not.toBe("")
  })

  it("非 Error 一律转成字符串", () => {
    expect(reasonOf("就是不行")).toBe("就是不行")
    expect(reasonOf(404)).toBe("404")
  })

  it("空串与 undefined 退回一句兜底", () => {
    expect(reasonOf("")).toBe("未知原因")
    expect(reasonOf(undefined)).toBe("undefined")
  })
})
