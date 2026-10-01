/**
 * Best-effort, bounded diagnostics. Never write into the installed package,
 * which may be read-only or inside ASAR. These breadcrumbs are not session state.
 */
import { closeSync, fstatSync, ftruncateSync, mkdirSync, openSync, writeSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

/** Single-file cap; on rollover the next event starts a fresh diagnostic log. */
export const BREADCRUMB_MAX_BYTES = 256 * 1024
/** Drop oversized payloads, not half a JSON/UTF-8 line. */
export const BREADCRUMB_MAX_LINE_BYTES = 8 * 1024

function expandHome(value) {
  if (value === '~') return homedir()
  return value.startsWith('~/') || value.startsWith('~\\') ? join(homedir(), value.slice(2)) : value
}

function diagnosticFile() {
  try {
    // Preserve the existing override, including an empty value (disable logging).
    const override = process.env.DSH_RESEND_BREADCRUMB
    if (override !== undefined) return override === '' ? '' : resolve(override)
    const configured = [process.env.DSH_HOME, process.env.DSH_PROFILE_DIR]
      .find((value) => typeof value === 'string' && value.trim().length > 0)
    const home = configured === undefined ? join(homedir(), '.dsh') : expandHome(configured)
    return resolve(home, 'logs', 'dsh-resend', 'breadcrumbs.jsonl')
  } catch {
    return '' // A missing home must not prevent plugin activation.
  }
}

/** Absolute diagnostic destination (empty when disabled/unresolvable). */
export const BREADCRUMB_FILE = diagnosticFile()

/** Append one small JSONL event. Failure must never affect a session operation. */
export function breadcrumb(half, event, data = {}) {
  if (!BREADCRUMB_FILE) return
  let fd
  try {
    const t = new Date().toISOString()
    let line = JSON.stringify({ t, half, event, ...data }) + '\n'
    if (Buffer.byteLength(line) > BREADCRUMB_MAX_LINE_BYTES) {
      line = JSON.stringify({ t, half: String(half).slice(0, 32), event: String(event).slice(0, 300), truncated: true }) + '\n'
    }
    const bytes = Buffer.from(line, 'utf8')
    mkdirSync(dirname(BREADCRUMB_FILE), { recursive: true, mode: 0o700 })
    fd = openSync(BREADCRUMB_FILE, 'a', 0o600)
    const stat = fstatSync(fd)
    if (!stat.isFile()) return
    // Synchronous writes are ordered within a host. Multiple separate hosts
    // sharing one override remain best-effort, not a cross-process log database.
    if (stat.size + bytes.length > BREADCRUMB_MAX_BYTES) {
      // Windows append-only handles cannot be truncated (EPERM). Reopen the
      // existing file for read/write, proving it is still the same regular file
      // before truncating. No rename, sibling deletion or package writes.
      closeSync(fd)
      fd = undefined
      fd = openSync(BREADCRUMB_FILE, 'r+')
      const current = fstatSync(fd)
      if (!current.isFile() || current.dev !== stat.dev || current.ino !== stat.ino) return
      ftruncateSync(fd, 0)
    }
    writeSync(fd, bytes)
  } catch {
    /* diagnostics are best-effort */
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd) } catch { /* diagnostics are best-effort */ }
    }
  }
}
