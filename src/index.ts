/**
 * @dsh-external/dsh-token-ledger — 跨 API 提供商的全局累积 token 用量账本。
 *
 * 数据源（与官方 dsh-token-meter 完全同一契约，提供商无关）：
 *   - assistant/chunk(chunk.type==='usage') / assistant/message(data.usage) 的
 *     provider 实测 usage；同一 (turn,step) 的重复样本"替换不叠加"
 *     （流式 chunk 样本 → message 最终样本），llm/retry-started 关闭替换槽。
 *   - request/header 的 header.config.{provider,model} 决定路由归属。
 *
 * 覆盖范围：
 *   - 实时：ctx.on('session/event') 增量消费所有活跃会话；
 *   - 历史：启动时异步回填 ~/.dsh/sessions/**\/session.jsonl.zstd
 *     （拼接 zstd 帧容器，逐帧解压，seq 去重）——安装前产生的用量也会计入。
 *
 * 持久化：~/.dsh/token-ledger/ledger.json（tmp+rename 原子写，定时防抖）。
 * 去重权威：每会话 lastSeq（事件 seq 单调递增）——实时流与文件回填永不双计。
 * 失败自闭合：所有路径 try/catch，统计异常绝不影响会话主流程。
 * 回滚：dev_uninject_plugin("dsh-token-ledger") 一键卸净（fiber dispose 全部副作用）。
 */
import type { Context } from 'cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { zstdDecompressSync } from 'node:zlib'
export const name = '@dsh-external/dsh-token-ledger'
export const inject = ['timer', 'tools', 'webServer']

/** 全部可选；缺省自动定位 DSH_HOME。注意：lib/ 为当前维护的权威产物（本机无 bash/tsc 构建链），src 与其逻辑保持一致。 */
export interface Config {
  ledgerFile?: string
  sessionsRoot?: string
  flushMs?: number
  backfillOnStart?: boolean
}

// ═══════════════════════ 类型与桶操作 ═══════════════════════

interface Buckets {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}

interface BucketTotals extends Buckets {
  calls: number
}

interface SessionState {
  lastSeq: number
  fileOffset: number
  route: string
  last: { turn: number; step: number; buckets: Buckets } | null
}

interface Ledger {
  version: 1
  createdAt: number
  updatedAt: number
  totals: BucketTotals
  byRoute: Record<string, BucketTotals>
  byDay: Record<string, BucketTotals>
  sessions: Record<string, SessionState>
  backfill: { lastRun: number; files: number; events: number; errors: string[] }
}

const zeroBuckets = (): Buckets => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 })
const zeroTotals = (): BucketTotals => ({ ...zeroBuckets(), calls: 0 })
const totalOf = (b: Buckets): number => b.input + b.output + b.cacheRead + b.cacheWrite

function bucketsFromUsage(usage: any): Buckets {
  const n = (v: any): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0)
  return {
    input: n(usage?.inputTokens),
    output: n(usage?.outputTokens),
    cacheRead: n(usage?.cacheReadTokens),
    cacheWrite: n(usage?.cacheWriteTokens),
  }
}

function bucketsEqual(a: Buckets | null, b: Buckets): boolean {
  return !!a && a.input === b.input && a.output === b.output && a.cacheRead === b.cacheRead && a.cacheWrite === b.cacheWrite
}

function addDelta(dst: BucketTotals, delta: Buckets): void {
  dst.input += delta.input
  dst.output += delta.output
  dst.cacheRead += delta.cacheRead
  dst.cacheWrite += delta.cacheWrite
}

function dayKey(time: number): string {
  const d = new Date(time)
  const p = (v: number): string => String(v).padStart(2, '0')
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate())
}

function freshLedger(): Ledger {
  return {
    version: 1,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    totals: zeroTotals(),
    byRoute: {},
    byDay: {},
    sessions: {},
    backfill: { lastRun: 0, files: 0, events: 0, errors: [] },
  }
}

// ═══════════════════════ zstd 拼接帧扫描（移植自官方持久化包） ═══════════════════════

const ZSTD_MAGIC = 4247762216

interface FrameRange {
  start: number
  end: number
}

