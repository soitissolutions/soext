import { readdir, readFile, realpath } from 'node:fs/promises'
import { createServer } from 'node:http'
import path from 'node:path'

import { minimatch } from 'minimatch'

import { installOptionsPreviewApi } from './options-preview-api.mjs'
import { whitelistPatterns } from './project.mjs'

const mimeTypes = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
}

function invalid(message) {
  return Object.assign(new Error(message), { status: 400 })
}

/**
 * Serve an extension's real options page with a browser API shim.
 * preview.configure runs on the server to supply project-specific state.
 * @param {{root?: string, config: any}} project
 */
export function createOptionsPreviewServer({ root = process.cwd(), config }) {
  root = path.resolve(root)
  const preview = config.preview ?? {}
  const patterns = whitelistPatterns(config)
  const allowed = (file) => patterns.some((pattern) => minimatch(file, pattern, { dot: true }))

  async function source(file) {
    if (!allowed(file)) throw Object.assign(new Error('Not found'), { status: 404 })
    const resolved = await realpath(path.join(root, file))
    const relative = path.relative(await realpath(root), resolved)
    if (relative == '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw Object.assign(new Error('Not found'), { status: 404 })
    }
    return readFile(resolved)
  }

  async function configuration(params, acceptLanguage) {
    let manifestFile = 'manifest.json'
    try {
      await realpath(path.join(root, manifestFile))
    } catch (error) {
      if (error.code != 'ENOENT') throw error
      manifestFile = 'manifest.mv3.json'
    }
    let manifest = JSON.parse(await readFile(path.join(root, manifestFile), 'utf8'))
    const configured = (await preview.configure?.({ root, params, manifest })) ?? {}
    manifest = configured.manifest ?? manifest
    const defaultLocale = manifest.default_locale ?? 'en'
    const available = (await readdir(path.join(root, '_locales'), { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
    const requested =
      params.get('lang') || acceptLanguage?.split(',')[0]?.split(';')[0] || defaultLocale
    const normalized = requested.replaceAll('-', '_')
    let locale = available.find((name) => name.toLowerCase() == normalized.toLowerCase())
    locale ||= available.find(
      (name) => name.toLowerCase() == normalized.split('_')[0].toLowerCase(),
    )
    if (!locale && params.has('lang'))
      throw invalid(`Unknown locale. Available: ${available.join(', ')}`)
    locale ||= defaultLocale
    const base = JSON.parse(
      await readFile(path.join(root, '_locales', defaultLocale, 'messages.json'), 'utf8'),
    )
    const localized = JSON.parse(
      await readFile(path.join(root, '_locales', locale, 'messages.json'), 'utf8'),
    )
    const overrides = {}
    for (const [key, storageKey] of Object.entries(preview.parameters ?? {})) {
      const value = params.get(key)
      if (value == null) continue
      overrides[storageKey] = value
    }
    const persistent = new Set(['lang', ...Object.keys(preview.parameters ?? {})])
    const urlParams = {
      ...Object.fromEntries([...params].filter(([key]) => persistent.has(key))),
      ...configured.urlParams,
    }
    delete urlParams.reset
    return {
      id: preview.id ?? config.archiveName ?? path.basename(root),
      storageGroup: configured.storageGroup ?? 'default',
      locale,
      manifest,
      messages: { ...base, ...localized },
      reset: params.get('reset') == '1',
      overrides,
      urlParams,
    }
  }

  return createServer(async (request, response) => {
    response.setHeader('Cache-Control', 'no-store')
    response.setHeader('X-Content-Type-Options', 'nosniff')
    try {
      if (!['GET', 'HEAD'].includes(request.method)) {
        response.writeHead(405, { Allow: 'GET, HEAD' }).end()
        return
      }
      const url = new URL(request.url, 'http://options-preview')
      const route = decodeURIComponent(url.pathname).slice(1)
      let content
      let type
      if (route == '__preview/api.js') {
        const runtime = await configuration(url.searchParams, request.headers['accept-language'])
        content = `(${installOptionsPreviewApi.toString()})(window, ${JSON.stringify(runtime)});\n`
        type = mimeTypes['.js']
      } else {
        const file = ['', 'browser_action.html'].includes(route) ? 'options.html' : route
        content = await source(file)
        type = mimeTypes[path.extname(file)] ?? 'application/octet-stream'
        if (path.extname(file) == '.html') {
          await configuration(url.searchParams, request.headers['accept-language'])
          content = content.toString('utf8')
          if (route == 'browser_action.html')
            content = content.replace('<body>', '<body class="browserAction">')
          const shim = `/__preview/api.js${url.search}`
            .replaceAll('&', '&amp;')
            .replaceAll('"', '&quot;')
            .replaceAll('<', '&lt;')
          content = content.replace('<head>', `<head>\n<script src="${shim}"></script>`)
        }
      }
      response.writeHead(200, { 'Content-Type': type })
      response.end(request.method == 'HEAD' ? undefined : content)
    } catch (error) {
      const status =
        error.status ||
        (['ENOENT', 'EISDIR'].includes(error.code) ? 404 : error instanceof URIError ? 400 : 500)
      if (status == 500) console.error('[options preview]', error)
      response.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' })
      response.end(
        status == 500
          ? 'Could not load preview files'
          : status == 404
            ? 'Not found'
            : error.message,
      )
    }
  })
}

export function startOptionsPreview(project, { host = '127.0.0.1', port = 5011 } = {}) {
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid port')
  const server = createOptionsPreviewServer(project)
  server.on('error', (error) => {
    console.error(`[options preview] ${error.message}`)
    process.exitCode = 1
  })
  server.listen(port, host, () => {
    const address = /** @type {import('node:net').AddressInfo} */ (server.address())
    const hostname = host.includes(':') ? `[${host}]` : host
    console.log(
      `Options preview: http://${hostname}:${address.port}/\nPopup layout:    http://${hostname}:${address.port}/browser_action.html`,
    )
  })
  return server
}
