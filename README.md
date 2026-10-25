# Inmanta README

This is a [Microsoft Visual Code](https://code.visualstudio.com/) plugin for [Inmanta](https://inmanta.com/)

Eliminate Complexity.

End-to-end orchestration of applications and networks.

Inmanta Documentation on [Read the Docs](https://inmanta.com/resources/docs/)

## Features


### Syntax highlighting
The extension makes your life easier by highlighting syntax keywords or the Inmanta language.

![Syntax coloring screenshot](images/screenshot-syntax-coloring.png)

### Code navigation
When you hover an element while pressing `Ctrl`, an overview of its Entity type is shown. If you click it (while still having `Ctrl` pressed) you can navigate to the definition of the entity.

> :bulb: To work properly, this feature requires the Inmanta Language Server to be running:
> In the inmanta extension configuration (`ctrl+, > extensions > inmanta`), ensure that `LS` is enabled.

![Navigation screenshot](images/screenshot-ctrl-click.png)

### Compilation error reporting
The extension will run a pre-compilation every time you save your file. Making it easier for you to spot syntax and basic model errors. When hovering the problematic bit, an explaination message is shown, and more details can be found in the **Output** panel (when selecting *Inmanta Server Language* in the expandable list on the right).

> :bulb: To work properly, this feature requires the Inmanta Language Server to be running:
> In the inmanta extension configuration (`ctrl+, > extensions > inmanta`), ensure that `LS` is enabled.

![Error reporting screenshot](images/screenshot-error-reporting.png)

### Model export
The extension adds a button in the upper right corner of the editing panel of any inmanta model file (ending in `.cf`): **Export to server**. This buttons allows you to easily export the currently opened model to a running Inmanta server. Note that for this to work, you need to have previously configured the server and added the following in the `.inmanta` configuration file at the root of the project:

```
[config]
environment=f2f6ac46-10a2-4e75-897d-b91c51c78df2  # Replace this by the right environment uuid

[compiler_rest_transport]
host=10.0.0.102                                   # Replace this by the address of the host
port=8888                                         # Replace this by the port on which the server is listening

[cmdline_rest_transport]
host=10.0.0.102                                   # Replace this by the address of the host
port=8888                                         # Replace this by the port on which the server is listening
```

### Lifecycle Studio
Open a csv lifecycle of `future::lsm::fsm` (a `lifecycle.csv` with `name`, `desired_state` and `on_*` columns) with the **Open in Lifecycle Studio** button in the editor title, or with *Open With... > Inmanta Lifecycle Studio*. The studio has three modes:

- **View**: the lifecycle as a graph, grouped in stages (the `web_stage` annotation, or the desired state). The detail level goes from coarse to fine: **Desired states** (one box per desired state), **States** (the rows of the csv) and **States + validation** (every state in the orchestrator, including the `validating_*` and `rejected_*` states the factory generates).
- **Edit**: change states and transfers in the inspector, or drag the handle of the selected state onto another state to add a transfer. Every edit is a normal edit of the csv, so undo, save and diff work as usual.
  The stages panel adds, names, orders and deletes stages. Drop a state on a stage to set its `web_stage`, drag a stage by its title to arrange the canvas. Once declared, the stages are laid out left to right in their order.
- **Simulate**: create an instance or start in any state, then send updates, deletes, set state calls, validation results and resource outcomes. The studio shows the attribute sets, the desired state and the `states.csv` options the model sees in each kind of compile, and saves runs as scenarios.

For every state, the inspector previews what the web console shows: the state badge (`web_label`, `web_icon`, `web_description`) and the Actions menu with the set state buttons and their transfer annotations (`web_button_label`, `web_confirm`, `web_advanced_state`, ...). In Simulate mode these buttons drive the simulation.

The `states.csv` next to the lifecycle csv is picked up automatically. What the csv can't hold (stage definitions, transfer annotations, layout and scenarios) is stored in `<name>.lifecycle.yml` next to the csv. Pass this file as the `metadata_file` of `future::lsm::fsm::LifecycleFactory` to set the transfer annotations in the lifecycle. The lifecycle checks are also reported in the Problems panel for any open lifecycle csv. The studio works without the language server.

## Requirements

 - Operating System: Currently only Linux and Windows are supported.
 - Python extension (ms-python.python) installed
 - Python >=3.6 <=3.8

## Extension Settings

You can find the settings of the extension, in the Settings panel, under `Extensions > Inmanta`.

![Settings screenshot](images/screenshot-settings.png)

The extension currently has three settings:
 - inmanta.compilerVenv: Absolute path to the virtual environment the compiler and language server should use.
 - inmanta.ls.enabled: Whether or not activate the Inmanta Language server (you probably want to).
 - inmanta.repos: A yaml list of repositories to tell the Inmanta extension where to look for modules. This setting is only used when working on a module.


### Python environments
The plugin uses the Python extension to change environments. This can be done by clicking on the active environment in the bottombar
and then selecting the environment to activate.

Please use the default setting for "python.interpreter.infoVisibility": "OnPythonRelated".

<img src="images/python-extension.png" width="40%">

The selected Python environment will be used to install the Inmanta Language server.
 - If the used version of inmanta-core>=6 then it will also be used for the module dependencies and the v2 modules.
 - If the version of inmanta-core<6 then the inmanta.compilerVenv setting will be used as environment for the module dependencies.

<img src="images/python-env.png" width="80%">

## Known Issues

The Python extension sometimes crashes when opening an untrusted workspace for the first time. A workaround to this issue is to restart VS Code. See related discussion [here](https://github.com/microsoft/vscode-python/issues/20367).

## Troubleshooting

### No module named x

If compilation fails with the message "no module named x" where x is a Python module, you might need to clean up the virtual
environments used by the compiler. This issue can be caused when you open a project in vscode that you previously compiled
manually, or when you change the path for the language server venv. To clean up the virtual environments, remove the .env
directory in the Inmanta project directory as well as the directory specified in the Compiler Venv option in the extension's
settings. Then restart vscode.

## Development tests

If you are contributing or developing for the extention, here are the steps required to run the E2E tests.

- `npm install`
- Make certain you are running the correct python version. 3.12 or higher is required. 
    - If you are on WSL-Ubuntu and have issues updating your python version, you can try the following: 
        - `sudo add-apt-repository ppa:deadsnakes/ppa`
        - `sudo apt install python3.12`
- `python3.12 -m venv /tmp/venv`
- `export INMANTA_EXTENSION_TEST_ENV=/tmp/venv`
- `export INMANTA_LS_LOG_PATH=/tmp/venv/server.log`
- `export DISPLAY=:0` (only for Windows/WSL)
- `/tmp/venv/bin/python -m pip install ./server`

You can now launch the tests either with the debugger, or with `npm run test`.

## Authors

- Frank Rosquin
- Inmanta

## Release Notes

### 0.2

Syntax updates and publish in marketplace

### 0.0.1

Initial release

**Enjoy!**
