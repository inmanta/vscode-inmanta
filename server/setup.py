
from setuptools import setup, find_packages

requires = [
    'inmanta>=2018.2',
    'intervaltree'
]

setup(
    name="inmantals",
    package_dir={"" : "src"},
    packages=find_packages("src"),
    install_requires=requires,
    
    version="0.0.1.alpha.7",

    description="Inmanta Language Server",
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
