import fs from 'node:fs'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'

import yazl from 'yazl'

import { readTargetManifest } from './manifest.mjs'
import { preparationContents, selectFiles } from './project.mjs'

/**
 * @param {{root: string, config: any}} project
 * @param {{mv?: 2 | 3, dryRun?: boolean, overwrite?: boolean}} [options]
 */
export async function build(project, { mv, dryRun = false, overwrite = false } = {}) {
  const { root, config } = project
  if (!/^[a-z0-9_-]+$/i.test(config.archiveName ?? ''))
    throw new Error('Configure a plain archiveName')
  const archives = []
  for (const version of mv == null ? [2, 3] : [mv]) {
    const manifest = readTargetManifest(root, version)
    if (!/^\d+(?:\.\d+){0,3}$/.test(manifest.version))
      throw new Error(`Invalid extension version: ${manifest.version}`)
    const output = path.resolve(
      root,
      'dist',
      `${config.archiveName}-${manifest.version}.mv${version}.zip`,
    )
    const contents = preparationContents(project, version)
    const files = selectFiles(project, contents)
    archives.push(output)
    if (dryRun) {
      console.log(`Would build ${output}\n${files.join('\n')}`)
      continue
    }
    fs.mkdirSync(path.dirname(output), { recursive: true })
    // Build beside the destination, preserving an existing archive on failure.
    const temporary = fs.mkdtempSync(path.join(path.dirname(output), '.soext-'))
    const archive = path.join(temporary, 'extension.zip')
    const zip = new yazl.ZipFile()
    try {
      const completed = pipeline(zip.outputStream, fs.createWriteStream(archive))
      zip.on('error', (error) => zip.outputStream.destroy(error))
      for (const file of files) {
        if (contents.has(file)) zip.addBuffer(contents.get(file), file)
        else zip.addFile(path.join(root, file), file)
      }
      zip.end()
      await completed
      if (overwrite) fs.copyFileSync(archive, output)
      else fs.copyFileSync(archive, output, fs.constants.COPYFILE_EXCL)
    } finally {
      fs.rmSync(temporary, { recursive: true, force: true })
    }
    console.log(`Built: ${output}`)
  }
  return archives
}
