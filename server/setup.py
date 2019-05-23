
from setuptools import setup, find_packages
from os import path

requires = [
    'inmanta>=2019.2',
    'intervaltree'
]

# read the contents of your README file
this_directory = path.abspath(path.dirname(__file__))
with open(path.join(this_directory, 'README.md'), encoding='utf-8') as f:
    long_description = f.read()

setup(
    name="inmantals",
    package_dir={"" : "src"},
    packages=find_packages("src"),
    install_requires=requires,
    
    version="0.2.0",

    description="Inmanta Language Server",
    long_description=long_description,
    long_description_content_type='text/markdown',
    author="Inmanta",
    author_email="code@inmanta.com",
    license="Apache Software License",
    url="https://github.com/inmanta/vscode-inmanta",
    keywords=["ide","language-server","vscode", "inmanta"],
    classifiers=["Development Status :: 3 - Alpha", 
                 "Intended Audience :: Developers",
                 "Intended Audience :: Telecommunications Industry",
                 "License :: OSI Approved :: Apache Software License",
                 "Operating System :: OS Independent",
                 "Topic :: System :: Systems Administration",
                 "Topic :: Utilities"],
    
    entry_points={
    'console_scripts': [
        'inmanta-language-server-tcp = inmantals.tcpserver:main',
    ],
},
)
