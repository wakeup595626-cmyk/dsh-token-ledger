# 第三方声明

本项目以 [BSD-3-Clause](LICENSE) 许可协议分发。以下说明涵盖其所依赖的第三方组件。

## 运行时依赖

运行时无依赖；zstd 解压交由 host 的 Node.js 运行时完成。

## 构建依赖

`@types/node`、`typescript`、`tsdown`（仅构建期使用）。

## 宿主平台

本插件面向 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（MIT）以及（在适用时）[Cordis](https://github.com/cordiverse/cordis)。二者均未在此再分发，需由宿主环境自行提供。

## 反馈

如果你认为某条第三方声明缺失或不完整，欢迎提交 [issue](https://github.com/wakeup595626-cmyk/dsh-token-ledger/issues)。
