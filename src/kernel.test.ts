/**
 * 模块职责：`kernel.ts` 的用例 —— 下发了什么、版本号白名单、非 CLI 部署、失败与超时怎么讲
 * 依赖方向：测试文件，依赖被测模块
 * 生命周期：纯函数，执行实现与 CLI 探测由每条用例各自替换
 * 注意事项：**这一层守的是「下发了什么」而不是「升级成不成」。** 真去跑一次升级既慢又会改动
 *          本机，而这条路的正确性几乎全在实参上：node 路径、bin.js 路径、`--to`、工作目录、超时。
 *
 *          **版本号白名单是这条路上唯一的注入面。** 它错了不报错，只让一条命令悄悄变成另一条，
 *          故对反例的断言比对正例的多。
 *
 *          **`hasCli` 缺省真去看磁盘，测试一律注入。** 测试里的 home 是假路径，bin.js 不存在，
 *          不注入的话每条用例都会走进「非 CLI 部署」那条早退，测不到真正想测的下发逻辑。
 */
import { describe, expect, it } from "vitest"
import process from "node:process"
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { cliBinPath, isValidSpec, readCoreVersion, updateKernel } from "./kernel.js"
import type { KernelUpdateRunner } from "./kernel.js"

/** 记下一次调用的实参 */
interface Seen {
  /** 当前 node 可执行文件 */
  nodeExec: string
  /** 实参（首个为 bin.js 路径） */
  args: readonly string[]
  /** 工作目录 */
  cwd: string
  /** 超时毫秒 */
  timeoutMs: number
}

/** 恒真的 CLI 探测 —— 测试的假 home 上 bin.js 不存在，故一律注入它绕过早退 */
const cliPresent = (): boolean => true

/**
 * 造一个「版本号从升级前到升级后如此变化」的读取实现
 *
 * `readVersion` 真去读磁盘，测试的假 home 读不到，故一律注入。先返回 before、之后返回 after，
 * 用一个计数器区分两次调用 —— 传入相同值即模拟「已是最新，没变」。
 * @param before 升级前版本
 * @param after 升级后版本
 * @returns 读取实现
 */
function versions(before: string | undefined, after: string | undefined): (home: string) => string | undefined {
  let calls = 0
  return () => (calls++ === 0 ? before : after)
}

/** 版本没变（已是最新）的读取实现 */
const unchanged = (v = "0.6.1"): (home: string) => string | undefined => versions(v, v)

/**
 * 造一个记账用的执行实现
 * @param stdout 要回的标准输出
 * @returns 执行实现与它记下的调用
 */
function recorder(stdout = ""): { seen: Seen[]; run: KernelUpdateRunner } {
  const seen: Seen[] = []
  return {
    seen,
    run: (nodeExec, args, cwd, timeoutMs) => {
      seen.push({ nodeExec, args, cwd, timeoutMs })
      return Promise.resolve(stdout)
    }
  }
}

describe("isValidSpec", () => {
  it("dist-tag 与具体版本号都收", () => {
    expect(isValidSpec("latest")).toBe(true)
    expect(isValidSpec("0.6.1")).toBe(true)
    expect(isValidSpec("0.7.0-rc.1")).toBe(true)
  })

  it("**范围写法一律拒绝** —— `^` 在 cmd 里是转义符", () => {
    expect(isValidSpec("^0.6.0")).toBe(false)
    expect(isValidSpec("~0.6.0")).toBe(false)
    expect(isValidSpec(">=0.6.0")).toBe(false)
  })

  it("shell 元字符一律拒绝", () => {
    // 现在不经 shell 执行，但这道白名单仍是纵深防御：万一日后有人改回带 shell 的写法，
    // 这几个「一条命令悄悄变成两条」的入口不该因此洞开
    expect(isValidSpec("latest && rm -rf /")).toBe(false)
    expect(isValidSpec("latest > x")).toBe(false)
    expect(isValidSpec("latest | cat")).toBe(false)
    expect(isValidSpec("latest; echo")).toBe(false)
    expect(isValidSpec("$(echo latest)")).toBe(false)
    expect(isValidSpec("latest`echo`")).toBe(false)
  })

  it("空串与空白拒绝", () => {
    expect(isValidSpec("")).toBe(false)
    expect(isValidSpec(" ")).toBe(false)
    expect(isValidSpec("la test")).toBe(false)
  })

  it("首字符必须是字母或数字，不许以点或连字符开头", () => {
    // `-x` 会被当成一个新的命令行开关，`.` 开头则是相对路径
    expect(isValidSpec("-latest")).toBe(false)
    expect(isValidSpec(".latest")).toBe(false)
  })
})

