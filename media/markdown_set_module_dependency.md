### Set module dependency locations

When working on an individual module, set the "inmanta.pip.index_url" config option to tell the extension which
pip index to use to install dependency v2 modules.


It is possible to configure extra indexes via the "inmanta.pip.extra_index_url" option, but be mindful of potential security risks when using more than one index. Please refer to the [documentation](https://docs.inmanta.com/community/latest/reference/projectyml.html#inmanta.module.ProjectMetadata) for more information.

When working on a project, this option is ignored and the Inmanta extension will look for modules in the repositories and pip indexes defined in the repo section of the [project.yaml](https://docs.inmanta.com/community/latest/reference/projectyml.html#project-yml) file.


