# OncoTree

OncoTree is a well-connected minimal Ontology of Cancers which can be found [here](http://oncotree.mskcc.org/#/home).

This can be loaded into GraphKB via the API. By default it will load all available versions and
set terms lost from one version to the next as deprecated.

```bash
node bin/load.js oncotree
```

> :warning: This resource contains cross-reference mappings to [NCIt](../ncit/README.md) so it preferred to load after loading NCIt