/** 从 fromOffset 起扫描完整帧；返回完整帧区间与残缺帧起点（无残缺为 undefined）。 */
function scanZstdFrames(buffer: Buffer, fromOffset = 0): { frames: FrameRange[]; tornStart?: number } {
  const frames: FrameRange[] = []
  let offset = fromOffset
  while (offset < buffer.length) {
    const start = offset
    if (buffer.length - offset < 4) return { frames, tornStart: start }
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) throw new Error('corrupt zstd log: bad magic at byte ' + offset)
    offset += 4
    if (offset === buffer.length) return { frames, tornStart: start }
    const descriptor = buffer.readUInt8(offset)
    offset += 1
    if ((descriptor & 24) !== 0) throw new Error('corrupt zstd log: reserved frame-header bit')
    const contentSizeFlag = descriptor >>> 6
    const singleSegment = (descriptor & 32) !== 0
    const checksum = (descriptor & 4) !== 0
    const dictionaryFlag = descriptor & 3
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag
    const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes
    if (buffer.length - offset < remainingHeaderBytes) return { frames, tornStart: start }
    offset += remainingHeaderBytes
    for (;;) {
      if (buffer.length - offset < 3) return { frames, tornStart: start }
      const blockHeader = buffer.readUIntLE(offset, 3)
      offset += 3
      const lastBlock = (blockHeader & 1) !== 0
      const blockType = (blockHeader >>> 1) & 3
      const blockSize = blockHeader >>> 3
      if (blockType === 3) throw new Error('corrupt zstd log: reserved block type')
      const payloadBytes = blockType === 1 ? 1 : blockSize
      if (buffer.length - offset < payloadBytes) return { frames, tornStart: start }
      offset += payloadBytes
      if (lastBlock) break
    }
    if (checksum) {
      if (buffer.length - offset < 4) return { frames, tornStart: start }
      offset += 4
    }
    frames.push({ start, end: offset })
  }
  return { frames }
}

// ═══════════════════════ 主逻辑 ═══════════════════════

