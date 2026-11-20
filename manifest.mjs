import fs from 'node:fs'
import path from 'node:path'

function isObject(value) {
  return value != null && typeof value == 'object' && !Array.isArray(value)
}

export function readManifest(root, file, mv) {
  const manifest = JSON.parse(fs.readFileSync(path.resolve(root, file), 'utf8'))
  if (!manifest.name || !manifest.version || (mv && manifest.manifest_version != mv)) {
    throw new Error(`Invalid manifest: ${file}`)
  }
  return manifest
}

function mergeFirefoxOverrides(manifest, overrides) {
  let merged = { ...manifest }
  for (const [key, value] of Object.entries(overrides)) {
    merged = {
      ...merged,
      [key]:
        isObject(value) && isObject(manifest[key])
          ? mergeFirefoxOverrides(manifest[key], value)
          : structuredClone(value),
    }
  }
  return merged
}

/** Convert the manifest fields used by our extensions, then apply Firefox overrides. */
export function createFirefoxManifest(base, overrides) {
  if (base.manifest_version != 3)
    throw new Error('Firefox generation requires an MV3 base manifest')
  if (!isObject(overrides)) throw new Error('Expected an object in manifest.firefox.json')
  for (const key of ['version', 'manifest_version']) {
    if (Object.hasOwn(overrides, key))
      throw new Error(`Keep ${key} in manifest.mv3.json, not manifest.firefox.json`)
  }
  const manifest = structuredClone(base)
  manifest.manifest_version = 2
  if (manifest.background?.service_worker) {
    const { service_worker, ...background } = manifest.background
    manifest.background = { ...background, scripts: [service_worker], persistent: false }
  }
  if (manifest.action) {
    manifest.browser_action = manifest.action
    delete manifest.action
  }
  if (manifest.host_permissions) {
    manifest.permissions = [
      ...new Set([...(manifest.permissions ?? []), ...manifest.host_permissions]),
    ]
    delete manifest.host_permissions
  }
  if (manifest.web_accessible_resources) {
    manifest.web_accessible_resources = [
      ...new Set(manifest.web_accessible_resources.flatMap((entry) => entry.resources)),
    ]
  }
  return mergeFirefoxOverrides(manifest, overrides)
}

export function readTargetManifest(root, mv) {
  if (mv != 2 && mv != 3) throw new Error('Choose manifest version 2 or 3')
  const base = readManifest(root, 'manifest.mv3.json', 3)
  if (mv == 3) return base
  const overrides = JSON.parse(fs.readFileSync(path.join(root, 'manifest.firefox.json'), 'utf8'))
  return createFirefoxManifest(base, overrides)
}
