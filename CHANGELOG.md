# v 1.8.0 (2025-04-04)
Changes in this release:
- Update and apply improved linting configuration
- Add testing procedure in the readme

# v 1.7.0 (2024-04-04)
Changes in this release:
- Fix bug that could cause multiple instances of the language server to be running simultaneously.

# v 1.6.0 (2024-01-24)
Changes in this release:
- Add syntax highlighting for arithmetic operators.

# v 1.5.0 (2024-01-15)
Changes in this release:
- Drop support for iso4/iso5
- Add workaround for bug in the python extension where `getExecutionDetails().execCommand[0]` returns the path to the root of the venv instead of the path to the python binary in that venv.
- Add extension settings to configure pip when working on a module or a project. (#1511)

# v 1.4.0 (2023-06-06)
Changes in this release:
- Tie the version of the language server to the version of the extension to make sure everything stays compatible and up to date.(#1099)
- Show docstring for Entities and Plugins on hover.(#1035)
- Add support for workspaces (#892)
- Add information about how to show the python interpreter information in the status bar and make it so the status bar should appear when opening an inmanta file. (#939)
- A warning that suggests running the `inmanta project install` command is now shown when the compiler fails to install modules. (#894)
- Add support to work on a module. (#891)
- make some unclear error messages more helpful (#970)
- 'Export to server' is now run in terminal (#970)
- Walkthrough/setup assistant added (#970)
- Commands added to: install the language server, activate the language server, run 'project install' and to open the setup assistant (#970)
- Fixed bug where the multiple outputs of the language server where visible (#991)
- Fix string syntax highlighting. (#1014)

# v 1.2.0 (2022-12-23)
Changes in this release:
- remove EntityLike as it doesn't exist anymore.
- Fix bug where two Inmanta language servers would run simultaneously for a short period of time when the language server is restarted.
- Fix bug where changing to a different venv starts the Inmanta language server, even when it's disabled in the configuration.
- Fix bug where the Inmanta language server is restarted, even when the configured venv has not changed.

# v 1.1.0 (2022-01-14)
Changes in this release:

# v 1.0.1 (?)
Changes in this release:
- use unique log file for each workspace (#64)
- added troubleshooting sections related to venv reuse by multiple compiler venvs (#65)

# v 1.0.0 (2020-11-06)
Changes in this release:
- Added error highlighting (#18)
- Added export to server button (#8)
- Use separate virtual env for the compiler (#9)
- Added symbol search support (Ctrl+T) (#34)
- Show clear error when a file is opened instead of a project (#32)
- Extended language server support on Windows (#26)

# v 0.0.1
- Initial release
