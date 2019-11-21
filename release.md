# Release process 

https://code.visualstudio.com/api/working-with-extensions/publishing-extension


## Notes

1. Update version number
2. To test if packaging is OK
```bash
vsce package
code --install-extension inmanta-x.x.x.vsix 
```
3. vsce publish
