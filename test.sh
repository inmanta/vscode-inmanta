#!/bin/bash

# Run extension tests

# Run in venv with inmantals installed in it
export INMANTA_EXTENSION_TEST_ENV="/home/florent/.virtualenvs/demovscodetests"
export INMANTA_LS_PATH="/home/florent/Desktop/vscode-inmanta/server"
export INMANTA_LS_LOG_PATH="/home/florent/Desktop/vscode-inmanta/server.log"

rm -rf $INMANTA_EXTENSION_TEST_ENV
python3.9 -m venv $INMANTA_EXTENSION_TEST_ENV
source $INMANTA_EXTENSION_TEST_ENV/bin/activate
pip install --upgrade pip
pip install -e ../inmanta-core
pip install -e server
deactivate
rm -rf node_modules
npm i --also=dev
xvfb-run npm run test