export function apply(ctx: Context, config: Config = {}): void {
  const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh')
  const ledgerFile = config.ledgerFile || join(dshHome, 'token-ledger', 'ledger.json')
  const sessionsRoot = config.sessionsRoot || join(dshHome, 'sessions')
  const flushMs = Math.max(1000, Number(config.flushMs) || 5000)
  const log = (msg: string): void => {
    try {
      ctx.logger?.info?.('[dsh-token-ledger] ' + msg)
    } catch {
      /* 日志失败静默 */
    }
  }

  // ─── 账本加载 ───
  let ledger: Ledger = freshLedger()
  try {
    if (existsSync(ledgerFile)) {
      const parsed = JSON.parse(readFileSync(ledgerFile, 'utf8'))
      if (parsed && parsed.version === 1 && parsed.totals && parsed.sessions) ledger = parsed as Ledger
    }
  } catch (e) {
    log('账本读取失败，从空账本重新开始: ' + String(e).slice(0, 120))
  }

  let dirty = false
  const markDirty = (): void => {
    dirty = true
  }

  const flush = (): void => {
    if (!dirty) return
    dirty = false
    try {
      ledger.updatedAt = Date.now()
      mkdirSync(dirname(ledgerFile), { recursive: true })
      const tmp = ledgerFile + '.tmp'
      writeFileSync(tmp, JSON.stringify(ledger))
      renameSync(tmp, ledgerFile)
    } catch (e) {
      dirty = true // 写失败下轮重试
      log('账本写盘失败: ' + String(e).slice(0, 120))
    }
  }

  // ─── 折叠核心：实时流与文件回填共用（seq 去重是防双计的唯一权威） ───
  const processEvent = (sessionId: string, ev: any): void => {
    if (!ev || typeof ev.type !== 'string') return
    const st = (ledger.sessions[sessionId] ??= { lastSeq: -1, fileOffset: 0, route: 'unknown', last: null })
    if (typeof ev.seq === 'number') {
      if (ev.seq <= st.lastSeq) return
    }

    if (ev.type === 'request/header') {
      const c = ev.data?.header?.config
      if (c && typeof c.provider === 'string' && typeof c.model === 'string') {
        st.route = c.provider + '/' + c.model
        markDirty()
      }
    } else if (ev.type === 'llm/retry-started') {
      if (st.last && st.last.turn === ev.data?.turn && st.last.step === ev.data?.step) {
        st.last = null
        markDirty()
      }
    } else {
      let sample: { turn: number; step: number; usage: any } | null = null
      if (ev.type === 'assistant/chunk' && ev.data?.chunk?.type === 'usage') {
        sample = { turn: ev.data.turn, step: ev.data.step, usage: ev.data.chunk.usage }
      } else if (ev.type === 'assistant/message' && ev.data?.usage) {
        sample = { turn: ev.data.turn, step: ev.data.step, usage: ev.data.usage }
      }
      if (sample && typeof sample.turn === 'number' && typeof sample.step === 'number') {
        const buckets = bucketsFromUsage(sample.usage)
        const prev = st.last && st.last.turn === sample.turn && st.last.step === sample.step ? st.last.buckets : null
        if (!bucketsEqual(prev, buckets)) {
          const delta: Buckets = prev
            ? {
                input: buckets.input - prev.input,
                output: buckets.output - prev.output,
                cacheRead: buckets.cacheRead - prev.cacheRead,
                cacheWrite: buckets.cacheWrite - prev.cacheWrite,
              }
            : buckets
          if (!prev) {
            ledger.totals.calls += 1
            const rt0 = (ledger.byRoute[st.route] ??= zeroTotals())
            rt0.calls += 1
          }
          const rt = (ledger.byRoute[st.route] ??= zeroTotals())
          const dk = dayKey(typeof ev.time === 'number' ? ev.time : Date.now())
          const dt = (ledger.byDay[dk] ??= zeroTotals())
          addDelta(ledger.totals, delta)
          addDelta(rt, delta)
          addDelta(dt, delta)
          markDirty()
        }
        st.last = { turn: sample.turn, step: sample.step, buckets }
      }
    }
    if (typeof ev.seq === 'number') st.lastSeq = ev.seq
  }

  // ─── 实时：增量消费所有活跃会话 ───
  const liveCursors = new WeakMap<object, number>()
  ctx.on('session/event', (session: any) => {
    try {
      const events = session?.events
      if (!events || typeof events.length !== 'number') return
      const id = String(session.id ?? 'unknown')
      let i = liveCursors.get(session) ?? 0
      while (i < events.length) {
        processEvent(id, events[i])
        i += 1
      }
      liveCursors.set(session, i)
    } catch (e) {
      log('实时折叠异常（已隔离）: ' + String(e).slice(0, 120))
    }
  })

  // ─── 历史回填：拼接 zstd 帧 → JSONL，按 fileOffset 增量续扫 ───
  const backfillFile = (file: string, sessionId: string): number => {
    const st = (ledger.sessions[sessionId] ??= { lastSeq: -1, fileOffset: 0, route: 'unknown', last: null })
    const size = statSync(file).size
    let offset = st.fileOffset || 0
    if (offset > size) offset = 0 // 文件被重建（理论上 append-only，防御）
    if (offset === size) return 0
    const buf = readFileSync(file)
    let consumed = 0
    if (file.endsWith('.zstd')) {
      const { frames, tornStart } = scanZstdFrames(buf, offset)
      for (const f of frames) {
        let text: string
        try {
          text = zstdDecompressSync(buf.subarray(f.start, f.end)).toString('utf8')
        } catch {
          continue // 单帧损坏跳过，不阻断
        }
        for (const line of text.split('\n')) {
          if (!line) continue
          let ev: any
          try {
            ev = JSON.parse(line)
          } catch {
            continue
          }
          if (ev.type === 'session') continue
          processEvent(sessionId, ev)
          consumed += 1
        }
      }
      const lastEnd = frames.length > 0 ? frames[frames.length - 1].end : offset
      st.fileOffset = tornStart !== undefined && tornStart > lastEnd ? tornStart : lastEnd
      if (frames.length > 0) st.fileOffset = frames[frames.length - 1].end
    } else {
      const text = buf.subarray(offset).toString('utf8')
      for (const line of text.split('\n')) {
        if (!line) continue
        let ev: any
        try {
          ev = JSON.parse(line)
        } catch {
          continue
        }
        if (ev.type === 'session') continue
        processEvent(sessionId, ev)
        consumed += 1
      }
      st.fileOffset = size
    }
    markDirty()
    return consumed
  }

  const backfill = (): void => {
    const started = Date.now()
    let files = 0
    let events = 0
    const errors: string[] = []
    try {
      if (!existsSync(sessionsRoot)) return
      for (const wsEntry of readdirSync(sessionsRoot, { withFileTypes: true })) {
        if (!wsEntry.isDirectory()) continue
        const wsDir = join(sessionsRoot, wsEntry.name)
        let sessionDirs: import('node:fs').Dirent[]
        try {
          sessionDirs = readdirSync(wsDir, { withFileTypes: true })
        } catch {
          continue
        }
        for (const sEntry of sessionDirs) {
          if (!sEntry.isDirectory()) continue
          const sDir = join(wsDir, sEntry.name)
          const zstdFile = join(sDir, 'session.jsonl.zstd')
          const plainFile = join(sDir, 'session.jsonl')
          const file = existsSync(zstdFile) ? zstdFile : existsSync(plainFile) ? plainFile : null
          if (!file) continue
          try {
            const n = backfillFile(file, sEntry.name)
            if (n > 0) {
              files += 1
              events += n
            }
          } catch (e) {
            errors.push(sEntry.name + ': ' + String(e).slice(0, 80))
          }
        }
      }
    } finally {
      ledger.backfill = { lastRun: started, files, events, errors: errors.slice(0, 20) }
      markDirty()
      flush()
      log('回填完成: ' + files + ' 个文件, ' + events + ' 条事件, ' + errors.length + ' 个错误')
    }
  }

  if (config.backfillOnStart !== false) {
    // 异步让出主流程，激活不被回填阻塞
    setTimeout(() => {
      try {
        backfill()
      } catch (e) {
        log('回填异常（已隔离）: ' + String(e).slice(0, 120))
      }
    }, 3000)
  }

  // ─── 定时防抖写盘（timer 服务的 setInterval 注册在当前 fiber，卸载即净） ───
  ;(ctx as any).setInterval(() => {
    try {
      flush()
    } catch {
      /* 静默 */
    }
  }, flushMs)
  ctx.effect(
    () => () => {
      try {
        dirty = true
        flush()
      } catch {
        /* 静默 */
      }
    },
    '@dsh-external/dsh-token-ledger: final flush',
  )

  // ─── 汇总与格式化 ───
  const fmt = (n: number): string => {
    if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M'
    if (n >= 1e3) return (n / 1e3).toFixed(1) + 'k'
    return String(Math.round(n))
  }
  const summary = (): any => {
    const routes = Object.entries(ledger.byRoute)
      .map(([route, t]) => ({ route, ...t, total: totalOf(t) }))
      .sort((a, b) => b.total - a.total)
    const days = Object.entries(ledger.byDay)
      .map(([day, t]) => ({ day, ...t, total: totalOf(t) }))
      .sort((a, b) => (a.day < b.day ? 1 : -1))
    return {
      since: new Date(ledger.createdAt).toISOString(),
      updatedAt: new Date(ledger.updatedAt).toISOString(),
      grandTotal: totalOf(ledger.totals),
      totals: { ...ledger.totals, total: totalOf(ledger.totals) },
      routes,
      recentDays: days.slice(0, 14),
      trackedSessions: Object.keys(ledger.sessions).length,
      backfill: ledger.backfill,
    }
  }

  // ─── 模型工具：token_ledger_stats ───
  ctx.effect(
    () =>
      ctx.tools.register(
        defineTool({
          name: 'token_ledger_stats',
          description:
            '查看全局累积 token 用量账本：跨所有 API 提供商/模型的累计输入/输出/缓存 token、按路由与按日分布、回填状态。数据来自 provider 实测 usage，与具体 API 接入无关。',
          parameters: {},
          output: {
            schema: { type: 'string' },
            render: (_args: unknown, value: unknown) => [{ type: 'text', text: String(value) }],
          },
          async execute() {
            try {
              // 查询前先把活跃会话尾巴消费掉，尽量实时
              backfillQuiet()
              const s = summary()
              const lines: string[] = []
              lines.push('📊 全局 token 累积账本（自 ' + s.since.slice(0, 10) + ' 起）')
              lines.push(
                '总计: ' +
                  fmt(s.grandTotal) +
                  ' tokens = 输入 ' +
                  fmt(s.totals.input) +
                  ' + 输出 ' +
                  fmt(s.totals.output) +
                  ' + 缓存读 ' +
                  fmt(s.totals.cacheRead) +
                  ' + 缓存写 ' +
                  fmt(s.totals.cacheWrite) +
                  '（计费调用 ' +
                  s.totals.calls +
                  ' 次）',
              )
              lines.push('—— 按路由（provider/model）——')
              for (const r of s.routes.slice(0, 10)) {
                lines.push(
                  '  ' + r.route + ': ' + fmt(r.total) + '（入 ' + fmt(r.input) + ' / 出 ' + fmt(r.output) + ' / 缓存 ' + fmt(r.cacheRead + r.cacheWrite) + '，' + r.calls + ' 次）',
                )
              }
              lines.push('—— 近 14 天 ——')
              for (const d of s.recentDays) {
                lines.push('  ' + d.day + ': ' + fmt(d.total))
              }
              lines.push('跟踪会话 ' + s.trackedSessions + ' 个；回填 ' + s.backfill.files + ' 文件 / ' + s.backfill.events + ' 事件 / ' + s.backfill.errors.length + ' 错误')
              return lines.join('\n')
            } catch (e) {
              return 'token_ledger_stats 查询失败: ' + String(e).slice(0, 200)
            }
          },
        }),
      ),
    '@dsh-external/dsh-token-ledger: stats tool',
  )

  /** 静默增量回填（工具查询前调用；只扫有变化的文件） */
  const backfillQuiet = (): void => {
    try {
      backfill()
    } catch {
      /* 静默 */
    }
  }

  // ─── webServer API（client 面板消费） ───
  ctx.effect(
    () =>
      (ctx as any).webServer.register({
        kind: 'prefix',
        path: '/@dsh-external/dsh-token-ledger/api',
        handler: async (_req: any, res: any) => {
          try {
            backfillQuiet()
            res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
            res.end(JSON.stringify(summary()))
          } catch (e) {
            res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' })
            res.end(JSON.stringify({ error: String(e).slice(0, 200) }))
          }
        },
      }),
    '@dsh-external/dsh-token-ledger: api',
  )

  log('已启动：账本 ' + ledgerFile + '，会话根 ' + sessionsRoot)
}
