# Releasing CHH

The release pipeline is fully automated. On every push to `main`:

1. **release-please** scans new conventional-commit messages
2. If there are user-facing changes (`feat:`, `fix:`, `perf:`, etc.), it opens / updates a "release PR" that bumps the version in `manifest.json` and `CHANGELOG.md`.
3. When that PR is **merged**, release-please tags `vX.Y.Z`, publishes a GitHub Release, then the `publish` job zips the extension and uploads it to the Chrome Web Store.

## Conventional commits cheat-sheet

| Prefix | Bumps |
| --- | --- |
| `feat:` | minor (0.x bumps until v1.0, then minor) |
| `fix:` | patch |
| `perf:` | patch |
| `refactor:` / `docs:` / `style:` / `test:` / `chore:` | none |
| `feat!:` or `BREAKING CHANGE:` in body | major |

## One-time setup

### 1. Chrome Web Store account
- Create a developer account (5 $ once) at https://chrome.google.com/webstore/devconsole
- Upload the first build manually to get an **extension ID** (32 chars).

### 2. Google Cloud OAuth credentials
- Open https://console.cloud.google.com/, pick or create a project
- Enable the **Chrome Web Store API**
  (`APIs & Services → Library → Chrome Web Store API → Enable`)
- Create OAuth credentials: `Credentials → Create Credentials → OAuth client ID → Desktop app`
- Note the **Client ID** and **Client Secret**

### 3. Refresh token (one-shot, locally)
The Chrome Web Store API needs a long-lived refresh token. Generate it once:

```bash
# Replace CLIENT_ID + CLIENT_SECRET below
open "https://accounts.google.com/o/oauth2/auth?response_type=code&scope=https%3A%2F%2Fwww.googleapis.com%2Fauth%2Fchromewebstore&client_id=CLIENT_ID&redirect_uri=urn:ietf:wg:oauth:2.0:oob"
```

Authorize, copy the `code` from the redirect URL, then:

```bash
curl -s "https://accounts.google.com/o/oauth2/token" \
  -d "client_id=CLIENT_ID" \
  -d "client_secret=CLIENT_SECRET" \
  -d "code=CODE_FROM_BROWSER" \
  -d "grant_type=authorization_code" \
  -d "redirect_uri=urn:ietf:wg:oauth:2.0:oob"
```

Copy the `refresh_token` from the JSON response.

### 4. GitHub secrets
On the repo: `Settings → Secrets and variables → Actions → New repository secret`. Add:

| Secret | Value |
| --- | --- |
| `CHROME_EXTENSION_ID` | the 32-char ID from step 1 |
| `CHROME_CLIENT_ID` | OAuth Client ID from step 2 |
| `CHROME_CLIENT_SECRET` | OAuth Client Secret from step 2 |
| `CHROME_REFRESH_TOKEN` | refresh token from step 3 |

That's it. The next merged release PR will ship to the store.

## Releasing manually (escape hatch)

If you ever need to ship without going through release-please:

```bash
# Bump manifest.json + commit + tag manually
git tag v0.2.0 && git push --tags

# Zip locally
zip -r chh.zip manifest.json LICENSE icons src \
  -x "icons/*.svg" -x "**/.DS_Store"

# Upload via the CLI (uses your local creds — install with `npm i -g chrome-webstore-upload-cli`)
chrome-webstore-upload upload \
  --source chh.zip \
  --extension-id "$CHROME_EXTENSION_ID" \
  --client-id "$CHROME_CLIENT_ID" \
  --client-secret "$CHROME_CLIENT_SECRET" \
  --refresh-token "$CHROME_REFRESH_TOKEN"

chrome-webstore-upload publish \
  --extension-id "$CHROME_EXTENSION_ID" \
  --client-id "$CHROME_CLIENT_ID" \
  --client-secret "$CHROME_CLIENT_SECRET" \
  --refresh-token "$CHROME_REFRESH_TOKEN"
```

## What's in the zip

```
manifest.json
LICENSE
icons/*.png   (icon-*.svg sources excluded)
src/**/*.{js,css,html}
```

Adjust the `zip -x` patterns in `.github/workflows/release.yml` if you need to ship more files.
