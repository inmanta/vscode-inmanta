### Set module dependency locations


Indicate the Inmanta extension where to look for dependency modules when working on an individual module.

When working on a project, this option is ignored and the Inmanta extension will look for modules in the repositories and pip indexes defined in the repo section of the [project.yaml](https://docs.inmanta.com/community/latest/reference/projectyml.html#project-yml) file.

These module dependencies follow this scheme:

```json
    {"type": "git", "url": "https://github.com/inmanta/"}
```

The type property can have two values:
# Type "git"

The url property holds the URI of the parent location for a v1 module. (Organization url for github, Group url for gitlab, parent folder for a local repository...)


# Type "package"


The url property holds the pip index url in which to look for v2 modules. ⚠️Be mindful of potential security risks when using more than one index. Please refer to the [documentation](https://docs.inmanta.com/community/latest/reference/projectyml.html#inmanta.module.ProjectMetadata) for more information.
