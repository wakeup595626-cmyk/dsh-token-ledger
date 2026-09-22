/**
 * @dsh-external/dsh-token-ledger — 跨 API 提供商的全局累积 token 用量账本。
 *
 * 数据源（与官方 dsh-token-meter 同一契约，提供商无关）：
 *   - assistant/chunk(chunk.type==='usage') / assistant/message(data.usage) 的
 *     provider 实测 usage；同一 (turn,step) 的重复样本"替换不叠加"
 *     （流式 chunk 样本 → message 最终样本），llm/retry-started 关闭替换槽。
 *   - request/header 的 header.config.{provider,model} 决定路由归属。
 *
 * 覆盖范围：
 *   - 实时：ctx.on('session/event') 增量消费所有活跃会话；
 *   - 历史：启动时异步回填 sessions 根下所有 session.jsonl.zstd
 *     （拼接 zstd 帧容器，逐帧解压，seq 去重）——安装前产生的用量也计入。
 *
 * 持久化：~/.dsh/token-ledger/ledger.json（tmp+rename 原子写，定时防抖）。
 * 去重权威：每会话 lastSeq（事件 seq 单调递增）——实时流与文件回填永不双计。
 * 失败自闭合：所有路径 try/catch，统计异常绝不影响会话主流程。
 * 回滚：dev_uninject_plugin("dsh-token-ledger") 一键卸净（fiber dispose 全部副作用）。
 */
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

// ═══════════════════════ 桶操作 ═══════════════════════

const zeroBuckets = () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 })
const zeroTotals = () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, calls: 0 })
const totalOf = (b) => b.input + b.output + b.cacheRead + b.cacheWrite

function bucketsFromUsage(usage) {
  const n = (v) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0)
  return {
    input: n(usage?.inputTokens),
    output: n(usage?.outputTokens),
    cacheRead: n(usage?.cacheReadTokens),
    cacheWrite: n(usage?.cacheWriteTokens),
  }
}

function bucketsEqual(a, b) {
  return !!a && a.input === b.input && a.output === b.output && a.cacheRead === b.cacheRead && a.cacheWrite === b.cacheWrite
}

function addDelta(dst, delta) {
  dst.input += delta.input
  dst.output += delta.output
  dst.cacheRead += delta.cacheRead
  dst.cacheWrite += delta.cacheWrite
}

/** 反向扣除：日志来源迁移时撤销该会话此前的贡献，避免重扫导致重复计入。 */
function subTotals(dst, src) {
  dst.input -= src.input
  dst.output -= src.output
  dst.cacheRead -= src.cacheRead
  dst.cacheWrite -= src.cacheWrite
  dst.calls -= src.calls
}

function isZeroTotals(t) {
  return t.input === 0 && t.output === 0 && t.cacheRead === 0 && t.cacheWrite === 0 && t.calls === 0
}

/**
 * 会话水位。src 标记水位来自哪一套日志格式：
 *  - 'v2' = DSH ≤ 0.1.4 的 session.jsonl.zstd，seq 是全局累加计数器（可达十几万）
 *  - 'v3' = DSH ≥ 0.1.5 的 session.v3.jsonl.zstd，seq 是日志下标（从 1 开始）
 * 两套序号空间互不兼容：混用会让新日志的事件全部被误判为「已处理」而丢弃。
 */
function newSessionState() {
  return { lastSeq: -1, fileOffset: 0, route: 'unknown', last: null, src: null, contrib: {} }
}

function dayKey(time) {
  const d = new Date(time)
  const p = (v) => String(v).padStart(2, '0')
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate())
}

function freshLedger() {
  return {
    version: 3,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    totals: zeroTotals(),
    byRoute: {},
    byDay: {},
    byDayRoute: {},
    sessions: {},
    backfill: { lastRun: 0, files: 0, events: 0, errors: [] },
  }
}

