# Shortcuts for various dev tasks. Based on makefile from pydantic
.DEFAULT_GOAL := all
isort = isort src tests
black = black src tests

.PHONY: format
format:
	$(isort)
	$(black)

.PHONY: pep8
pep8:
	pip install -c requirements.txt pep8-naming flake8-black flake8-isort
	flake8 src tests
