import assert from 'node:assert/strict'
import { test } from 'node:test'

import { createFirefoxManifest } from '../manifest.mjs'

test('converts our MV3 fields and merges Firefox-specific metadata without duplicating shared fields', () => {
  const base = {
    manifest_version: 3,
    name: 'Example',
    version: '1.2.3',
    background: { service_worker: 'background.js', type: 'module' },
    action: {
      default_title: 'Example',
      default_popup: 'browser_action.html',
      default_icon: { 16: 'icons/icon16.png' },
    },
    options_ui: { page: 'options.html' },
    permissions: ['storage', 'https://first.example/*'],
    host_permissions: ['https://first.example/*', 'https://second.example/*'],
    web_accessible_resources: [
      { resources: ['shared/settings.js'], matches: ['https://first.example/*'] },
      {
        resources: ['shared/settings.js', 'shared/extensions-pro-bridge.js'],
        matches: ['https://second.example/*'],
      },
    ],
    content_scripts: [{ matches: ['https://example.com/*'], js: ['content.js'], world: 'MAIN' }],
  }
  const overrides = {
    browser_specific_settings: { gecko: { id: 'example@example.com' } },
    browser_action: { browser_style: true },
    options_ui: { browser_style: true, chrome_style: false },
  }
  const before = structuredClone(base)
  const beforeOverrides = structuredClone(overrides)
  const firefox = createFirefoxManifest(base, overrides)
  assert.equal(firefox.manifest_version, 2)
  assert.equal(firefox.version, '1.2.3')
  assert.deepEqual(firefox.background, {
    scripts: ['background.js'],
    persistent: false,
    type: 'module',
  })
  assert.deepEqual(firefox.browser_action, { ...base.action, browser_style: true })
  assert.equal('action' in firefox, false)
  assert.deepEqual(firefox.options_ui, {
    page: 'options.html',
    browser_style: true,
    chrome_style: false,
  })
  assert.deepEqual(firefox.permissions, [
    'storage',
    'https://first.example/*',
    'https://second.example/*',
  ])
  assert.equal('host_permissions' in firefox, false)
  assert.deepEqual(firefox.web_accessible_resources, [
    'shared/settings.js',
    'shared/extensions-pro-bridge.js',
  ])
  assert.deepEqual(firefox.content_scripts, base.content_scripts)
  assert.deepEqual(firefox.browser_specific_settings, overrides.browser_specific_settings)
  firefox.browser_action.default_icon[16] = 'changed.png'
  firefox.browser_specific_settings.gecko.id = 'changed@example.com'
  assert.deepEqual(base, before)
  assert.deepEqual(overrides, beforeOverrides)
})

test('keeps Firefox version and manifest format derived from the MV3 base', () => {
  const base = { manifest_version: 3, name: 'Example', version: '1.0.0' }
  for (const overrides of [{ version: '2.0.0' }, { manifest_version: 3 }, [], null]) {
    assert.throws(() => createFirefoxManifest(base, overrides))
  }
  assert.throws(() => createFirefoxManifest({ ...base, manifest_version: 2 }, {}), /MV3 base/)
  assert.deepEqual(createFirefoxManifest(base, {}), { ...base, manifest_version: 2 })
})
