/**
 * dsh-resend desktop/web client, delivered as a classic ModuleLoader script.
 *
 * Identity comes from uiConversation.binding(sessionId).target('chat'), keyed by
 * the renderer's data-chat-node-key. Neither turn numbers nor React internals
 * are message seqs. All DOM additions are owned and reversible; session logs and
 * the Trajectory view remain untouched by presentation changes.
 */
window.__ModuleLoader__.load({
  id: 'dsh-resend',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports

    const ROUTE = '/api/plugins/resend'
    const COPY_LABELS = new Set(['复制', 'Copy', '拷贝', '已复制', 'Copied'])
    const MESSAGE_KINDS = new Set(['user', 'steering', 'assistant-step', 'turn-tail'])
    const BUSY = '助手正在回复中：先等它结束（或点停止），再使用这个功能'
    const UNAVAILABLE = '无法安全定位这条消息，请重新加载桌面窗口后再试'
    const OLD_HOST = '宿主尚未加载新版 dsh-resend，请重载插件或重启桌面端后再试；本次未修改消息。'
    const REGENERATE_ICON = '<svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M13.5 8a5.5 5.5 0 1 1-1.9-4.16"/><path d="M13.7 1.9v3.4h-3.4"/></svg>'
    const EDIT_ICON = '<svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M11.3 2.1 13.9 4.7 5.4 13.9 2.1 13.9 2.8 10.6z"/></svg>'
    const STYLE = `
[data-dsh-resend-hidden="1"]{display:none!important}
[data-dsh-resend-original="1"]>:not([data-dsh-resend="edited"]){display:none!important}
[data-dsh-resend="edited"]{color:inherit;overflow-wrap:anywhere}
[data-dsh-resend="edited-label"]{font-size:12px;color:var(--dsw-alias-label-tertiary,#888);margin:4px 0}
[data-dsh-resend="edited-text"]{white-space:pre-wrap;line-height:1.65}
[data-dsh-resend="panel"]{position:fixed;inset:0;z-index:2147483000;align-items:center;justify-content:center;background:rgba(0,0,0,.32)}
[data-dsh-resend="panel"][hidden]{display:none}
[data-dsh-resend="panel"]:not([hidden]){display:flex}
[data-dsh-resend="card"]{width:min(680px,92vw);max-height:82vh;overflow:auto;display:flex;flex-direction:column;gap:12px;padding:20px;border-radius:14px;background:var(--dsw-alias-bg-elevated,#fff);color:var(--dsw-alias-label-primary,#111);box-shadow:0 18px 48px rgba(0,0,0,.28);font-size:14px}
[data-dsh-resend="panel"] textarea{box-sizing:border-box;width:100%;min-height:180px;resize:vertical;padding:10px 12px;border:1px solid var(--dsw-alias-border-l2,#bbb);border-radius:8px;background:var(--dsw-alias-bg-base,transparent);color:inherit;font:inherit;line-height:1.5}
[data-dsh-resend="panel"] button{padding:7px 14px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2,#bbb);background:transparent;color:inherit;cursor:pointer;font:inherit}
[data-dsh-resend="panel"] button:disabled{opacity:.5;cursor:default}
[data-dsh-resend="confirm"]{background:var(--dsw-alias-brand-primary,#4d6bfe)!important;color:#fff!important;border-color:transparent!important}
`

    function beacon(event, data) {
      try {
        const query = new URLSearchParams({ message: event, data: JSON.stringify(data ?? {}).slice(0, 600) })
        void fetch(`${ROUTE}/beacon?${query}`, { method: 'GET' }).catch(() => {})
      } catch { /* diagnostics must never prevent boot */ }
    }

    // Optional renderer imports are isolated: no absent module can break boot.
    function optional(name) { try { return require(name) } catch { return {} } }

    function apply(ctx) {
      beacon('apply-enter', { version: 2, identity: 'conversation-snapshot' })
      const React = optional('react')
      const ReactDOM = optional('react-dom/client')
      const primitives = optional('@deepseek-ai/dsh-client-ui-primitives')
      ctx.effect(() => {
        let alive = true
        let scheduled = null
        let mainId = null
        let services = null
        let installed = false
        let editor = null
        const records = new Map()
        const locks = new Set()
        const disposers = []
        const controllers = new Set()
        const overlays = new Map()
        const ownedButtons = new Set()
        const style = document.createElement('style')
        style.dataset.dshResend = 'style'
        style.textContent = STYLE
        document.head.appendChild(style)

        function schedule() {
          if (!alive || scheduled !== null) return
          scheduled = setTimeout(() => {
            scheduled = null
            if (!alive) return
            try { paint() } catch (error) { beacon('paint-failed', { message: String(error?.message ?? error) }) }
          }, 0)
        }

        async function call(op, payload) {
          const controller = new AbortController()
          controllers.add(controller)
          const timeout = setTimeout(() => controller.abort(), 30000)
          try {
            const response = await fetch(`${ROUTE}/${op}`, {
              method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(payload), signal: controller.signal,
            })
            let result
            try { result = await response.json() } catch { /* checked below */ }
            if (!response.ok || result?.ok !== true) {
              const error = new Error(result?.error?.code === 'unknown-op' ? OLD_HOST : result?.error?.message ?? `操作失败 (HTTP ${response.status})`)
              error.code = result?.error?.code ?? `http-${response.status}`
              throw error
            }
            return result.value
          } catch (error) {
            if (controller.signal.aborted && alive) throw new Error('请求已超时，请先确认操作状态再重试；不会继续锁住输入框。')
            throw error
          } finally {
            clearTimeout(timeout)
            controllers.delete(controller)
          }
        }

        function outerFlow(element) {
          let root = element.closest('[data-chat-flow]')
          if (!root) return null
          for (let parent = root.parentElement?.closest('[data-chat-flow]'); parent; parent = root.parentElement?.closest('[data-chat-flow]')) root = parent
          return root
        }
        function roots() {
          return [...document.querySelectorAll('[data-chat-flow]')].filter((root) => !root.parentElement?.closest('[data-chat-flow]'))
        }
        function scopedSession(root) {
          // ConversationContent supplies this attribute for BOTH the main view
          // and embedded child-session panes, even before any reply completes.
          // Never infer it from the selected session or from a node-key prefix.
          return root.closest('[data-conversation-session]')?.getAttribute('data-conversation-session') || null
        }
        function recordFor(sessionId) {
          if (!sessionId || !services) return null
          let record = records.get(sessionId)
          const owner = services.sessions.binding(sessionId)
          if (!owner) { record?.dispose(); return null }
          if (record?.owner === owner) return record
          if (record) record.dispose()
          const conversation = services.uiConversation.binding(sessionId)
          const source = conversation.target('chat')
          record = { sessionId, owner, source, marks: [], ready: false, pending: null, dirty: false, dispose: () => {} }
          records.set(sessionId, record)
          const offChat = source.subscribe(schedule)
          const offFeed = owner.eventSource?.subscribe(() => {
            const change = owner.eventSource.getSnapshot()?.change
            const entries = change?.entries ?? []
            if (change?.kind === 'replace' || change?.kind === 'prepend' || entries.some((event) => event.type === 'compaction/prune' || event.surfaceOp?.op === 'replace')) void refreshMarks(record)
          })
          const offSession = owner.session?.subscribe(schedule)
          let disposed = false
          let offOwner
          record.dispose = () => {
            if (disposed) return
            disposed = true
            offChat?.(); offFeed?.(); offSession?.()
            if (records.get(sessionId) === record) records.delete(sessionId)
            if (typeof offOwner === 'function') offOwner()
          }
          if (typeof owner.ctx?.effect === 'function') offOwner = owner.ctx.effect(() => () => record.dispose(), 'dsh-resend: borrowed session generation')
          void refreshMarks(record)
          return record
        }
        async function refreshMarks(record) {
          if (!alive || !record) return
          if (record.pending) { record.dirty = true; return record.pending }
          record.pending = (async () => {
            do {
              record.dirty = false
              try {
                const value = await call('marks', { sessionId: record.sessionId })
                if (!alive || records.get(record.sessionId) !== record) return
                // Older hosts have ranges only. Do not guess seqs from numeric
                // intervals or permit mutation with a known-broken old handler.
                record.ready = Array.isArray(value?.markers)
                record.marks = record.ready ? value.markers : []
                schedule()
              } catch (error) {
                beacon('marks-failed', { message: String(error?.message ?? error) })
                record.dirty = false
              }
            } while (alive && record.dirty)
          })().finally(() => { record.pending = null })
          return record.pending
        }
        function nodeIdentity(node, sessionId) {
          if (!node || !MESSAGE_KINDS.has(node.kind)) return null
          const final = node.kind === 'turn-tail' ? node.data?.closing?.finalNode : node.data?.finalNode
          const seq = final?.seq ?? node.data?.seq ?? node.anchorSeq
          if (!Number.isSafeInteger(seq) || seq < 0) return null
          if (node.kind === 'turn-tail' && !final) return null
          return {
            sessionId, seq,
            ...(typeof final?.messageId === 'string' ? { messageId: final.messageId } : typeof node.data?.messageId === 'string' ? { messageId: node.data.messageId } : {}),
            kind: node.kind === 'user' || node.kind === 'steering' ? 'user' : 'assistant',
          }
        }
        function identityOf(element) {
          const flow = element.closest('[data-chat-node-key]')
          const root = outerFlow(element)
          if (!root || !flow) return null
          const sid = scopedSession(root)
          const record = recordFor(sid)
          const node = record?.source.getSnapshot()?.nodes?.get(flow.getAttribute('data-chat-node-key'))
          return nodeIdentity(node, sid)
        }
        function running(sid) {
          const record = records.get(sid)
          const state = record?.owner.session?.getSnapshot()
          if (typeof state?.running === 'boolean') return state.running
          return services?.uiSession.sessionStatus?.getSnapshot()?.get(sid)?.running === true
        }
        function unavailable(identity) {
          if (!identity) return UNAVAILABLE
          if (locks.has(identity.sessionId)) return '此会话正在处理编辑或重新生成，请稍候'
          if (running(identity.sessionId)) return BUSY
          return ''
        }
        async function inspect(identity) {
          const value = await call('inspect', identity)
          if (!value || value.kind !== identity.kind || value.targetSeq !== identity.seq || typeof value.text !== 'string') throw new Error('宿主返回的消息与目标不一致；本次未修改消息。')
          if (value.active !== true) throw new Error('这条消息已被替换或压缩，历史记录只读。')
          return value
        }

        function openEditor(identity, text, trigger) {
          if (editor) editor.remove()
          const root = document.createElement('div')
          root.dataset.dshResend = 'panel'
          root.dataset.open = '1'
          root.setAttribute('role', 'dialog')
          root.setAttribute('aria-modal', 'true')
          root.setAttribute('aria-label', identity.kind === 'assistant' ? '编辑回复内容' : '编辑后重发')
          const card = document.createElement('div')
          card.dataset.dshResend = 'card'
          const title = document.createElement('strong')
          title.textContent = identity.kind === 'assistant' ? '编辑回复内容' : '编辑后重发'
          const hint = document.createElement('div')
          hint.textContent = identity.kind === 'assistant'
            ? '只替换这条回复，不重发。修改作为用户编辑说明进入上下文，其他消息保持不变。'
            : '保存后隐藏原来的这一轮，并使用修改后的提问重新生成。'
          const input = document.createElement('textarea')
          input.setAttribute('aria-label', '消息原文')
          input.value = text
          const status = document.createElement('div')
          status.setAttribute('role', 'status')
          status.style.cssText = 'min-height:18px;color:#c0392b'
          const actions = document.createElement('div')
          actions.style.cssText = 'display:flex;justify-content:flex-end;gap:8px'
          const cancel = document.createElement('button')
          cancel.type = 'button'; cancel.textContent = '取消'
          const confirm = document.createElement('button')
          confirm.type = 'button'; confirm.dataset.dshResend = 'confirm'
          confirm.textContent = identity.kind === 'assistant' ? '保存修改' : '确认并重新生成'
          let saving = false
          const close = () => {
            if (saving) return
            root.remove()
            if (editor === root) editor = null
            if (trigger?.isConnected) trigger.focus()
          }
          root._close = close
          cancel.addEventListener('click', close)
          root.addEventListener('mousedown', (event) => { if (event.target === root) close() })
          root.addEventListener('keydown', (event) => {
            if (event.key === 'Escape') { event.preventDefault(); close() }
            if (event.key === 'Tab') {
              const focusable = [input, cancel, confirm].filter((el) => !el.disabled)
              if (event.shiftKey && document.activeElement === focusable[0]) { event.preventDefault(); focusable.at(-1)?.focus() }
              if (!event.shiftKey && document.activeElement === focusable.at(-1)) { event.preventDefault(); focusable[0]?.focus() }
            }
          })
          confirm.addEventListener('click', async () => {
            if (saving) return
            if (!input.value.trim()) { status.textContent = '内容不能为空。'; return }
            const reason = unavailable(identity)
            if (reason) { status.textContent = reason; return }
            saving = true; locks.add(identity.sessionId)
            input.disabled = cancel.disabled = confirm.disabled = true
            status.textContent = '处理中…'; schedule()
            try {
              // Revalidate the same immutable identity, not the currently selected
              // session, in case selection/history changed while editing.
              await inspect(identity)
              if (!alive || editor !== root || !root.isConnected) return
              if (!trigger?.isConnected || identityOf(trigger)?.sessionId !== identity.sessionId) throw new Error('会话视图已切换，未保存修改。')
              if (running(identity.sessionId)) throw new Error(BUSY)
              await call(identity.kind === 'assistant' ? 'editReply' : 'editAndResend', { ...identity, text: input.value })
              await refreshMarks(recordFor(identity.sessionId))
              saving = false; close()
            } catch (error) {
              if (alive) status.textContent = String(error?.message ?? error)
            } finally {
              saving = false; locks.delete(identity.sessionId)
              input.disabled = cancel.disabled = confirm.disabled = false
              schedule()
            }
          })
          actions.append(cancel, confirm)
          card.append(title, hint, input, status, actions)
          root.appendChild(card); document.body.appendChild(root)
          editor = root; input.focus(); input.setSelectionRange(input.value.length, input.value.length)
        }

        function anchorIn(strip) {
          const native = [...strip.children].filter((el) => el.tagName === 'BUTTON' && !el.hasAttribute('data-dsh-resend'))
          return native.find((el) => /分支|branch/i.test(el.getAttribute('aria-label') ?? '')) ?? native.at(-1) ?? null
        }
        function graft(strip) {
          const kind = strip.closest('[data-chat-flow-kind]')?.getAttribute('data-chat-flow-kind')
          if (!strip.matches('[data-clock="start"],[data-clock="end"]') || !MESSAGE_KINDS.has(kind) || strip.closest('[class*="dsh-rt-"]') || strip.closest('[data-dsh-resend="edited"]')) return
          const anchor = anchorIn(strip)
          if (!anchor) return
          let buttons = [...strip.children].filter((el) => el.matches('button[data-dsh-resend="regenerate"],button[data-dsh-resend="edit"]'))
          if (buttons.length !== 2) {
            for (const button of buttons) button.remove()
            buttons = ['regenerate', 'edit'].map((op) => {
              const button = document.createElement('button')
              ownedButtons.add(button)
              button.type = 'button'; button.className = anchor.className
              button.dataset.dshResend = op
              button.setAttribute('aria-label', op === 'edit' ? '编辑' : '重新生成')
              button.innerHTML = op === 'edit' ? EDIT_ICON : REGENERATE_ICON
              button.addEventListener('click', async (event) => {
                event.preventDefault(); event.stopPropagation()
                const identity = identityOf(strip)
                const reason = unavailable(identity)
                if (reason) { window.alert(reason); return }
                locks.add(identity.sessionId); schedule()
                try {
                  const message = await inspect(identity)
                  if (!alive || !button.isConnected || identityOf(button)?.sessionId !== identity.sessionId) return
                  if (op === 'edit') openEditor(identity, message.text, button)
                  else {
                    if (running(identity.sessionId)) throw new Error(BUSY)
                    await call(identity.kind === 'user' ? 'regenerateFromPrompt' : 'regenerate', identity)
                    await refreshMarks(recordFor(identity.sessionId))
                  }
                } catch (error) {
                  if (alive) window.alert(String(error?.message ?? error))
                } finally { locks.delete(identity.sessionId); schedule() }
              })
              return button
            })
          }
          if (anchor.nextSibling !== buttons[0] || buttons[0].nextSibling !== buttons[1]) anchor.after(...buttons)
          const reason = unavailable(identityOf(strip))
          for (const button of buttons) {
            button.disabled = Boolean(reason)
            button.title = reason || button.getAttribute('aria-label')
          }
        }

        function nodeSeq(node) {
          return node.kind === 'turn-tail' ? node.data?.closing?.finalNode?.seq
            : node.kind === 'assistant-step' ? node.data?.finalNode?.seq ?? node.anchorSeq
            : node.kind === 'tool-call' ? node.data?.root?.seq ?? node.anchorSeq
            : node.data?.seq ?? node.anchorSeq
        }
        function turnOf(node) {
          return node.location?.kind === 'turn' || node.location?.kind === 'step' ? node.location.turn.turn : undefined
        }
        function presentation(record, nodes) {
          const markers = record.marks
          const bySeq = new Map(markers.map((marker) => [marker.replacementSeq, marker]))
          const hidden = new Set()
          const chrome = new Set()
          const edits = new Map()
          function shadow(seq) {
            if (!Number.isSafeInteger(seq) || hidden.has(seq)) return
            hidden.add(seq)
            const marker = bySeq.get(seq)
            if (marker?.kind === 'editReply') shadow(marker.targetSeq)
            for (const old of marker?.shadowedSeqs ?? []) shadow(old)
          }
          for (const marker of markers) {
            if (Number.isSafeInteger(marker.auditSeq)) chrome.add(marker.auditSeq)
            if (Number.isSafeInteger(marker.replacementSeq)) chrome.add(marker.replacementSeq)
            if (marker.kind === 'editReply') {
              if (typeof marker.editedText === 'string') {
                const previous = edits.get(marker.targetSeq)
                if (!previous || previous.replacementSeq < marker.replacementSeq) edits.set(marker.targetSeq, marker)
              }
            } else for (const seq of marker.shadowedSeqs ?? []) shadow(seq)
          }
          const hiddenTurns = new Set()
          for (const node of nodes.values()) {
            if (node.kind !== 'user' || !hidden.has(nodeSeq(node))) continue
            const turn = turnOf(node)
            // A steering-only replacement must not hide an earlier still-live
            // question sharing the same runtime Turn.
            if (turn !== undefined && ![...nodes.values()].some((other) => (other.kind === 'user' || other.kind === 'steering') && turnOf(other) === turn && !hidden.has(nodeSeq(other)))) hiddenTurns.add(turn)
          }
          for (const seq of hidden) edits.delete(seq)
          return { hidden, chrome, edits, hiddenTurns }
        }
        function setHidden(element, hidden) {
          if (hidden) { if (element.dataset.dshResendHidden !== '1') element.dataset.dshResendHidden = '1' }
          else element.removeAttribute('data-dsh-resend-hidden')
        }
        function clearOverlay(row) {
          const overlay = overlays.get(row)
          if (!overlay) return
          overlay.reactRoot?.unmount()
          overlay.element.remove()
          row.removeAttribute('data-dsh-resend-original')
          overlays.delete(row)
        }
        function showEdit(row, marker) {
          let overlay = overlays.get(row)
          if (overlay && overlay.seq === marker.replacementSeq && overlay.element.parentElement === row) return
          clearOverlay(row)
          const element = document.createElement('div')
          element.setAttribute('data-dsh-resend', 'edited')
          const label = document.createElement('div')
          label.dataset.dshResend = 'edited-label'; label.textContent = '已编辑 · 仅替换此条回复'
          const text = document.createElement('div')
          text.dataset.dshResend = 'edited-text'
          element.append(label, text); row.appendChild(element)
          let reactRoot
          if (typeof React.createElement === 'function' && typeof ReactDOM.createRoot === 'function' && primitives.MarkdownText) {
            reactRoot = ReactDOM.createRoot(text)
            reactRoot.render(React.createElement(primitives.MarkdownText, { text: marker.editedText }))
            text.style.whiteSpace = 'normal'
          } else text.textContent = marker.editedText
          row.dataset.dshResendOriginal = '1'
          overlays.set(row, { seq: marker.replacementSeq, element, reactRoot })
        }
        function paint() {
          const editedRows = new Set()
          const visited = new Set()
          let mapped = 0
          for (const root of roots()) {
            const record = recordFor(scopedSession(root))
            const nodes = record?.source.getSnapshot()?.nodes
            const plan = nodes ? presentation(record, nodes) : null
            for (const row of root.querySelectorAll('[data-chat-node-key]')) {
              visited.add(row)
              const node = nodes?.get(row.getAttribute('data-chat-node-key'))
              if (!node || !plan) { setHidden(row, false); continue }
              mapped++
              const seq = nodeSeq(node)
              const hidden = plan.hidden.has(seq) || plan.chrome.has(seq) || plan.hiddenTurns.has(turnOf(node))
              setHidden(row, hidden)
              const edit = !hidden && node.kind === 'assistant-step' && row.getAttribute('data-chat-group-part') !== 'reasoning' ? plan.edits.get(seq) : null
              if (edit) { showEdit(row, edit); editedRows.add(row) }
            }
            for (const group of root.querySelectorAll('[data-chat-group-key]')) {
              visited.add(group)
              const members = [...group.querySelectorAll('[data-chat-node-key]')]
              setHidden(group, members.length > 0 && members.every((row) => row.dataset.dshResendHidden === '1'))
            }
          }
          for (const [row] of overlays) if (!editedRows.has(row)) clearOverlay(row)
          for (const element of document.querySelectorAll('[data-dsh-resend-hidden]')) if (!visited.has(element)) setHidden(element, false)
          const strips = new Set()
          for (const button of document.querySelectorAll('button[aria-label]')) {
            if (COPY_LABELS.has(button.getAttribute('aria-label')) && button.parentElement) strips.add(button.parentElement)
          }
          for (const button of document.querySelectorAll('button[data-dsh-resend="regenerate"]')) if (button.parentElement) strips.add(button.parentElement)
          for (const strip of strips) graft(strip)
          const actionKinds = {}
          for (const strip of strips) {
            if (!strip.matches('[data-clock]')) continue
            const kind = strip.closest('[data-chat-flow-kind]')?.getAttribute('data-chat-flow-kind') ?? 'outside-chat'
            actionKinds[kind] = (actionKinds[kind] ?? 0) + 1
          }
          const sessionIds = roots().map(scopedSession)
          const signature = JSON.stringify([sessionIds, actionKinds])
          if (paint.reported !== signature && mapped > 0) {
            paint.reported = signature
            beacon('active', { mappedRows: mapped, actionRows: strips.size, actionKinds, sessions: sessionIds, identity: 'conversation-snapshot' })
          }
        }

        const onCopy = (event) => {
          const button = event.target.closest?.('button[aria-label]')
          if (!button || !COPY_LABELS.has(button.getAttribute('aria-label')) || button.closest('[data-dsh-resend="edited"]') || !button.parentElement?.matches('[data-clock="start"],[data-clock="end"]')) return
          const identity = identityOf(button)
          if (identity?.kind !== 'assistant') return
          const record = records.get(identity.sessionId)
          const nodes = record?.source.getSnapshot()?.nodes
          const marker = nodes ? presentation(record, nodes).edits.get(identity.seq) : null
          if (!marker) return
          event.preventDefault(); event.stopImmediatePropagation()
          const copy = typeof primitives.writeClipboard === 'function' ? primitives.writeClipboard(marker.editedText)
            : typeof window.navigator.clipboard?.writeText === 'function' ? window.navigator.clipboard.writeText(marker.editedText).then(() => true) : Promise.resolve(false)
          Promise.resolve(copy).then((ok) => {
            if (ok === false && alive) window.alert('复制失败，请从编辑框中复制原文。')
          }, () => { if (alive) window.alert('复制失败，请从编辑框中复制原文。') })
        }
        document.addEventListener('click', onCopy, true)
        const observer = new MutationObserver((changes) => {
          if (changes.some((change) => change.type === 'attributes' || [...change.addedNodes, ...change.removedNodes].some((node) => node.nodeType === 1 && !node.hasAttribute?.('data-dsh-resend')))) schedule()
        })
        observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['aria-label', 'data-chat-node-key', 'data-chat-group-part', 'data-conversation-session'] })

        function install(child) {
          if (!alive || installed) return
          const get = (name) => child.get?.(name) ?? child[name]
          const next = { uiSession: get('uiSession'), uiConversation: get('uiConversation'), sessions: get('sessions') }
          const current = next.uiSession?.adapter?.current
          if (!current?.getSnapshot || !next.uiConversation?.binding || !next.sessions?.binding) return
          installed = true; services = next
          const mount = () => {
            const update = () => {
              const sid = current.getSnapshot()?.key ?? null
              if (sid !== mainId) { mainId = sid; editor?._close?.() }
              try { recordFor(sid) } catch (error) { beacon('binding-failed', { message: String(error?.message ?? error) }) }
              schedule()
            }
            const off = current.subscribe(update)
            update()
            beacon('services-ready', { identity: 'conversation-snapshot' })
            let disposed = false
            return () => {
              if (disposed) return
              disposed = true; off?.()
              if (services !== next) return
              for (const record of [...records.values()]) record.dispose()
              services = null; installed = false; mainId = null
              schedule()
            }
          }
          const dispose = typeof child.effect === 'function' ? child.effect(mount, 'dsh-resend: conversation service generation') : mount()
          if (typeof dispose === 'function') disposers.push(dispose)
        }
        try {
          if (typeof ctx.inject === 'function') {
            const fiber = ctx.inject(['uiSession', 'uiConversation', 'sessions'], install)
            if (typeof fiber === 'function') disposers.push(fiber)
            else if (typeof fiber?.dispose === 'function') disposers.push(() => fiber.dispose())
          } else install(ctx)
        } catch (error) {
          beacon('services-failed', { message: String(error?.message ?? error) })
        }
        void call('status', {}).then((value) => {
          if (alive) beacon('host-ready', value)
        }, (error) => {
          if (alive) beacon('host-not-ready', { code: error?.code, message: String(error?.message ?? error) })
        })
        schedule()
        return () => {
          alive = false
          if (scheduled !== null) clearTimeout(scheduled)
          observer.disconnect()
          document.removeEventListener('click', onCopy, true)
          for (const controller of controllers) controller.abort()
          for (const record of records.values()) record.dispose()
          for (const dispose of disposers.reverse()) dispose?.()
          for (const [row] of overlays) clearOverlay(row)
          for (const element of document.querySelectorAll('[data-dsh-resend-hidden],[data-dsh-resend-original]')) {
            element.removeAttribute('data-dsh-resend-hidden'); element.removeAttribute('data-dsh-resend-original')
          }
          // Only remove DOM objects we created imperatively. Never delete a
          // React-owned slot contribution by a shared data attribute: React may
          // still be reconciling it, and removeChild would crash the native row.
          for (const button of ownedButtons) button.remove()
          ownedButtons.clear()
          editor?.remove(); editor = null
          style.remove()
          records.clear()
        }
      }, 'dsh-resend: reversible chat actions and presentation')
    }

    // Optional ctx.inject subscriptions above must not make the desktop boot wait
    // for a service named after a package (the earlier locale-inject regression).
    exports.inject = []
    exports.apply = apply
    return module.exports
  },
})
