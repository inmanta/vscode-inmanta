# Shortcuts for various dev tasks. Based on makefile from pydantic
isort = isort src tests
black = black src tests

.PHONY: format
format:
	$(isort)
	$(black)

.PHONY: pep8
pep8:
	pip install -r requirements.dev.txt pep8-naming flake8-black flake8-isort
	flake8 src tests
