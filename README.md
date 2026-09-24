# @dsh-external/dsh-token-ledger

English | [中文](README.zh.md)

A provider-agnostic **cumulative token usage ledger** for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness), with live capture, historical backfill, a draggable panel and an HTTP API.

The ledger follows the same event contract as the official `dsh-token-meter`, so it is independent of any specific API provider.

- **Live**  subscribes to `session/event` and consumes every active session incrementally. Duplicate samples for the same `(turn, step)` are replaced rather than accumulated, with `llm/retry-started` closing the current sample window.
- **Historical**  on startup it asynchronously backfills every `session.jsonl.zstd` under the sessions root by concatenating zstd frames, decompressing them one by one and de-duplicating by `seq`. Usage produced before the plugin was installed is therefore counted too.
- **Panel**  a floating panel opened from a FAB, draggable with its position persisted in `localStorage`, polling the API every 5 seconds. Totals are presented in units of 亿 (1e8 tokens).
- **Storage**  `~/.dsh/token-ledger/ledger.json`, written atomically via tmp + rename with debounced saves.
- **Fail-safe**  every code path is wrapped in `try/catch`; a statistics failure can never break a session.

## Install

```sh
dsh plugin --profile web add github:wakeup595626-cmyk/dsh-token-ledger
```

## Usage

Open the panel from the FAB in the lower-left corner. The HTTP API is served at `/@dsh-external/dsh-token-ledger/api`.

## Requirements

- A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) installation
- Node.js with zstd support available to the host

## Third-party notices

No third-party runtime dependencies. zstd decompression is delegated to the host runtime.

See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## Community and support

- Report bugs and ask questions through [GitHub Issues](https://github.com/wakeup595626-cmyk/dsh-token-ledger/issues).
- Add the [`dsh-plugin`](https://github.com/topics/dsh-plugin) topic to your own plugin repository for discoverability.
- Browse the wider ecosystem at [awesome-dsh-plugin.com](https://awesome-dsh-plugin.com).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## Citation

```bibtex
@misc{dsh-token-ledger,
  title={dsh-token-ledger},
  author={wakeUp595626-cmyk},
  year={2026},
  publisher={GitHub},
  howpublished={\url{https://github.com/wakeup595626-cmyk/dsh-token-ledger}},
}
```

## License

[BSD-3-Clause](LICENSE)
