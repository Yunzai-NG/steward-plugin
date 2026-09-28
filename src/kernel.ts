/**
 * 模块职责：升内核 —— 代跑一次 yzng CLI 的 `update`，并把它的结果讲成一句话
 * 依赖方向：依赖 node:child_process / node:fs / node:path 与类型；不认识 ctx
 * 生命周期：纯函数，一次命令一次
 * 注意事项：**不自己重写升级逻辑，代跑 CLI 的 `update`。** 那条命令里攒着一串只有踩过才知道的
 *          判断：只升 `@yunzai-ng/cli` 一个包（core / types / jsx 由它的精确依赖带上来，逐个升
 *          反而会装出四个互不匹配的版本）、升级后剪掉根 `package.json` 里多余的框架依赖（单列
 *          且锁死时会与 cli 的精确依赖冲突，装出两份 core，表现为「代码里报错、运行时正常」）、
 *          升完不在本进程内重建链接（那时解析到的仍是旧目录）。在插件里重写一遍，等于把那串
 *          判断抄第二份，而抄漏哪一条都表现为「升级过了却没生效」。
 *
 *          **不靠 PATH 找 `yzng`，直接用当前 node 跑 CLI 的入口 `bin.js`。** 这是踩过的坑：
 *          `yzng` 命令只由包管理器写进**安装目录本地**的 `node_modules/.bin`，并不在 PATH 上；
 *          而 Windows 的 cmd 不会自动去 `cwd/node_modules/.bin` 找命令。于是靠 PATH 调 `yzng`
 *          在 pm2 / systemd 一类干净环境下必然报「不是内部或外部命令」。改用 `process.execPath`
 *          （当前正在跑的 node 的绝对路径，一定存在、不依赖 PATH）去跑 `bin.js`，既绕开这个坑，
 *          也不再需要 shell —— 参数不经 shell 解释，注入面随之消失。
 *
 *          **考虑不用 CLI 的部署。** 把 `@yunzai-ng/core` 嵌进自己程序、自管 node_modules 的用户
 *          可能压根没装 `@yunzai-ng/cli`，`bin.js` 不存在。此时指令更新内核从根上就做不到，故先
 *          探测 `bin.js` 在不在：不在就回一句「这台实例不是 yzng CLI 装的，请按你的部署方式手动
 *          升级」，而不是硬跑一条注定失败的命令、再把一句看不懂的错抄进群里。
 *
 *          **超时后只能报「装了一半」，不能假装失败即无事发生。** 包管理器被打断时
 *          `node_modules` 停在中间状态，此时最有用的一句话是「去手动升级收拾」，而非一句干净的
 *          「超时」。
 */
import { execFile } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import process from "node:process"

/** 合法的版本说明符：dist-tag 或具体版本号，**不含范围符号** */
const SPEC_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/

/** CLI 入口相对安装目录的路径 */
const CLI_BIN_REL = join("node_modules", "@yunzai-ng", "cli", "dist", "bin.js")

/** CLI 的 package.json 相对安装目录的路径 */
const CLI_PKG_REL = join("node_modules", "@yunzai-ng", "cli", "package.json")

/** core 的 package.json 相对安装目录的路径 */
const CORE_PKG_REL = join("node_modules", "@yunzai-ng", "core", "package.json")

/**
 * 读某个 package.json 的 `version`
 * @param file package.json 的绝对路径
 * @returns 版本号；读不到或不是合法 JSON 时 undefined
 */
function readPkgVersion(file: string): string | undefined {
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as { version?: unknown }
    const version = parsed.version
    return typeof version === "string" && version !== "" ? version : undefined
  } catch {
    return undefined
  }
}

/**
 * 读 CLI 声明的 `@yunzai-ng/core` 精确依赖
 * @param home 安装目录
 * @returns 版本号；读不到、非精确版本（如 `workspace:*`）时 undefined
 */
