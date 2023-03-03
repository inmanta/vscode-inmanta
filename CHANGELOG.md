# v 1.3.0 (?)
Changes in this release:
- Add information about how to show the python interpreter information in the status bar and make it so the status bar should appear when opening an inmanta file.
- A warning that suggests running the `inmanta project install` command is now shown when the compiler fails to install modules. (#894)
- Add support to work on a module. (#891)

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
