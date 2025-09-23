# v 1.8.0 (?)
Changes in this release:
- Drop usage of deprecated pkg_resource package.

# v 1.7.0 (2025-04-04)
Changes in this release:
- Format code using black 25.1.0

# v 1.6.0 (2024-04-04)
Changes in this release:
- Fix memory leak by resetting the `inmanta.plugins.PluginMeta` and `inmanta.export.Exporter` classes before every compile.

# v 1.5.0 (2023-12-21)
Changes in this release:
- Add  support for the float type in the inmanta syntax.

# v 1.4.0 (2023-06-06)
Changes in this release:

# v 1.3.0 (2022-12-23)
Changes in this release:
- Ensure that the language server stops compiling when it receives a shutdown request. This prevents that two language servers are acting on the same project simultaneously.

# v 1.2.0 (2022-01-13)
Changes in this release:

# v 1.1.0 (2021-05-28)
Changes in this release:
- Replace the dependency on inmanta with a dependency on inmanta-core

# v 1.0.1 (?)
Changes in this release:
- use unique log file for each workspace (#64)
- added troubleshooting sections related to venv reuse by multiple compiler venvs (#65)

# v 1.0.0 (2020-11-06)
Changes in this release:
- Added language server to client diagnostics notifications to highlight errors (#18)
- Added symbol provider (#34)
- Extended language server support on Windows (#26)

# v 0.2.1 (2019-10-31)

## Engineering
* Use native coroutines instead of tornado decorators
* Made pep8 compatible
* Added basic smoke test