function readCliCoreDep(home: string): string | undefined {
  try {
    const parsed = JSON.parse(readFileSync(join(home, CLI_PKG_REL), "utf8")) as {
      dependencies?: Record<string, unknown>
    }
    const dep = parsed.dependencies?.["@yunzai-ng/core"]
    if (typeof dep !== "string") return undefined
    // 发布时是精确版本；防御性地剥掉可能的范围前缀，非数字打头（`workspace:*` 等）则弃用
    const v = dep.replace(/^[\^~>=<\s]+/, "").trim()
    return /^\d/.test(v) ? v : undefined
  } catch {
    return undefined
  }
}

/**
 * 读「重启后会加载的那一版 core」的版本
 *
 * **读 CLI 声明的 core 精确依赖，而不是 `<home>/node_modules/@yunzai-ng/core` 那个 junction。**
 * 这是踩过的坑：那个 junction 由 `linkFramework` 在 `yzng start` 时建，`pnpm add cli@latest`
 * 只更新 `.pnpm` 与 cli 的链接、**不动它** —— 升级后到下次启动前它一直指向旧 core。据它判会把
 * 「已升级、就差重启」误判成「版本未变」，于是跳过那次本该做的重启，新内核永远起不来。
 * CLI 对 core 是钉死版本号的精确依赖（见发布流水线），故它声明的正是重启后会加载的那一版，
 * 且 pnpm 会可靠地更新 cli 的链接。
 *
 * 兜底：嵌入式 / 全局安装等 CLI 不在安装目录里时，退回读 `<home>` 下的 core。读不到时 undefined ——
 * 由调用方按「拿不准变没变」处理，而不是编一个版本号。
 * @param home 安装目录（`ctx.app.paths.home`）
 * @returns 版本号；读不到时 undefined
 */
export function readCoreVersion(home: string): string | undefined {
  return readCliCoreDep(home) ?? readPkgVersion(join(home, CORE_PKG_REL))
}

/**
 * 执行一次内核升级的函数形态
 *
 * 抽成类型是为了让测试替换它。这条路的正确性几乎全在**下发了什么** —— node 路径、bin.js 路径、
 * 参数、工作目录、超时；而真去跑一次升级既慢又会改动本机。
 * @param nodeExec 当前 node 可执行文件的绝对路径
 * @param args 实参（首个为 bin.js 路径，其后为 CLI 参数）
 * @param cwd 安装目录
 * @param timeoutMs 超时毫秒
 * @returns 标准输出
 */
export type KernelUpdateRunner = (
  nodeExec: string,
  args: readonly string[],
  cwd: string,
  timeoutMs: number
) => Promise<string>

/** 一次内核升级的结果 */
export interface KernelUpdateResult {
  /** 是否成功 */
  readonly ok: boolean
  /**
   * 内核版本是否真的变了
   *
   * 只有它为真才值得重启：已是最新时升级命令照样成功返回，但进程里跑的还是同一份代码，
   * 重启纯属白停一次机。拿不准（版本读不到）时取 false，宁可不重启也不惊扰一次。
   */
  readonly changed: boolean
  /** 版本变化，如 `0.6.1 → 0.6.2`；仅 `changed` 为真时有，供重启回执引用 */
  readonly versionChange?: string
  /** 讲给使用者的那句话 */
  readonly message: string
}

/**
 * 校验版本说明符
 *
 * 分出这个函数是为了让「什么样的版本号是允许的」可以被单独断言 —— 那是这条路上唯一的
 * 注入面，而它错了不会报错，只会让一条命令悄悄变成另一条。
 * @param spec 使用者配置的目标版本
 * @returns 是否合法
 */
export function isValidSpec(spec: string): boolean {
  return SPEC_RE.test(spec)
}

/**
 * 取安装目录里 CLI 入口的绝对路径
 * @param home 安装目录（`ctx.app.paths.home`）
 * @returns bin.js 的绝对路径
 */
export function cliBinPath(home: string): string {
  return join(home, CLI_BIN_REL)
}

/**
 * 真正去跑一次 CLI 的 `update`
 *
 * 用 `process.execPath` 跑 `bin.js`：不依赖 PATH、不需要 shell（见文件头第 2 条）。
 * @param nodeExec 当前 node 可执行文件的绝对路径
 * @param args 实参（首个为 bin.js 路径）
 * @param cwd 安装目录
 * @param timeoutMs 超时毫秒
 * @returns 标准输出
 */