describe("cliBinPath", () => {
  it("拼到安装目录下的 @yunzai-ng/cli 入口", () => {
    const bin = cliBinPath("/home/yz")
    // 用 includes 而非等值：路径分隔符随平台不同
    expect(bin).toContain("node_modules")
    expect(bin).toContain("cli")
    expect(bin).toContain("bin.js")
  })
})

describe("readCoreVersion", () => {
  /**
   * 造一个假安装目录
   * @param cliCoreDep cli 声明的 core 依赖；undefined 表示不建 cli/package.json
   * @param homeCore `<home>/node_modules/@yunzai-ng/core` 的版本；undefined 表示不建
   * @returns 目录路径
   */
  function makeHome(cliCoreDep: string | undefined, homeCore: string | undefined): string {
    const home = mkdtempSync(join(tmpdir(), "steward-kernel-"))
    if (cliCoreDep !== undefined) {
      const dir = join(home, "node_modules", "@yunzai-ng", "cli")
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, "package.json"), JSON.stringify({ dependencies: { "@yunzai-ng/core": cliCoreDep } }))
    }
    if (homeCore !== undefined) {
      const dir = join(home, "node_modules", "@yunzai-ng", "core")
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, "package.json"), JSON.stringify({ version: homeCore }))
    }
    return home
  }

  it("**读 cli 声明的 core 依赖，压过 home 顶层那个可能过期的 core**", () => {
    // 这正是踩过的坑：pnpm add cli@latest 后 home 的 core junction 还指向旧版，据它判会漏掉升级
    const home = makeHome("0.6.2", "0.6.1")
    try {
      expect(readCoreVersion(home)).toBe("0.6.2")
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it("没有 cli（嵌入式 / 全局装）时退回读 home 下的 core", () => {
    const home = makeHome(undefined, "0.6.1")
    try {
      expect(readCoreVersion(home)).toBe("0.6.1")
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it("cli 的 core 依赖不是精确版本（workspace:* 等）时也退回 home 下的 core", () => {
    const home = makeHome("workspace:*", "0.6.1")
    try {
      expect(readCoreVersion(home)).toBe("0.6.1")
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it("两处都读不到时 undefined", () => {
    const home = makeHome(undefined, undefined)
    try {
      expect(readCoreVersion(home)).toBeUndefined()
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })
})

describe("updateKernel", () => {
  it("用当前 node 跑 bin.js update --to <版本>，在安装目录里跑", async () => {
    const { seen, run } = recorder("done")
    await updateKernel({ home: "/home/yz", spec: "latest", timeoutMs: 1000, hasCli: cliPresent, run })
    expect(seen).toHaveLength(1)
    // 用当前进程的 node，不靠 PATH
    expect(seen[0]?.nodeExec).toBe(process.execPath)
    // 首参是 bin.js 的绝对路径，其后才是 CLI 参数
    expect(seen[0]?.args[0]).toBe(cliBinPath("/home/yz"))
    expect(seen[0]?.args.slice(1)).toEqual(["update", "--to", "latest"])
    expect(seen[0]?.cwd).toBe("/home/yz")
    expect(seen[0]?.timeoutMs).toBe(1000)
  })

  it("**没装 CLI 时压根不执行**，回一句可操作的说明 —— 顾及嵌入式部署", async () => {
    const { seen, run } = recorder()
    const result = await updateKernel({
      home: "/home/embed",
      spec: "latest",
      timeoutMs: 1000,
      hasCli: () => false,
      run
    })
    expect(seen).toEqual([])
    expect(result.ok).toBe(false)
    // 报错要指出「这不是 CLI 装的」并让人去手动升级，而不是一句 yzng 找不到
    expect(result.message).toContain("手动升级")
    // 断言实际的 bin 路径而非字面 "/home/embed"：join 在 Windows 上产反斜杠
    expect(result.message).toContain(cliBinPath("/home/embed"))
  })

  it("**版本号不合法时压根不执行** —— 这是那道白名单的实际作用", async () => {
    const { seen, run } = recorder()
    const result = await updateKernel({ home: "/home/yz", spec: "^0.6.0", timeoutMs: 1000, hasCli: cliPresent, run })
    expect(seen).toEqual([])
    expect(result.ok).toBe(false)
    // 报错里要写清「该怎么填」，否则使用者只知道自己填错了
    expect(result.message).toContain("dist-tag")
    expect(result.message).toContain("^0.6.0")
  })

  it("版本号不合法时先于 CLI 探测 —— 填错版本不该被「没装 CLI」盖过", async () => {
    // 两个早退的顺序：版本号在前。填错版本的人该看到「版本写错了」，而不是「没装 CLI」
    const result = await updateKernel({ home: "/home/yz", spec: "^0.6.0", timeoutMs: 1, hasCli: () => false })
    expect(result.message).toContain("^0.6.0")
  })

  it("**版本真的变了才 changed:true** —— 前后读到不同版本，报 旧 → 新", async () => {
    const { run } = recorder()
    const result = await updateKernel({
      home: "/h",
      spec: "latest",
      timeoutMs: 1,
      hasCli: cliPresent,
      readVersion: versions("0.6.0", "0.6.1"),
      run
    })
    expect(result).toEqual({
      ok: true,
      changed: true,
      message: "内核已升级：0.6.0 → 0.6.1",
      versionChange: "0.6.0 → 0.6.1"
    })
  })

  it("**已是最新时 changed:false** —— 前后版本相同，别白重启一次", async () => {
    const { run } = recorder()
    const result = await updateKernel({
      home: "/h",
      spec: "latest",
      timeoutMs: 1,
      hasCli: cliPresent,
      readVersion: unchanged("0.6.1"),
      run
    })
    expect(result.ok).toBe(true)
    expect(result.changed).toBe(false)
    // 报「已是最新」并带上版本号，而不是一句像更新过的话
    expect(result.message).toContain("已是最新")
    expect(result.message).toContain("0.6.1")
  })

  it("**读不到版本时 changed:false** —— 拿不准就不重启，宁可少停一次机", async () => {
    const { run } = recorder()
    const result = await updateKernel({
      home: "/h",
      spec: "latest",
      timeoutMs: 1,
      hasCli: cliPresent,
      readVersion: versions(undefined, undefined),
      run
    })
    expect(result.ok).toBe(true)
    expect(result.changed).toBe(false)
  })

  it("升级命令执行了但版本反而读不到 —— 仍算成功、不重启", async () => {
    const { run } = recorder()
    // 升级前读到、升级后读不到（例如链接暂时断了）：不能据此判定升过级
    const result = await updateKernel({
      home: "/h",
      spec: "latest",
      timeoutMs: 1,
      hasCli: cliPresent,
      readVersion: versions("0.6.0", undefined),
      run
    })
    expect(result).toMatchObject({ ok: true, changed: false })
  })

  it("失败时带上原因", async () => {
    const run: KernelUpdateRunner = () => Promise.reject(new Error("registry 连不上"))
    const result = await updateKernel({ home: "/h", spec: "latest", timeoutMs: 1, hasCli: cliPresent, run })
    expect(result.ok).toBe(false)
    expect(result.message).toContain("registry 连不上")
  })

  it("**超时与失败分开讲**：超时要说「装了一半」并指出去哪收拾", async () => {
    const run: KernelUpdateRunner = () => Promise.reject(new Error("Command timed out"))
    const result = await updateKernel({ home: "/home/yz", spec: "latest", timeoutMs: 1, hasCli: cliPresent, run })
    expect(result.ok).toBe(false)
    // 包管理器被打断时 node_modules 停在中间状态，一句干净的「超时」会让人以为无事发生
    expect(result.message).toContain("只装了一半")
    expect(result.message).toContain("/home/yz")
  })

  it("被 SIGTERM 打断也按超时讲 —— execFile 超时就是发这个信号", async () => {
    const run: KernelUpdateRunner = () => Promise.reject(new Error("terminated by SIGTERM"))
    const result = await updateKernel({ home: "/h", spec: "latest", timeoutMs: 1, hasCli: cliPresent, run })
    expect(result.message).toContain("只装了一半")
  })

  it("非 Error 被拒时也讲得出话，不出现 [object Object]", async () => {
    const run: KernelUpdateRunner = () => Promise.reject("字符串原因")
    const result = await updateKernel({ home: "/h", spec: "latest", timeoutMs: 1, hasCli: cliPresent, run })
    expect(result.ok).toBe(false)
    expect(result.message).toContain("字符串原因")
  })

  it("一律不抛错 —— 每种失败都要讲给群里的人听", async () => {
    const run: KernelUpdateRunner = () => Promise.reject(new Error("随便什么"))
    // 抛错会让调用点把一句技术错误原样抄进群里
    await expect(
      updateKernel({ home: "/h", spec: "latest", timeoutMs: 1, hasCli: cliPresent, run })
    ).resolves.toMatchObject({ ok: false })
  })
})
