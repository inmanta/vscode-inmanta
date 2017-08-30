
from setuptools import setup, find_packages

requires = [
    'inmanta'
]

setup(
    name="inmanta-lsp",
    package_dir={"" : "src"},
    packages=find_packages("src"),
    version="2018.2",
    description="Inmanta Language Server",
    author="Inmanta",
    author_email="code@inmanta.com",
    license="Apache Software License",

    package_data={"" : ["misc/*", "docs/*"]},
    include_package_data=True,

    install_requires=requires,
    # setup_requires=['tox-setuptools', 'tox'],

    entry_points={
    'console_scripts': [
        'inmanta-lsp = inmanta.lsp:main',
    ],
},
)