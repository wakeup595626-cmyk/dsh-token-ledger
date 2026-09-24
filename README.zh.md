# @dsh-external/dsh-token-ledger

[English](README.md) | 中文

为 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 提供跨提供商的**全局累积 token 用量账本**：实时捕获、历史回填、可拖拽悬浮面板与 HTTP API。

账本采用与官方 `dsh-token-meter` 相同的 usage 事件契约，因此与具体 API 提供商无关。

- **实时**：订阅 `session/event`，增量消费所有活跃会话。同一 `(turn, step)` 的重复样本会被替换而非累加，`llm/retry-started` 用于关闭当前样本窗口。
- **历史**：启动时异步回填 sessions 根目录下所有 `session.jsonl.zstd`拼接 zstd 帧、逐帧解压、按 `seq` 去重。因此安装插件之前产生的用量同样会被计入。
- **面板**：左下角 FAB 打开悬浮面板，可拖拽且位置持久化在 `localStorage`，每 5 秒轮询一次 API；统计以「亿」（1e8 tokens）为单位展示。
- **持久化**：`~/.dsh/token-ledger/ledger.json`，采用 tmp + rename 原子写与定时防抖。
- **失败自闭合**：全部路径都有 `try/catch`，统计异常绝不影响会话主流程。

## 安装

```sh
dsh plugin --profile web add github:wakeup595626-cmyk/dsh-token-ledger
```

## 使用

点击左下角 FAB 打开面板。HTTP API 位于 `/@dsh-external/dsh-token-ledger/api`。

## 环境要求

- 已安装 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)
- host 侧可用的 Node.js zstd 支持

## 第三方声明

无第三方运行时依赖，zstd 解压交由 host 运行时完成。

See [THIRD_PARTY_NOTICES.zh.md](THIRD_PARTY_NOTICES.zh.md).

## 社区与支持

- Report bugs and ask questions through [GitHub Issues](https://github.com/wakeup595626-cmyk/dsh-token-ledger/issues).
- Add the [`dsh-plugin`](https://github.com/topics/dsh-plugin) topic to your own plugin repository for discoverability.
- Browse the wider ecosystem at [awesome-dsh-plugin.com](https://awesome-dsh-plugin.com).

## 参与贡献

See [CONTRIBUTING.zh.md](CONTRIBUTING.zh.md).

## 引用

```bibtex
@misc{dsh-token-ledger,
  title={dsh-token-ledger},
  author={wakeUp595626-cmyk},
  year={2026},
  publisher={GitHub},
  howpublished={\url{https://github.com/wakeup595626-cmyk/dsh-token-ledger}},
}
```

## 许可证

[BSD-3-Clause](LICENSE)
