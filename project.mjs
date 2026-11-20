import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import { globSync } from 'glob'
import { minimatch } from 'minimatch'

import { readTargetManifest } from './manifest.mjs'

export async function loadProject(root = process.cwd()) {
  root = path.resolve(root)
  const { default: config } = await import(pathToFileURL(path.join(root, 'soext.config.mjs')).href)
  return { root, config }
}

function popupHtml(root) {
  const html = fs.readFileSync(path.join(root, 'options.html'), 'utf8')
  if (!html.includes('<body>')) throw new Error('Expected <body> in options.html')
  return html.replace('<body>', '<body class="browserAction">')
}

export function createPopup({ root = process.cwd(), dryRun = false } = {}) {
  const html = popupHtml(root)
  const file = path.join(root, 'browser_action.html')
  if (!dryRun) fs.writeFileSync(file, html)
  return file
}

export function preparationFiles({ root }, mv) {
  const files = new Map()
  // Retain CPFT's convention for other manifest-specific root files.
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.includes(`.mv${mv}.`) && !entry.name.startsWith('manifest.')) {
      files.set(entry.name.replace(`.mv${mv}.`, '.'), entry.name)
    }
  }
  return files
}

export function preparationContents(project, mv) {
  const { root } = project
  const manifest = readTargetManifest(root, mv)
  const contents = new Map(
    [...preparationFiles(project, mv)].map(([destination, source]) => [
      destination,
      fs.readFileSync(path.resolve(root, source)),
    ]),
  )
  contents.set('manifest.json', Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`))
  contents.set('browser_action.html', Buffer.from(popupHtml(root)))
  return contents
}

export function prepare(project, mv, { dryRun = false } = {}) {
  const contents = preparationContents(project, mv)
  if (!dryRun) {
    for (const [destination, content] of contents)
      fs.writeFileSync(path.join(project.root, destination), content)
  }
  return [...contents.keys()]
}

export function clean(project, { dryRun = false } = {}) {
  const files = new Set(['manifest.json', 'browser_action.html'])
  for (const mv of [2, 3]) {
    for (const file of preparationFiles(project, mv).keys()) files.add(file)
  }
  const existing = [...files].filter((file) => fs.existsSync(path.join(project.root, file)))
  if (!dryRun) {
    for (const file of existing) fs.rmSync(path.join(project.root, file))
  }
  return existing
}

export function whitelistPatterns(config) {
  if (!Array.isArray(config.files) || !config.files.length)
    throw new Error('Configure an explicit files whitelist')
  for (const pattern of config.files) {
    if (
      typeof pattern != 'string' ||
      !pattern ||
      pattern.startsWith('!') ||
      path.isAbsolute(pattern) ||
      pattern.split(/[\\/]/).includes('..')
    ) {
      throw new Error(`Invalid whitelist pattern: ${pattern}`)
    }
  }
  return config.files
}

export function selectFiles({ root, config }, generated = new Map()) {
  const files = new Set()
  const realRoot = fs.realpathSync(root)
  for (const pattern of whitelistPatterns(config)) {
    const matches = [
      ...new Set([
        ...globSync(pattern, { cwd: root, nodir: true, dot: true, follow: false }),
        ...[...generated.keys()].filter((file) => minimatch(file, pattern, { dot: true })),
      ]),
    ]
    if (!matches.length) throw new Error(`Whitelist entry matches no files: ${pattern}`)
    for (const file of matches) {
      const relative = generated.has(file)
        ? file
        : path.relative(realRoot, fs.realpathSync(path.join(root, file)))
      if (relative.startsWith(`..${path.sep}`) || relative == '..' || path.isAbsolute(relative)) {
        throw new Error(`Whitelisted file is outside the extension: ${file}`)
      }
      files.add(file.split(path.sep).join('/'))
    }
  }
  if (!files.has('manifest.json')) throw new Error('Whitelist must include manifest.json')
  return [...files].sort()
}
