### Set module dependency locations

When working on an individual module, set the "inmanta.pip.index_url" config option to tell the extension which
pip index to use to install dependencies on v2 modules.


It is possible to configure extra indexes via the "inmanta.pip.extra_index_url" option, but be mindful of potential security risks when using more than one index. Please refer to the [documentation](https://docs.inmanta.com/community/latest/reference/projectyml.html#inmanta.module.ProjectPipConfig) for more information.

When working on a project, this option is ignored and the Inmanta extension will look for modules in the pip index set in the `pip.index_url` [section](https://docs.inmanta.com/community/latest/reference/projectyml.html#inmanta.module.ProjectPipConfig) of the project.yaml file.