const realRunner: KernelUpdateRunner = (nodeExec, args, cwd, timeoutMs) =>
  new Promise((resolve, reject) => {
    execFile(
      nodeExec,
      [...args],
      {
        cwd,
        timeout: timeoutMs,
        // 升级过程的输出可能很长（包管理器会逐包报告），给足缓冲免得被截断
        maxBuffer: 16 * 1024 * 1024,
        env: process.env
      },
      (err, stdout, stderr) => {
        if (err === null) {
          resolve(stdout)
          return
        }
        // 包管理器把进度写 stderr、把结果写 stdout，出错时两边都可能有线索
        const detail = [stderr, stdout].map(one => one.trim()).filter(one => one !== "")[0] ?? err.message
        reject(new Error(detail))
      }
    )
  })

/** 升内核所需的参数 */
export interface KernelUpdateOptions {
  /** 安装目录（`ctx.app.paths.home`） */
  readonly home: string
  /** 目标版本或 dist-tag */
  readonly spec: string
  /** 超时毫秒 */
  readonly timeoutMs: number
  /** CLI 入口是否存在的判定；缺省真去看磁盘，测试时替换 */
  readonly hasCli?: (home: string) => boolean
  /** 读 core 当前版本；缺省真去读磁盘，测试时替换 */
  readonly readVersion?: (home: string) => string | undefined
  /** 执行实现；缺省真去跑，测试时替换 */
  readonly run?: KernelUpdateRunner
}

/**
 * 升一次内核
 *
 * **不抛错，一律回一个带话的结果。** 这条路的每一种失败都要讲给群里的人听，而抛错会让
 * 调用点把一句技术错误原样抄过去。
 * @param opts 参数
 * @returns 结果与说明
 */
export async function updateKernel(opts: KernelUpdateOptions): Promise<KernelUpdateResult> {
  if (!isValidSpec(opts.spec)) {
    return {
      ok: false,
      changed: false,
      message:
        `目标版本「${opts.spec}」不是合法的写法。只能填 dist-tag（latest）或具体版本号（0.6.1），` +
        `不收 ^0.6.0 这类范围 —— 那些符号在命令行里另有含义`
    }
  }

  const hasCli = opts.hasCli ?? existsSync
  const bin = cliBinPath(opts.home)
  // 非 CLI 部署（嵌入式、自管 node_modules）上 bin.js 不存在，见文件头第 3 条
  if (!hasCli(bin)) {
    return {
      ok: false,
      changed: false,
      message:
        `这台实例不是用 yzng CLI 装的（找不到 ${bin}），指令更新内核不可用。` +
        `请按你的部署方式手动升级 @yunzai-ng/core 及相关包，再重启`
    }
  }

  const readVersion = opts.readVersion ?? readCoreVersion
  const run = opts.run ?? realRunner
  // 升级前后各读一次 core 版本，据此判「到底变没变」——「已是最新」时 update 照样成功返回，
  // 光看 ok 会白重启一次
  const before = readVersion(opts.home)
  try {
    await run(process.execPath, [bin, "update", "--to", opts.spec], opts.home, opts.timeoutMs)
    const after = readVersion(opts.home)
    // 两次都读到、且不同才算变了；有一次读不到就当「拿不准」，取 false 宁可不重启
    const changed = before !== undefined && after !== undefined && before !== after
    if (changed) {
      const versionChange = `${before} → ${after}`
      return { ok: true, changed: true, versionChange, message: `内核已升级：${versionChange}` }
    }
    // 版本没变（已是最新），或读不到版本无从判断，都不值得重启
    return {
      ok: true,
      changed: false,
      message: after === undefined ? "内核升级命令已执行" : `内核已是最新（${after}）`
    }
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    // 超时与失败分开讲，见文件头第 4 条
    const timedOut = /timed? ?out|ETIMEDOUT|SIGTERM/i.test(reason)
    return {
      ok: false,
      changed: false,
      message: timedOut
        ? `内核升级超时，依赖可能只装了一半。请到 ${opts.home} 手动跑一次升级收拾`
        : `内核升级失败：${reason}`
    }
  }
}
