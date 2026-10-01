/** Runtime session facts and pre-write validation, resolved from the actual host. */
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const SESSION_PACKAGE = '@deepseek-ai/dsh-session'

/** Only absolute local files are valid runtime anchors (including ASAR in Electron). */
export function sessionModuleUrl(candidate) {
  if (candidate instanceof URL || (typeof candidate === 'string' && candidate.startsWith('file:'))) {
    const url = new URL(candidate)
    if (url.protocol !== 'file:' || url.search || url.hash) throw new TypeError('Session module must be a local file without a query or fragment')
    // Also reject file URLs that are not valid paths on this platform.
    fileURLToPath(url)
    return url.href
  }
  if (typeof candidate !== 'string' || !isAbsolute(candidate)) {
    throw new TypeError('Session module must be an absolute local file path')
  }
  return pathToFileURL(candidate).href
}

/**
 * Select ONE authoritative runtime. Never fall back to this plugin's own peer
 * dependencies or an app.asar.unpacked mirror: either could be a different build.
 * Options are for isolated discovery tests, not additional runtime configuration.
 */
export function sessionModuleCandidates({
  env = process.env,
  hostEntry = process.argv[1],
  electron = Boolean(process.versions.electron),
  resourcesPath = process.resourcesPath,
  execPath = process.execPath,
  platform = process.platform,
} = {}) {
  // Even an empty/invalid explicit override must fail closed, without discovery.
  if (env.DSH_SESSION_MODULE !== undefined) return [sessionModuleUrl(env.DSH_SESSION_MODULE)]
  if (hostEntry) {
    try {
      return [createRequire(sessionModuleUrl(hostEntry)).resolve(SESSION_PACKAGE)]
    } catch { /* the Electron install anchor below is the only fallback */ }
  }
  // Standard Node has no implicit ASAR support. It must resolve from its actual
  // entry point (or use an explicit offline override); never guess another install.
  if (!electron) return []
  let resources = resourcesPath
  if (typeof resources !== 'string' || !isAbsolute(resources)) {
    if (typeof execPath !== 'string' || !isAbsolute(execPath)) return []
    resources = platform === 'darwin'
      ? resolve(dirname(execPath), '..', 'Resources')
      : join(dirname(execPath), 'resources')
  }
  // Electron packaged and unpackaged layouts within the current installation.
  // Once an installed root is found, missing/broken validators are fatal rather
  // than permission to try a second runtime. No drive letters are assumed.
  for (const app of ['app.asar', 'app']) {
    const anchor = join(resources, app, 'dsh', 'package.json')
    if (!existsSync(anchor)) continue
    return [createRequire(pathToFileURL(anchor)).resolve(SESSION_PACKAGE)]
  }
  return []
}

let runtimePromise
/**
 * Load the host's real validators. Cache success AND failure for this activation.
 * Offline runtime tests explicitly select a previously verified installation.
 */
export function sessionRuntime() {
  if (runtimePromise === undefined) {
    runtimePromise = (async () => {
      try {
        const [candidate] = sessionModuleCandidates()
        if (!candidate) throw new Error('No session runtime resolved from the host entry or current Electron installation')
        const url = sessionModuleUrl(candidate)
        const module = await import(url)
        if (module.SESSION_FORMAT_VERSION !== 4
          || typeof module.adoptSessionEvent !== 'function'
          || typeof module.foldSurface !== 'function') {
          throw new Error('This plugin requires the V4 session contract')
        }
        const require = createRequire(url)
        const codecUrl = pathToFileURL(require.resolve('@deepseek-ai/dsh-session-format-v3-to-v4')).href
        const { releasedV4SessionFormatCodec } = await import(codecUrl)
        if (typeof releasedV4SessionFormatCodec?.encodeEvent !== 'function') throw new Error('V4 persistence validator is unavailable')
        return {
          ...module,
          moduleUrl: url,
          validateEvent(event) {
            module.adoptSessionEvent(event)
            // Session.append validates surface transitions but not the entire
            // released payload vocabulary. The disk codec is a separate gate.
            releasedV4SessionFormatCodec.encodeEvent(event)
            return event
          },
        }
      } catch (cause) {
        const error = new Error('无法加载当前宿主的 V4 会话校验器，已拒绝写入（未改动会话）。' + String(cause?.message ?? cause), { cause })
        error.code = 'session-runtime-unavailable'
        throw error
      }
    })()
  }
  return runtimePromise
}

export async function sessionFormatVersion() {
  return (await sessionRuntime()).SESSION_FORMAT_VERSION
}

/** Historical shape helper. New writes only use the validated runtime version. */
export function replaceSurfaceOp(start, end, version = 4) {
  return Number.isFinite(version) && version >= 3
    ? { op: 'replace', startSeq: start, endSeq: end }
    : { op: 'replace', start, end }
}

/** Decode either historical spelling without treating sequence values as positions. */
export function spanRangeOf(surfaceOp) {
  if (surfaceOp === null || typeof surfaceOp !== 'object' || surfaceOp.op !== 'replace') return null
  const start = surfaceOp.startSeq ?? surfaceOp.start
  const end = surfaceOp.endSeq ?? surfaceOp.end
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)) return null
  return { start, end }
}
