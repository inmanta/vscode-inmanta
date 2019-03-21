# Inmanta README

This is a [Microsoft Visual Code](https://code.visualstudio.com/) plugin for [Inmanta](https://inmanta.com/)

Eliminate Complexity.

End-to-end orchestration of applications and networks.

Inmanta Documentation on [Read the Docs](https://inmanta.com/resources/docs/)

## Features

For now, just basic Syntax Coloring

![Screenshot](images/screenshot.png)

## Alpha Features

### Code navigation

To enable ctrl-click for code navigation, take the following steps:

- Open an inmanta project in VSCode
- remove the `.env` folder in the project
- create a python36 virtual env (`python3.6 -m venv /home/user/.inmanta-vscode`)
- Update the inmanta extension configuration (`ctrl+,`, `extensions`, `inmanta`)
- Set the `Python Path` to the virtual env you just created (`/home/user/.inmanta-vscode/bin/python3`)
- Set `LS`: to Enabled
- When prompted to install the extensions, say yes.
- Wait for the `.env` folder to re-appear
- `ctrl-click` on a constructor call to jump to the type definition.

## Requirements

None

## Extension Settings

None

## Known Issues

None ATM

## Authors

- Frank Rosquin
- Inmanta

## Release Notes

### 0.2

Syntax updates and publish in marketplace

### 0.0.1

Initial release

**Enjoy!**

