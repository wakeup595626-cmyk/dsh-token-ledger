/**
 * @dsh-external/dsh-token-ledger — client：独立悬浮面板。
 *
 * ⚠️ 权威产物是 lib/client.js（本机无 bash/tsc 构建链，手写维护），本文件为同逻辑参考。
 *
 * 设计（2026-09 实测决策）：
 * - 不走 slot：官方 renderer 只认 React 组件，第三方纯 DOM render 契约不被适配；
 *   面板改为纯 DOM 注入 document.body，卸载即净（ctx.effect disposer 移除全部元素/定时器）。
 * - 侧边栏左下角 FAB「📊 用量」开关面板；面板可拖动（位置持久化 localStorage）；
 *   每 5s 轮询 /@dsh-external/dsh-token-ledger/api，展示总计 + 按模型/提供商 + 近 14 天。
 * - 单位统一「亿」（1亿 = 1e8 tokens，用户约定）。
 */
export {}
