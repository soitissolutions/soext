import fs from 'node:fs'
import path from 'node:path'

import semver from 'semver'

import { readManifest, readTargetManifest } from './manifest.mjs'

export function updateVersion({ root }, version, { dryRun = false } = {}) {
  const manifests = ['manifest.mv3.json']
  // Validate Firefox generation without storing a duplicate version in its overrides
  readTargetManifest(root, 2)
  let safariProject
  const safariDirectory = path.join(root, 'safari')
  if (fs.existsSync(safariDirectory)) {
    const projects = fs
      .readdirSync(safariDirectory, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name.endsWith('.xcodeproj'))
    if (projects.length != 1) {
      throw new Error(`Expected exactly one .xcodeproj in safari/, found ${projects.length}`)
    }
    manifests.push('safari/Shared (Extension)/Resources/manifest.json')
    safariProject = path.join(safariDirectory, projects[0].name, 'project.pbxproj')
  }
  const current = readManifest(root, manifests[0], 3).version
  const next = ['patch', 'minor', 'major'].includes(version)
    ? semver.inc(current, version)
    : semver.valid(version)
  if (!next || !/^\d+\.\d+\.\d+$/.test(next) || !semver.gt(next, current)) {
    throw new Error(`Choose patch, minor, major or a numeric version higher than ${current}`)
  }
  const updates = new Map()
  for (const file of manifests) {
    const manifest = readManifest(root, file, 3)
    if (manifest.version != current)
      throw new Error(`Version mismatch in ${file}: ${manifest.version} != ${current}`)
    const absolute = path.resolve(root, file)
    updates.set(
      absolute,
      fs
        .readFileSync(absolute, 'utf8')
        .replace(/("version"\s*:\s*")[^"]+"/, (_, prefix) => `${prefix}${next}"`),
    )
  }
  const options = path.join(root, 'options.html')
  const html = fs.readFileSync(options, 'utf8')
  updates.set(
    options,
    html.replace(/(id=["']version["'][^>]*>)[^<]*/, (_, prefix) => `${prefix}v${next}`),
  )
  if (safariProject) {
    const file = safariProject
    let project = fs.readFileSync(file, 'utf8')
    if (
      !/CURRENT_PROJECT_VERSION = \d+/.test(project) ||
      !/MARKETING_VERSION = [^;]+/.test(project)
    ) {
      throw new Error(`Expected build and marketing versions in ${file}`)
    }
    project = project
      .replace(
        /CURRENT_PROJECT_VERSION = (\d+)/g,
        (_, number) => `CURRENT_PROJECT_VERSION = ${Number(number) + 1}`,
      )
      .replace(/MARKETING_VERSION = [^;]+/g, `MARKETING_VERSION = ${next}`)
    updates.set(file, project)
  }
  // Include already-prepared files in the same validation/write pass.
  const popup = path.join(root, 'browser_action.html')
  if (fs.existsSync(popup))
    updates.set(popup, updates.get(options).replace('<body>', '<body class="browserAction">'))
  const active = path.join(root, 'manifest.json')
  if (fs.existsSync(active)) {
    readManifest(root, 'manifest.json')
    updates.set(
      active,
      fs
        .readFileSync(active, 'utf8')
        .replace(/("version"\s*:\s*")[^"]+"/, (_, prefix) => `${prefix}${next}"`),
    )
  }
  if (!dryRun) for (const [file, content] of updates) fs.writeFileSync(file, content)
  return next
}
