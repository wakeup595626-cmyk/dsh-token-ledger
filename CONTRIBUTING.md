# Contributing

English | [中文](CONTRIBUTING.zh.md)

Thank you for your interest in contributing to `@dsh-external/dsh-token-ledger`!

This is a small, single-maintainer plugin. Contributions of every size are welcome  bug reports and documentation fixes are just as valuable as code.

## Ways to contribute

- **Report a bug**  open a [GitHub Issue](https://github.com/wakeup595626-cmyk/dsh-token-ledger/issues) and include your DeepSeek Harness version, the steps to reproduce, and what you expected to happen.
- **Request a feature**  open an issue describing the problem you want solved rather than only the solution you have in mind.
- **Improve the docs**  the README exists in both English and Chinese; corrections to either side are appreciated.
- **Send a pull request**  see below.

## Development

```sh
git clone https://github.com/wakeup595626-cmyk/dsh-token-ledger.git
cd dsh-token-ledger
```

The plugin loads straight from `lib/`, so there is no build step for a local checkout. To test a change, install the local directory into a profile:

```sh
dsh plugin --profile web add <path-to-your-checkout>
```

## Pull requests

- Keep each pull request focused on a single change.
- Match the existing code style; the plugin deliberately has no third-party runtime dependencies, so please discuss before adding one.
- Update both `README.md` and `README.zh.md` if you change documented behaviour.
- Describe what you tested and how.

## License

By contributing, you agree that your contributions are licensed under the [BSD-3-Clause](LICENSE) license that covers this project.