/**
 * v1/v2 → v3：全量重建——保留会话清单与创建时间，总量与全部水位归零后重扫。
 * v2→v3 必须重建而不能沿用旧水位：DSH 0.1.5 起日志改名 session.v3.jsonl.zstd，
 * seq 也从全局计数器换成日志下标，旧水位会让新日志的事件全部被去重丢弃。
 */
function migrateLedger(old) {
  const l = freshLedger()
  l.createdAt = typeof old?.createdAt === 'number' ? old.createdAt : Date.now()
  for (const id of Object.keys(old?.sessions || {})) {
    l.sessions[id] = newSessionState()
  }
  return l
}

// ═══════════════════════ zstd 拼接帧扫描（移植自官方持久化包） ═══════════════════════

const ZSTD_MAGIC = 4247762216

/** 从 fromOffset 起扫描完整帧；返回完整帧区间与残缺帧起点（无残缺为 undefined）。 */
function scanZstdFrames(buffer, fromOffset = 0) {
  const frames = []
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

export function apply(ctx, config = {}) {
  const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh')
  const ledgerFile = config.ledgerFile || join(dshHome, 'token-ledger', 'ledger.json')
  const sessionsRoot = config.sessionsRoot || join(dshHome, 'sessions')
  const flushMs = Math.max(1000, Number(config.flushMs) || 5000)
  const log = (msg) => {
    try {
      ctx.logger?.info?.('[dsh-token-ledger] ' + msg)
    } catch {
      /* 日志失败静默 */
    }
  }

  // ─── 账本加载 ───
  let ledger = freshLedger()
  try {
    if (existsSync(ledgerFile)) {
      const parsed = JSON.parse(readFileSync(ledgerFile, 'utf8'))
      if (parsed && parsed.totals && parsed.sessions) {
        ledger = parsed.version === 3 && parsed.byDayRoute ? parsed : migrateLedger(parsed)
      }
    }
  } catch (e) {
    log('账本读取失败，从空账本重新开始: ' + String(e).slice(0, 120))
  }

  let dirty = false
  const markDirty = () => {
    dirty = true
  }

  const flush = () => {
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

  // ─── 日志来源切换（DSH 0.1.5：session.jsonl.zstd → session.v3.jsonl.zstd） ───
  // v3 文件是会话历史的全量重编码，同一批 (turn,step) 会再出现一次；切换来源时
  // 必须先撤销该会话的旧贡献再从新来源重扫，否则整段历史会被重复计入。
  const ensureSource = (st, tag) => {
    if (st.src === tag) return
    const contrib = st.contrib || {}
    const days = new Set()
    for (const key of Object.keys(contrib)) {
      const c = contrib[key]
      const day = key.slice(0, 10)
      const route = key.slice(11)
      days.add(day)
      subTotals(ledger.totals, c)
      const dt = ledger.byDay[day]
      if (dt) subTotals(dt, c)
      const rt = ledger.byRoute[route]
      if (rt) subTotals(rt, c)
      const dayRoutes = ledger.byDayRoute[day]
      const drt = dayRoutes && dayRoutes[route]
      if (drt) subTotals(drt, c)
    }
    // 清理被减到全零的残留项，避免面板出现 0 值路由/日期
    for (const day of days) {
      const dt = ledger.byDay[day]
      if (dt && isZeroTotals(dt)) delete ledger.byDay[day]
      const dayRoutes = ledger.byDayRoute[day]
      if (dayRoutes) {
        for (const route of Object.keys(dayRoutes)) {
          if (isZeroTotals(dayRoutes[route])) delete dayRoutes[route]
        }
        if (Object.keys(dayRoutes).length === 0) delete ledger.byDayRoute[day]
      }
    }
    for (const route of Object.keys(ledger.byRoute)) {
      if (isZeroTotals(ledger.byRoute[route])) delete ledger.byRoute[route]
    }
    st.contrib = {}
    st.src = tag
    st.lastSeq = -1
    st.fileOffset = 0
    st.last = null
    markDirty()
  }

  // ─── 折叠核心：实时流与文件回填共用（seq 去重是防双计的唯一权威） ───
  const processEvent = (sessionId, ev, tag) => {
    if (!ev || typeof ev.type !== 'string') return
    const st = (ledger.sessions[sessionId] ??= newSessionState())
    ensureSource(st, tag || 'v2')
    if (typeof ev.seq === 'number' && ev.seq <= st.lastSeq) return

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
      let sample = null
      if (ev.type === 'assistant/chunk' && ev.data?.chunk?.type === 'usage') {
        sample = { turn: ev.data.turn, step: ev.data.step, usage: ev.data.chunk.usage }
      } else if (ev.type === 'assistant/message' && ev.data?.usage) {
        sample = { turn: ev.data.turn, step: ev.data.step, usage: ev.data.usage }
      }
      if (sample && typeof sample.turn === 'number' && typeof sample.step === 'number') {
        const buckets = bucketsFromUsage(sample.usage)
        const prev = st.last && st.last.turn === sample.turn && st.last.step === sample.step ? st.last.buckets : null
        if (!bucketsEqual(prev, buckets) && !isIgnoredRoute(st.route)) {
          const delta = prev
            ? {
                input: buckets.input - prev.input,
                output: buckets.output - prev.output,
                cacheRead: buckets.cacheRead - prev.cacheRead,
                cacheWrite: buckets.cacheWrite - prev.cacheWrite,
              }
            : buckets
          const rt = (ledger.byRoute[st.route] ??= zeroTotals())
          const dk = dayKey(typeof ev.time === 'number' ? ev.time : Date.now())
          const dt = (ledger.byDay[dk] ??= zeroTotals())
          const drb = ((ledger.byDayRoute[dk] ??= {})[st.route] ??= zeroTotals())
          // 逐会话记录贡献明细：来源迁移时按 (日期|路由) 精确撤销，重扫不会重复计入
          const cb = ((st.contrib ??= {})[dk + '|' + st.route] ??= zeroTotals())
          if (!prev) {
            ledger.totals.calls += 1
            rt.calls += 1
            dt.calls += 1
            drb.calls += 1
            cb.calls += 1
          }
          addDelta(ledger.totals, delta)
          addDelta(rt, delta)
          addDelta(dt, delta)
          addDelta(drb, delta)
          addDelta(cb, delta)
          markDirty()
        }
        st.last = { turn: sample.turn, step: sample.step, buckets }
      }
    }
    if (typeof ev.seq === 'number') st.lastSeq = ev.seq
  }

  // ─── 实时：增量消费所有活跃会话 ───
  // DSH 0.1.5 起 Session 不再暴露 .events，改用公开方法 snapshotEvents()（冻结的全量日志）；
  // 旧版回退到 .events。两者序号空间不同，用 tag 隔离水位。
  const liveCursors = new WeakMap()
  ctx.on('session/event', (session) => {
    try {
      let events = null
      let tag = 'v3'
      if (session && typeof session.snapshotEvents === 'function') {
        try {
          events = session.snapshotEvents()
        } catch {
          events = null
        }
      }
      if (!events || typeof events.length !== 'number') {
        events = session?.events
        tag = 'v2'
      }
      if (!events || typeof events.length !== 'number') return
      const id = String(session.id ?? 'unknown')
      const st = (ledger.sessions[id] ??= newSessionState())
      if (st.src !== tag) liveCursors.set(session, 0) // 来源切换：从新来源的 0 号事件重扫
      let i = liveCursors.get(session) ?? 0
      while (i < events.length) {
        processEvent(id, events[i], tag)
        i += 1
      }
      liveCursors.set(session, i)
    } catch (e) {
      log('实时折叠异常（已隔离）: ' + String(e).slice(0, 120))
    }
  })

  // ─── 历史回填：拼接 zstd 帧 → JSONL，按 fileOffset 增量续扫 ───
  const backfillFile = (file, sessionId, tag) => {
    const st = (ledger.sessions[sessionId] ??= newSessionState())
    ensureSource(st, tag)
    const size = statSync(file).size
    let offset = st.fileOffset || 0
    if (offset > size) offset = 0 // 文件被重建（理论上 append-only，防御）
    if (offset === size) return 0
    const buf = readFileSync(file)
    let consumed = 0
    if (file.endsWith('.zstd')) {
      const { frames } = scanZstdFrames(buf, offset)
      for (const f of frames) {
        let text
        try {
          text = zstdDecompressSync(buf.subarray(f.start, f.end)).toString('utf8')
        } catch {
          continue // 单帧损坏跳过，不阻断
        }
        for (const line of text.split('\n')) {
          if (!line) continue
          let ev
          try {
            ev = JSON.parse(line)
          } catch {
            continue
          }
          if (ev.type === 'session') continue
          processEvent(sessionId, ev, tag)
          consumed += 1
        }
      }
      if (frames.length > 0) st.fileOffset = frames[frames.length - 1].end
    } else {
      const text = buf.subarray(offset).toString('utf8')
      for (const line of text.split('\n')) {
        if (!line) continue
        let ev
        try {
          ev = JSON.parse(line)
        } catch {
          continue
        }
        if (ev.type === 'session') continue
        processEvent(sessionId, ev, tag)
        consumed += 1
      }
      st.fileOffset = size
    }
    markDirty()
    return consumed
  }

  const backfill = () => {
    const started = Date.now()
    let files = 0
    let events = 0
    const errors = []
    try {
      if (!existsSync(sessionsRoot)) return
      for (const wsEntry of readdirSync(sessionsRoot, { withFileTypes: true })) {
        if (!wsEntry.isDirectory()) continue
        const wsDir = join(sessionsRoot, wsEntry.name)
        let sessionDirs
        try {
          sessionDirs = readdirSync(wsDir, { withFileTypes: true })
        } catch {
          continue
        }
        for (const sEntry of sessionDirs) {
          if (!sEntry.isDirectory()) continue
          const sDir = join(wsDir, sEntry.name)
          // 优先 v3：DSH ≥ 0.1.5 的 session.v3.jsonl.zstd 是会话历史的全量重编码，
          // 完整取代旧 session.jsonl.zstd（旧文件此后不再被写入）。
          const v3File = join(sDir, 'session.v3.jsonl.zstd')
          const zstdFile = join(sDir, 'session.jsonl.zstd')
          const plainFile = join(sDir, 'session.jsonl')
          const file = existsSync(v3File) ? v3File : existsSync(zstdFile) ? zstdFile : existsSync(plainFile) ? plainFile : null
          if (!file) continue
          const tag = file === v3File ? 'v3' : 'v2'
          try {
            const n = backfillFile(file, sEntry.name, tag)
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

  // ─── 定时防抖写盘（timer 服务注册在当前 fiber，卸载即净） ───
  ctx.setInterval(() => {
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

  // ─── 提供方自定义显示名（只读 settings.yaml 的 displayName；绝不读 credentials） ───
  // 永久名字簿：见过的 displayName 全部落盘（provider-names.json）——删除账号后
  // 历史数据仍显示自定义名，绝不回落裸 provider id；settings 里现存账号以 settings 为准。
  const settingsFile = join(dshHome, 'settings.yaml')
  const namesFile = join(dshHome, 'token-ledger', 'provider-names.json')
  let nameMapCache = { mtimeMs: 0, namesMtimeMs: 0, map: {} }
  let persistedNames = null
  let persistedNamesMtimeMs = 0
  const namesFileMtime = () => {
    try { return existsSync(namesFile) ? statSync(namesFile).mtimeMs : 0 } catch { return 0 }
  }
  const loadPersistedNames = () => {
    const mt = namesFileMtime()
    if (persistedNames && mt === persistedNamesMtimeMs) return persistedNames
    persistedNames = {}
    try {
      if (mt > 0) {
        const parsed = JSON.parse(readFileSync(namesFile, 'utf8'))
        if (parsed && typeof parsed === 'object') Object.assign(persistedNames, parsed)
      }
    } catch {}
    persistedNamesMtimeMs = mt
    return persistedNames
  }
  const persistNames = () => {
    try {
      mkdirSync(dirname(namesFile), { recursive: true })
      const tmp = namesFile + '.tmp'
      writeFileSync(tmp, JSON.stringify(persistedNames, null, 2))
      renameSync(tmp, namesFile)
    } catch {}
  }
  const loadProviderNames = () => {
    const mergeWithPersisted = (liveMap) => {
      const cache = loadPersistedNames()
      let changed = false
      for (const [k, v] of Object.entries(liveMap)) {
        if (cache[k] !== v) { cache[k] = v; changed = true }
      }
      if (changed) persistNames()
      return { ...cache, ...liveMap }
    }
    try {
      const st = statSync(settingsFile)
      const nmt = namesFileMtime()
      if (st.mtimeMs === nameMapCache.mtimeMs && nmt === nameMapCache.namesMtimeMs) return nameMapCache.map
      const lines = readFileSync(settingsFile, 'utf8').split('\n')
      const liveMap = {}
      let inPi = false
      let inProviders = false
      let current = null
      for (const raw of lines) {
        const line = raw.replace(/\r$/, '')
        if (/^\S/.test(line)) {
          inPi = /^llm-pi-ai:\s*$/.test(line)
          inProviders = false
          current = null
          continue
        }
        if (!inPi) continue
        if (/^ {2}providers:\s*$/.test(line)) {
          inProviders = true
          continue
        }
        if (/^ {2}\S/.test(line)) {
          inProviders = false
          continue
        }
        if (!inProviders) continue
        let m = line.match(/^ {4}([^\s:#][^:]*):\s*$/)
        if (m) {
          current = m[1].trim()
          continue
        }
        m = line.match(/^ {6}displayName:\s*(.+?)\s*$/)
        if (m && current) {
          let v = m[1]
          if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1)
          if (v) liveMap[current] = v
        }
      }
      nameMapCache = { mtimeMs: st.mtimeMs, namesMtimeMs: nmt, map: mergeWithPersisted(liveMap) }
      return nameMapCache.map
    } catch {
      if (nameMapCache.mtimeMs === 0) return mergeWithPersisted({})
      return nameMapCache.map
    }
  }

  // ─── 忽略名单：被忽略的 provider 完全不计入账本（垃圾测试记录真删除；mtime 缓存即改即生效） ───
  const ignoredFile = join(dshHome, 'token-ledger', 'ignored-providers.json')
  let ignoredCache = { mtimeMs: 0, set: new Set() }
  const loadIgnored = () => {
    try {
      const mt = existsSync(ignoredFile) ? statSync(ignoredFile).mtimeMs : 0
      if (mt === ignoredCache.mtimeMs) return ignoredCache.set
      const set = new Set()
      if (mt > 0) {
        const parsed = JSON.parse(readFileSync(ignoredFile, 'utf8'))
        if (Array.isArray(parsed)) for (const v of parsed) if (typeof v === 'string' && v) set.add(v)
      }
      ignoredCache = { mtimeMs: mt, set }
      return set
    } catch {
      return ignoredCache.set
    }
  }
  const isIgnoredRoute = (route) => {
    const set = loadIgnored()
    if (set.size === 0) return false
    const slash = String(route).indexOf('/')
    let provider = slash < 0 ? String(route) : String(route).slice(0, slash)
    if (provider.startsWith('modlens-')) provider = provider.slice('modlens-'.length)
    return set.has(provider)
  }

  /** 路由键 → 显示名：provider 段换用户自定义名；modlens-X 归到同提供方；未知保留原 id。 */
  const labelRoute = (route, names) => {
    const slash = route.indexOf('/')
    if (slash < 0) return route
    const provider = route.slice(0, slash)
    const model = route.slice(slash + 1)
    if (provider === 'deepseek-official') return 'DeepSeek（官方）/' + model
    if (provider.startsWith('modlens-')) {
      const base = provider.slice('modlens-'.length)
      return 'modlens·' + (names[base] || base) + '/' + model
    }
    return (names[provider] || provider) + '/' + model
  }

  // ─── 汇总与格式化（用户约定：统一以「亿」为单位，1亿 = 1e8 tokens） ───
  const fmt = (n) => {
    const v = n / 1e8
    if (v >= 1) return v.toFixed(2) + '亿'
    if (v >= 0.01) return v.toFixed(3) + '亿'
    return v.toFixed(4) + '亿'
  }
  const summary = () => {
    const names = loadProviderNames()
    const routes = Object.entries(ledger.byRoute)
      .map(([route, t]) => ({ route, label: labelRoute(route, names), ...t, total: totalOf(t) }))
      .sort((a, b) => b.total - a.total)
    const days = Object.entries(ledger.byDay)
      .map(([day, t]) => ({ day, ...t, total: totalOf(t) }))
      .sort((a, b) => (a.day < b.day ? 1 : -1))
    return {
      firstRecordedDay: Object.keys(ledger.byDay).sort()[0] || null,
      since: new Date(ledger.createdAt).toISOString(),
      updatedAt: new Date(ledger.updatedAt).toISOString(),
      grandTotal: totalOf(ledger.totals),
      totals: { ...ledger.totals, total: totalOf(ledger.totals) },
      routes,
      days,
      recentDays: days.slice(0, 14),
      trackedSessions: Object.keys(ledger.sessions).length,
      backfill: ledger.backfill,
    }
  }

  /** 单日明细：当天总量 + 当天各路由分布（byDayRoute 维度）。 */
  const dayDetail = (day) => {
    const names = loadProviderNames()
    const t = ledger.byDay[day] || zeroTotals()
    const routes = Object.entries(ledger.byDayRoute[day] || {})
      .map(([route, bt]) => ({ route, label: labelRoute(route, names), ...bt, total: totalOf(bt) }))
      .sort((a, b) => b.total - a.total)
    return {
      day,
      totals: { ...t, total: totalOf(t) },
      routes,
      allDays: Object.keys(ledger.byDay).sort(),
      grandTotal: totalOf(ledger.totals),
      firstRecordedDay: Object.keys(ledger.byDay).sort()[0] || null,
      since: new Date(ledger.createdAt).toISOString(),
    }
  }

  /** 区间明细：累加 [from,to]（含端点）每一天的路由分布（周/自定义区间钻取）。 */
  const rangeDetail = (from, to) => {
    const names = loadProviderNames()
    const acc = zeroTotals()
    const routeAcc = {}
    // 与总览曲线共用 byDay 总量；旧日志缺少路由维度时也不丢失区间总量。
    for (const [day, t] of Object.entries(ledger.byDay)) {
      if (day < from || day > to) continue
      for (const key of ['input', 'output', 'cacheRead', 'cacheWrite', 'calls']) acc[key] += Number(t[key]) || 0
    }
    for (const [day, routeMap] of Object.entries(ledger.byDayRoute)) {
      if (day < from || day > to) continue
      for (const [route, t] of Object.entries(routeMap)) {
        const r = (routeAcc[route] ??= zeroTotals())
        r.input += t.input
        r.output += t.output
        r.cacheRead += t.cacheRead
        r.cacheWrite += t.cacheWrite
        r.calls += t.calls

      }
    }
    const routes = Object.entries(routeAcc)
      .map(([route, bt]) => ({ route, label: labelRoute(route, names), ...bt, total: totalOf(bt) }))
      .sort((a, b) => b.total - a.total)
    return {
      from,
      to,
      totals: { ...acc, total: totalOf(acc) },
      routes,
      allDays: Object.keys(ledger.byDay).sort(),
      grandTotal: totalOf(ledger.totals),
      firstRecordedDay: Object.keys(ledger.byDay).sort()[0] || null,
      since: new Date(ledger.createdAt).toISOString(),
    }
  }

  /** 静默增量回填（查询前调用；只扫有变化的文件，fileOffset 保证 O(增量)） */
  const backfillQuiet = () => {
    try {
      backfill()
    } catch {
      /* 静默 */
    }
  }

  // ─── 模型工具：token_ledger_stats ───
  ctx.effect(
    () =>
      ctx.tools.register({
          name: 'token_ledger_stats',
          description:
            '查看全局累积 token 用量账本：跨所有 API 提供商/模型的累计输入/输出/缓存 token、按路由与按日分布、回填状态。数据来自 provider 实测 usage，与具体 API 接入无关。',
          parameters: {},
          output: {
            schema: { type: 'string' },
            render: (_args, value) => [{ type: 'text', text: String(value) }],
          },
          async execute() {
            try {
              backfillQuiet()
              const s = summary()
              const lines = []
              lines.push('📊 全局 token 累积账本（自 ' + (s.firstRecordedDay || s.since.slice(0, 10)) + ' 起）')
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
                  '  ' +
                    (r.label || r.route) +
                    ': ' +
                    fmt(r.total) +
                    '（入 ' +
                    fmt(r.input) +
                    ' / 出 ' +
                    fmt(r.output) +
                    ' / 缓存 ' +
                    fmt(r.cacheRead + r.cacheWrite) +
                    '，' +
                    r.calls +
                    ' 次）',
                )
              }
              lines.push('—— 近 14 天 ——')
              for (const d of s.recentDays) {
                lines.push('  ' + d.day + ': ' + fmt(d.total))
              }
              lines.push(
                '跟踪会话 ' +
                  s.trackedSessions +
                  ' 个；回填 ' +
                  s.backfill.files +
                  ' 文件 / ' +
                  s.backfill.events +
                  ' 事件 / ' +
                  s.backfill.errors.length +
                  ' 错误',
              )
              return lines.join('\n')
            } catch (e) {
              return 'token_ledger_stats 查询失败: ' + String(e).slice(0, 200)
            }
          },
        }),
    '@dsh-external/dsh-token-ledger: stats tool',
  )

  // ─── webServer API（client 面板消费） ───
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'prefix',
        path: '/@dsh-external/dsh-token-ledger/api',
        handler: async (req, res) => {
          try {
            backfillQuiet()
            const url = new URL(req?.url || '/', 'http://localhost')
            if (url.searchParams.get('rebuild') === '1') {
              // 强制全量重建（同步执行，可能耗时数十秒）
              ledger = migrateLedger(ledger)
              backfill()
              flush()
            }
            const day = url.searchParams.get('day')
            const from = url.searchParams.get('from')
            const to = url.searchParams.get('to')
            const validDay = (value) => {
              if (!/^\d{4}-\d{2}-\d{2}$/.test(value || '')) return false
              const parsed = new Date(value + 'T00:00:00Z')
              return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value
            }
            if ((day && !validDay(day)) || ((from || to) && (!validDay(from) || !validDay(to) || from > to))) {
              res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' })
              res.end(JSON.stringify({ error: 'Invalid date or range: expected YYYY-MM-DD and from <= to' }))
              return
            }
            const payload = from && to ? rangeDetail(from, to) : day ? dayDetail(day) : summary()
            res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
            res.end(JSON.stringify(payload))
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
