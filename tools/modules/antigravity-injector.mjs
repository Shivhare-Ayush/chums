// tools/modules/antigravity-injector.mjs
// Antigravity Prompt Injector Module for Chums
// Connects to Antigravity Electron Chrome DevTools Protocol (CDP) to inject prompts and auto-send.

import net from 'node:net'
import crypto from 'node:crypto'
import { EventEmitter } from 'node:events'

export const DEFAULT_CDP_PORT = 58710

/**
 * Creates a WebSocket connection to a Chrome DevTools Protocol endpoint.
 * Supports native globalThis.WebSocket when available and falls back to a
 * zero-dependency RFC 6455 client over TCP.
 */
function createCdpWebSocket(wsUrl, timeout = 6000) {
  if (typeof globalThis.WebSocket !== 'undefined') {
    return new Promise((resolve, reject) => {
      let open = false
      const ws = new globalThis.WebSocket(wsUrl)
      const timer = setTimeout(() => {
        try { ws.close() } catch {}
        reject(new Error(`WebSocket connection timeout to ${wsUrl}`))
      }, timeout)

      ws.onopen = () => {
        open = true
        clearTimeout(timer)
        resolve({
          send: (data) => ws.send(typeof data === 'string' ? data : JSON.stringify(data)),
          close: () => { try { ws.close() } catch {} },
          on: (event, handler) => {
            if (event === 'message') {
              ws.onmessage = (e) => {
                try {
                  handler(JSON.parse(e.data))
                } catch {
                  handler(e.data)
                }
              }
            } else if (event === 'close') {
              ws.onclose = handler
            } else if (event === 'error') {
              ws.onerror = handler
            }
          }
        })
      }

      ws.onerror = (e) => {
        clearTimeout(timer)
        if (!open) reject(e)
      }
    })
  }

  // Pure Node RFC 6455 client over net.Socket
  return new Promise((resolve, reject) => {
    const u = new URL(wsUrl)
    const host = u.hostname || '127.0.0.1'
    const port = Number(u.port) || 80
    const path = u.pathname + u.search
    const t = new EventEmitter()
    const c = net.createConnection({ host, port })
    let buf = Buffer.alloc(0)
    let open = false
    let parts = []

    const timer = setTimeout(() => {
      c.destroy()
      reject(new Error(`TCP WebSocket connection timeout to ${wsUrl}`))
    }, timeout)

    const frame = (op, data) => {
      const mask = crypto.randomBytes(4)
      const n = data.length
      const head = n < 126
        ? Buffer.from([0x80 | op, 0x80 | n])
        : n < 65536
          ? Buffer.from([0x80 | op, 0x80 | 126, n >> 8, n & 255])
          : Buffer.concat([
              Buffer.from([0x80 | op, 0x80 | 127]),
              (() => {
                const b = Buffer.alloc(8)
                b.writeBigUInt64BE(BigInt(n))
                return b
              })()
            ])
      const body = Buffer.alloc(n)
      for (let i = 0; i < n; i++) body[i] = data[i] ^ mask[i & 3]
      return Buffer.concat([head, mask, body])
    }

    c.on('connect', () => {
      const key = crypto.randomBytes(16).toString('base64')
      const headers = [
        `GET ${path} HTTP/1.1`,
        `Host: ${host}:${port}`,
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Key: ${key}`,
        'Sec-WebSocket-Version: 13',
        '\r\n'
      ].join('\r\n')
      c.write(headers)
    })

    c.on('data', d => {
      buf = Buffer.concat([buf, d])
      if (!open) {
        const end = buf.indexOf('\r\n\r\n')
        if (end < 0) return
        const status = buf.subarray(0, end).toString().split('\r\n')[0]
        buf = buf.subarray(end + 4)
        clearTimeout(timer)
        if (!/^HTTP\/1\.1 101/.test(status)) {
          c.destroy()
          return reject(new Error(`WebSocket upgrade refused: ${status}`))
        }
        open = true
        resolve(t)
      }
      for (;;) {
        if (buf.length < 2) return
        const fin = buf[0] & 0x80
        const op = buf[0] & 15
        const masked = buf[1] & 0x80
        let n = buf[1] & 127
        let off = 2
        if (n === 126) {
          if (buf.length < 4) return
          n = buf.readUInt16BE(2)
          off = 4
        } else if (n === 127) {
          if (buf.length < 10) return
          n = Number(buf.readBigUInt64BE(2))
          off = 10
        }
        const maskKey = masked ? buf.subarray(off, off + 4) : null
        if (masked) off += 4
        if (buf.length < off + n) return
        let data = Buffer.from(buf.subarray(off, off + n))
        if (maskKey) {
          for (let i = 0; i < n; i++) data[i] ^= maskKey[i & 3]
        }
        buf = buf.subarray(off + n)
        if (op === 8) {
          c.end()
          continue
        }
        if (op === 9) {
          c.write(frame(10, data))
          continue
        }
        if (op === 10) continue
        parts.push(data)
        if (!fin) continue
        const text = Buffer.concat(parts).toString('utf8')
        parts = []
        let m
        try {
          m = JSON.parse(text)
        } catch {
          t.emit('junk', text)
          continue
        }
        t.emit('message', m)
      }
    })

    c.on('error', e => {
      clearTimeout(timer)
      if (!open) reject(e)
    })
    c.on('close', () => {
      clearTimeout(timer)
      if (open) t.emit('close')
    })
    t.send = m => {
      if (!c.destroyed) {
        const payload = typeof m === 'string' ? Buffer.from(m) : Buffer.from(JSON.stringify(m))
        c.write(frame(1, payload))
      }
    }
    t.close = () => {
      try {
        c.write(frame(8, Buffer.alloc(0)))
      } catch {}
      c.end()
    }
  })
}

/**
 * Checks if Antigravity Electron is running with CDP enabled on the target port.
 * @param {number} port
 * @returns {Promise<boolean>}
 */
export async function isDesktopRunning(port = DEFAULT_CDP_PORT) {
  try {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 1500)
    const res = await fetch(`http://127.0.0.1:${port}/json/list`, {
      signal: controller.signal
    })
    clearTimeout(timeout)
    if (!res.ok) return false
    const list = await res.json()
    return Array.isArray(list)
  } catch {
    return false
  }
}

/**
 * Extracts conversation UUID from an Antigravity webview URL.
 * Example URL: "https://127.0.0.1:64163/c/29e9f730-9f1b-4120-87ea-57b5ff9f772f?section=..."
 */
function extractConversationId(url) {
  if (!url || typeof url !== 'string') return null
  const m = url.match(/\/c\/([a-zA-Z0-9_-]+)/)
  return m ? m[1] : null
}

/**
 * Queries CDP targets and returns the currently active conversation page metadata.
 * @param {number} port
 * @returns {Promise<{ id: string, title: string, url: string } | null>}
 */
export async function getActiveConversation(port = DEFAULT_CDP_PORT) {
  try {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 2000)
    const res = await fetch(`http://127.0.0.1:${port}/json/list`, {
      signal: controller.signal
    })
    clearTimeout(timeout)
    if (!res.ok) return null
    const list = await res.json()
    if (!Array.isArray(list)) return null

    const page = list.find(t => t.type === 'page' && t.url && t.url.includes('/c/'))
    if (!page) return null

    const id = extractConversationId(page.url) || page.id
    return {
      id,
      title: page.title || '',
      url: page.url
    }
  } catch {
    return null
  }
}

/**
 * Injects a prompt string into the active or specified Antigravity conversation window.
 *
 * @param {object} options
 * @param {string} [options.conversationId] - Target conversation ID. If omitted, target first active /c/ page.
 * @param {string} options.text - Prompt text to inject.
 * @param {boolean} [options.autoSend=true] - Whether to automatically submit the prompt.
 * @param {number} [options.port=DEFAULT_CDP_PORT] - CDP port (default 58710).
 * @param {number} [options.timeoutMs=8000] - Max polling time for autoSend readiness.
 * @returns {Promise<{ success: boolean, conversationId?: string, error?: string }>}
 */
export async function injectPrompt({
  conversationId,
  text,
  autoSend = true,
  port = DEFAULT_CDP_PORT,
  timeoutMs = 8000
} = {}) {
  if (!text || typeof text !== 'string') {
    return { success: false, error: 'text must be a non-empty string' }
  }

  let ws = null
  let activeConvoId = conversationId || null

  try {
    // 1. Query target list from CDP
    const controller = new AbortController()
    const fetchTimeout = setTimeout(() => controller.abort(), 2500)
    const res = await fetch(`http://127.0.0.1:${port}/json/list`, {
      signal: controller.signal
    })
    clearTimeout(fetchTimeout)

    if (!res.ok) {
      return { success: false, error: `CDP HTTP error: ${res.status}` }
    }

    const list = await res.json()
    if (!Array.isArray(list) || !list.length) {
      return { success: false, error: 'No active Antigravity CDP targets found' }
    }

    // Match page target
    let target = null
    if (conversationId) {
      target = list.find(t => t.type === 'page' && t.url && t.url.includes('/c/') && t.url.includes(conversationId))
    }
    if (!target) {
      target = list.find(t => t.type === 'page' && t.url && t.url.includes('/c/'))
    }

    if (!target || !target.webSocketDebuggerUrl) {
      return { success: false, error: 'No matching Antigravity conversation window found' }
    }

    activeConvoId = extractConversationId(target.url) || target.id

    // 2. Connect via WebSocket
    ws = await createCdpWebSocket(target.webSocketDebuggerUrl, 5000)

    let msgId = 1
    const pending = new Map()

    ws.on('message', m => {
      if (m && m.id && pending.has(m.id)) {
        const p = pending.get(m.id)
        pending.delete(m.id)
        if (p.timer) clearTimeout(p.timer)
        if (m.error) {
          p.reject(new Error(m.error.message || JSON.stringify(m.error)))
        } else {
          p.resolve(m.result)
        }
      }
    })

    function sendCommand(method, params = {}, cmdTimeout = 4000) {
      return new Promise((resolve, reject) => {
        const id = msgId++
        const timer = setTimeout(() => {
          pending.delete(id)
          reject(new Error(`CDP command ${method} timed out after ${cmdTimeout}ms`))
        }, cmdTimeout)
        pending.set(id, { resolve, reject, timer })
        ws.send({ id, method, params })
      })
    }

    // 3. Step 1: Focus input element
    const focusRes = await sendCommand('Runtime.evaluate', {
      expression: `(() => {
        const input = document.querySelector('[aria-label="Message input"]') ||
                      document.querySelector('textarea') ||
                      document.querySelector('[contenteditable="true"]');
        if (!input) return { ok: false, error: 'input_not_found' };
        input.focus();
        return { ok: true, tag: input.tagName };
      })()`,
      returnByValue: true
    })

    // 4. Step 2: Insert prompt text via Input.insertText
    await sendCommand('Input.insertText', { text })

    // 5. Step 3: If autoSend, poll until send button is ready or dispatch Enter
    if (autoSend) {
      const startTime = Date.now()
      let sent = false

      while (Date.now() - startTime < timeoutMs) {
        const checkRes = await sendCommand('Runtime.evaluate', {
          expression: `(() => {
            const cancelBtn = document.querySelector('button[aria-label="Cancel (Ctrl+D)"]') ||
                              document.querySelector('button[aria-label="Stop execution"]');
            const isBusy = !!cancelBtn && cancelBtn.offsetParent !== null;

            const sendBtn = document.querySelector('button[aria-label="Send message"]');
            const canSend = !!sendBtn && !sendBtn.disabled && sendBtn.offsetParent !== null;

            if (!isBusy && canSend) {
              sendBtn.click();
              return { sent: true };
            }
            return { sent: false, isBusy, canSend };
          })()`,
          returnByValue: true
        })

        if (checkRes?.result?.value?.sent) {
          sent = true
          break
        }

        // Wait 300ms before next poll
        await new Promise(r => setTimeout(r, 300))
      }

      // If button was not clickable within timeout, fallback to Enter key event
      if (!sent) {
        await sendCommand('Input.dispatchKeyEvent', {
          type: 'rawKeyDown',
          windowsVirtualKeyCode: 13,
          unmodifiedText: '\r',
          text: '\r',
          key: 'Enter',
          code: 'Enter'
        })
        await sendCommand('Input.dispatchKeyEvent', {
          type: 'keyUp',
          windowsVirtualKeyCode: 13,
          unmodifiedText: '\r',
          text: '\r',
          key: 'Enter',
          code: 'Enter'
        })
      }
    }

    return {
      success: true,
      conversationId: activeConvoId
    }
  } catch (err) {
    return {
      success: false,
      conversationId: activeConvoId,
      error: err.message
    }
  } finally {
    if (ws) {
      try {
        ws.close()
      } catch {}
    }
  }
}

export default {
  DEFAULT_CDP_PORT,
  isDesktopRunning,
  getActiveConversation,
  injectPrompt
}
