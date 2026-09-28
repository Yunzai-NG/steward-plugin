/**
 * 模块职责：`restart-notice.ts` 的用例 —— 新鲜期判定与补发措辞
 * 依赖方向：测试文件，依赖被测模块
 * 生命周期：纯函数
 * 注意事项：**新鲜期两端与时钟回拨都要钉住。** `isFresh` 错了不报错，只表现为「隔天被守护
 *          拉起也补一句我回来了」（窗口太大）或「正常重启赶不上补发」（太小）；时钟回拨时
 *          `age` 为负，也当过期 —— 无从判断新鲜就不发。
 */
import { describe, expect, it } from "vitest"
import { FRESH_MS, isFresh, noticeText } from "./restart-notice.js"
import type { RestartNotice } from "./restart-notice.js"

/**
 * 造一条回执
 * @param over 覆盖字段
 * @returns 回执
 */
function notice(over: Partial<RestartNotice> = {}): RestartNotice {
  return {
    selfId: "10000",
    target: { scene: "group", gid: "700000" },
    kind: "restart",
    at: 1_000_000,
    ...over
  }
}

describe("isFresh", () => {
  it("刚记下即补发", () => {
    expect(isFresh(notice({ at: 5000 }), 5000)).toBe(true)
  })

  it("窗口内补发", () => {
    expect(isFresh(notice({ at: 0 }), FRESH_MS - 1)).toBe(true)
  })

  it("到达窗口上限即不再补发 —— 隔天被守护拉起是噪声", () => {
    expect(isFresh(notice({ at: 0 }), FRESH_MS)).toBe(false)
    expect(isFresh(notice({ at: 0 }), FRESH_MS * 100)).toBe(false)
  })

  it("**时钟回拨（age 为负）当过期**：无从判断新鲜，宁可不发", () => {
    expect(isFresh(notice({ at: 10_000 }), 5000)).toBe(false)
  })
})

describe("noticeText", () => {
  it("普通重启带上耗时", () => {
    // at=1_000_000，now 往后 2560ms，即 2.56s
    expect(noticeText(notice({ kind: "restart", at: 1_000_000 }), 1_002_560)).toBe("重启完成，耗时 2.56s")
  })

  it("内核更新带上版本变化与耗时", () => {
    const text = noticeText(notice({ kind: "kernel-update", versionChange: "0.6.1 → 0.6.2", at: 0 }), 3000)
    expect(text).toContain("内核已更新")
    expect(text).toContain("0.6.1 → 0.6.2")
    expect(text).toContain("耗时 3.00s")
  })

  it("内核更新缺版本变化时也讲得出话，不出现 undefined", () => {
    const text = noticeText(notice({ kind: "kernel-update" }), 1_000_000)
    expect(text).toContain("内核已更新")
    expect(text).not.toContain("undefined")
  })

  it("**取不到合理耗时时略去那半句**：时钟回拨（now < at）不硬凑一个负数", () => {
    expect(noticeText(notice({ kind: "restart", at: 10_000 }), 5000)).toBe("重启完成")
  })
})
