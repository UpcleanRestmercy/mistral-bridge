# Contributing and release verification

Use Node >=20.12 for the dependency-free bridge tests. Use Node 24 for DSH 0.2.1-rc.5 integration dependencies. Git, npm and `tar` are needed for the package check (Windows includes tar).

```sh
git clone https://github.com/UpcleanRestmercy/mistral-bridge.git
cd mistral-bridge
npm test
npm run test:package
# Install the exact development dependency graph recorded in package-lock.json:
npm ci --ignore-scripts
npm run test:dsh
```

`npm test` runs offline tests with synthetic credentials and local HTTP servers. It needs no npm install. `test:dsh` uses real published Cordis, DSH settings/configuration, credentials and pi-ai components; it also uses local HTTP fixtures, not paid APIs. The versions of all direct test dependencies are pinned in package.json. No symlinks to a maintainer's host installation are needed. DSH peers are optional for ZCode users.

`test:package` creates an npm archive in a temporary directory, checks excluded private paths, extracts it and runs the archive's own `npm test`. Offline and integration test files ship with the package; integration tests still require the development dependencies above. CI runs offline/archive tests on Linux and Windows and DSH integration on Linux. Installing dependencies downloads software; the test requests themselves remain local.

For an explicit paid ZCode check, first start the host and configure its native Models key, then run `node live-smoke.mjs default MODEL_ID`. Run `node live-smoke.mjs --help` for scope. For DSH native credentials use its Models UI to run a synthetic generation; the standalone script cannot access the host credential service. Neither check proves every model or GUI path.

Before releasing, review `git status`, the staged diff, all reachable Git history, the actual archive file list and a secret scan. A pattern scan cannot prove the absence of secrets. Keep raw credentials, profiles and logs outside the checkout. Update package.json, the ZCode manifest, marketplace.json, proxy.mjs and CHANGELOG.md together. Run all three checks above from a clean checkout; tag the verified commit and attach the tested archive plus its SHA-256 to the GitHub Release.
