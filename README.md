## Commands

```sh
soext --help

# Generates browser_action.html from options.html
soext popup
soext popup --watch # Regenerate whenever options.html changes

# Prepares this directory to load as an unpacked extension
soext prepare --mv 2
soext prepare --mv 3

# Packages MV2 and MV3 in dist/
soext build
soext build --mv 3 --overwrite

# Removes generated unpacked files
soext clean

# Updates version numbers and bumps Xcode build numbers
soext version patch
soext version minor
soext version major
soext version 1.2.3

# Updates _locales/<lang>/messages.json from a translations file (see format below)
# Defaults to scripts/translations.json
soext locales update
soext locales update scripts/translations.json
soext locales remove obsoleteKey anotherObsoleteKey # Removes keys

# Merges translations files (see format below)
soext translations merge translations.json scripts/locales/base-locales.json

# --dry-run checks changes without writing anything
soext build --mv 3 --dry-run
soext version patch --dry-run
soext translations merge translations.json scripts/locales/base-locales.json --dry-run

# --root specifies another extension directory
soext prepare --mv 3 --root ../my-extension

# Serves the live options page at http://127.0.0.1:5011/
# http://127.0.0.1:5011/browser_action.html to preview the popup version
# http://127.0.0.1:5011/?lang=ja to set a language
# http://127.0.0.1:5011/?reset=1 to clear preview settings
soext preview options
soext preview options --port 5012 --host 0.0.0.0

# Use addons-linter to validate extension ZIPs if needed
npx addons-linter dist/my_extension-1.2.3.mv2.zip
```

## Extension repo conventions

### Expected files

```text
_locales/<lang>/messages.json                     # WebExtension locale messages
manifest.mv3.json                                 # Base manifest and version
manifest.firefox.json                             # Firefox-specific MV2 overrides
options.html                                      # Shared options/popup HTML
safari/<name>.xcodeproj/project.pbxproj           # Single Xcode project under safari/
safari/Shared (Extension)/Resources/manifest.json # Required when safari/ exists
```

### Generated files

```text
browser_action.html # Popup
dist/               # Extension ZIP archives
manifest.json       # Final manifest for extension version
```

### manifest.firefox.json

Firefox-specific fields which are merged after converting `manifest.mv3.json` to
MV2 (background worker, action, host permissions, web-accessible resources...):

```json
{
  "browser_action": { "browser_style": true },
  "browser_specific_settings": {
    "gecko": { "id": "my-extension@example.com", "strict_min_version": "128.0" },
    "gecko_android": { "strict_min_version": "128.0" }
  },
  "options_ui": { "browser_style": true }
}
```

### soext.config.mjs

```js
export default {
  // ZIP filename prefix
  archiveName: 'my_extension',
  // Allowlist of files to include in extension ZIP archives
  files: [
    '_locales/*/messages.json',
    'background.js',
    'browser_action.html', // Generated from options.html
    'content.js',
    'icons/icon16.png',
    'manifest.json', // Generated from the manifest version being built
    'options.css',
    'options.html',
    'options.js',
  ],
  // Optional - preview also works without this block
  preview: {
    // Storage namespace - defaults to archiveName
    id: 'my-extension-preview',
    // URL parameters can set stored preferences before the options page starts
    parameters: {
      // ?style=ios saves { optionsStyle: 'ios' } in preview storage
      style: 'optionsStyle',
      // ?layout=mobile saves { lastLayout: 'mobile' } in preview storage
      layout: 'lastLayout',
    },
    // Optional server-side hook
    // Return manifest, storageGroup or urlParams
    // configure: async ({ root, params, manifest }) => ({ manifest }),
  },
}
```

## Translations file format

Key-first format for working with locale messages:

```json
{
  "greeting": {
    "en": "Hello",
    "ja": "こんにちは"
  },
  "farewell": {
    "en": "Goodbye",
    "ja": "さようなら"
  }
}
```

Shared placeholders for `soext locales update`:

```json
{
  "selectedKeys": {
    "message": {
      "en": "Selected: $KEYS$",
      "ja": "選択済み: $KEYS$"
    },
    "placeholders": {
      "KEYS": { "content": "$1" }
    }
  }
}
```

## JavaScript API

Using exported functions in project-specific scripts:

```js
import { build, loadProject } from '@soitis/soext'

let project = await loadProject('/path/to/extension')
await build(project, { mv: 3 })
```

## Local development

```sh
# In this repo
npm install
npm test

# In extension repos
npm install --save-dev --install-links=false --package-lock=false ../soext
```
