# Inmanta README

This is a [Microsoft Visual Code](https://code.visualstudio.com/) plugin for [Inmanta](https://inmanta.com/)

Eliminate Complexity.

End-to-end orchestration of applications and networks.

Inmanta Documentation on [Read the Docs](https://inmanta.com/resources/docs/)

## Features


### Syntax coloring
The extension makes your life easier by coloring syntax keywords or the Inmanta language.

![Syntax coloring screenshot](images/screenshot-syntax-coloring.png)

### Code navigation
The extension allows you to navigate to the Definition of types used by using the shortcut `Ctrl + Click` when you hover the element.  And will show an overview of the Entity if you don't click.

![Navigation screenshot](images/screenshot-ctrl-click.png)

### Compilation error reporting
The extension will run a pre-compilation every time you save your file.  Making it easier for you to spot syntax and basic model errors.  When hovering the problematic bit, an explaination message is shown, and more details can be found in the **Output** panel (when selecting *Inmanta Server Language* in the expandable list on the right).

![Error reporting screenshot](images/screenshot-error-reporting.png)

### Model export
The extension adds a button in the upper right corner of the editing panel of any inmanta model file (ending in `.cf`): **Export to server**.  This buttons allows you to easily export the current open model to an Inmanta server running.  Note that for this to work, you need to have previously configured the server, and added the following informations in the `.inmanta` configuration file at the root of the project:

```
[config]
fact-expire=1800
environment=f2f6ac46-10a2-4e75-897d-b91c51c78df2  # Replace this by the right environment uuid

[compiler_rest_transport]
host=10.0.0.102                                   # Replace this by the address of the host
port=8888                                         # Replace this by the port on which the server is listening

[cmdline_rest_transport]
host=10.0.0.102                                   # Replace this by the address of the host
port=8888                                         # Replace this by the port on which the server is listening
```

## Installation

To enable ctrl-click for code navigation, a few extra steps are required:

- Open an inmanta project in VSCode
- Create a python36 virtual env (`python3.6 -m venv /home/user/.inmanta-vscode`)
- Update the inmanta extension configuration (`ctrl+,`, `extensions`, `inmanta`)
  - Set the `Python Path` to the virtual env you just created (`/home/user/.inmanta-vscode/bin/python3`)
  - Set `LS`: to Enabled
- When prompted to install the extensions, say yes.
- Wait for a notification to notify you that the compilation suceeded (or failed).
- `ctrl-click` on a constructor call to jump to the type definition.

## Requirements

None

## Extension Settings

You can find the settings of the extension, in the Settings panel, under `Extensions > Inmanta`.

![Settings screenshot](images/screenshot-settings.png)

The extension currently has three settings:
 - inmanta.compilerVenv: Absolute path to the virtual environment the compiler should use.
 - inmanta.ls.enabled: Whether or not activate the Inmanta Language server (you probably want to).
 - inmanta.pythonPath: Python path the extension should use to run the language server.

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
