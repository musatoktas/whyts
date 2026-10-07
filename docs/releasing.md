# Releasing whyts

whyts is published as two npm packages, `whyts` and `whyts-mcp`. They always have the same version. The MCP Registry entry (`server.json`) names `whyts-mcp`.

## Each release

1. Set the same version in `package.json`, `package-lock.json`, `packages/whyts-mcp/package.json` (also its `whyts` dependency) and `server.json` (the `version` field and the package `version`).
2. Merge the change. Publish a GitHub release with the tag `v<version>`.
3. The workflow `release.yml` stops if the tag and the four versions are not equal. It publishes `whyts`, then `whyts-mcp`, then calls `mcp-registry.yml`.

## First publish of whyts-mcp (once)

npm documents trusted publishing for a package, and its documentation does not say that you can set it up before the package exists. So the first publish of `whyts-mcp` is done by hand. Until then, `release.yml` prints a warning and skips `whyts-mcp` and the registry step. It does not fail.

1. Merge the pull request. Publish the release `v0.8.1`. `release.yml` publishes `whyts@0.8.1` and warns about `whyts-mcp`.
2. In your own terminal (npm asks for your passkey):

   ```sh
   cd ~/DEV/whyts && git checkout main && git pull
   npm view whyts@0.8.1 version
   cd packages/whyts-mcp
   npm publish --access public
   ```

   `npm view` must print `0.8.1`, because `whyts-mcp` depends on that exact version.
3. On npmjs.com, open `whyts-mcp`, Settings, Trusted Publisher, GitHub Actions. Set the owner `musatoktas`, the repository `whyts`, the workflow file `release.yml`. Save.
4. Run the registry publish once. Either open GitHub, Actions, "MCP Registry", Run workflow, version `0.8.1`, or:

   ```sh
   gh workflow run mcp-registry.yml --repo musatoktas/whyts -f version=0.8.1
   gh run watch --repo musatoktas/whyts
   ```

   The workflow checks that `whyts-mcp@0.8.1` is on npm, validates `server.json`, logs in with GitHub OIDC and publishes.

From the next release on, `release.yml` does all of it.

## Notes

- The MCP Registry checks that the published `whyts-mcp` package.json has `mcpName` equal to the `name` in `server.json` (`io.github.musatoktas/whyts`). Only `whyts-mcp` carries `mcpName`.
