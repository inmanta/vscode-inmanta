# Inmanta Language server

provides the bridge between the Inmanta compiler and Visual Studio Code ide, by implementing a Language Server

** This is alpha software, it may or may not work **

##Installation

1. mkvirtualenv -p python3 lstesting
2. pip install --extra-index-url https://test.pypi.org/simple/ --pre --no-cache-dir inmantals
3. checkout the vscode-inmanta project and open with vscode
4. press f5
5. set the setting inmanta.pythonPath to ~/.virtualenvs/lstesting/bin/python3
6. open an inmanta project directory
7. navigate the code!

## Features

1. navigate-to-defintion on types

## Not supported yet

1. re-load code (not upon edit or upon save, need to close vscode)
2. work with incorrect models (needs to compile, all or nothing)

## References
https://microsoft.github.io/language-server-protocol/specification