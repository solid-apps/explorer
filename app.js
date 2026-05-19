// explorer — solid-apps/explorer
//
// Phase 1: container navigation + JSON-LD-aware preview.
// Phase 2: create / rename / delete / move / trash / upload / drag-drop.
// Phase 4: per-row ACL chip + editor panel. Lazy-fetches each row's
//          effective ACL (its own .acl, or inherits via parent default).
//          Click a chip → side panel to add/edit/remove authorizations.
//
// Phases beyond this one (see README):
//   3. preview pane media (image/audio/video/PDF)
//   5. subscribe + multi-user
//   7. cross-pod browse
//   8. search + bulk

function makePaneState() {
  return {
    here: null,
    history: [],
    items: [],
    focusedIndex: -1,
    selectedItem: null,
    dragSource: null     // { url } when this pane originated a drag
  }
}

const state = {
  panes: [makePaneState(), makePaneState()],
  activePane: 0,
  split: false,
  loading: false,
  ownPod: null,
  acl: {
    open: false,
    target: null,
    aclUrl: null,
    items: [],
    inheritedFrom: null,
    saving: false
  }
}

// Active pane state (most calls operate on whatever pane the user last
// interacted with; explicit handlers can pass a paneIdx instead).
function P(idx) { return state.panes[idx ?? state.activePane] }

function paneEl(idx) {
  return document.querySelector(`.pane[data-pane="${idx ?? state.activePane}"]`)
}

function paneIdxOfEl(el) {
  if (!el) return state.activePane
  const p = el.closest ? el.closest('.pane') : null
  return p ? parseInt(p.dataset.pane, 10) : state.activePane
}

const TRASH_PATH = '/private/.trash/'
const LS_LAST_URL = 'explorer.lastUrl'
const LS_PODS = 'explorer.pods'
const LS_SIDEBAR_COLLAPSED = 'explorer.sidebarCollapsed'

// Default starting URL. If the explorer page itself is served from a
// localhost origin (e.g. JSS hosting the app at /apps/explorer on a
// non-default port), use that origin so the pod port matches. Otherwise
// fall back to the canonical local dev port.
function defaultUrl() {
  try {
    const loc = window.location
    if (/^(localhost|127\.0\.0\.1|0\.0\.0\.0)(:\d+)?$/.test(loc.host)) {
      return `${loc.protocol}//${loc.host}/public/`
    }
  } catch {}
  return 'http://localhost:4443/public/'
}
let toastTimer = null

// --- auth + fetch helpers ---

function authFetch(url, opts) {
  if (window.xlogin && window.xlogin.id && window.xlogin.authFetch) {
    return window.xlogin.authFetch(url, opts)
  }
  return fetch(url, opts)
}

function meWebId() {
  return window.xlogin?.id || null
}

function podFromWebId(webId) {
  if (!webId || !webId.startsWith('http')) return null
  try {
    const u = new URL(webId)
    return `${u.protocol}//${u.host}`
  } catch { return null }
}

// --- url helpers ---

function isContainer(u) {
  if (!u) return false
  try {
    const p = new URL(u).pathname
    return p.endsWith('/')
  } catch { return false }
}

function parentOf(u) {
  if (!u) return null
  try {
    const parsed = new URL(u)
    let p = parsed.pathname
    if (p === '/' || p === '') return null
    p = p.endsWith('/') ? p.slice(0, -1) : p
    const i = p.lastIndexOf('/')
    if (i < 0) return parsed.origin + '/'
    return parsed.origin + p.slice(0, i + 1)
  } catch { return null }
}

function formatBytes(n) {
  if (n == null) return '—'
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`
  return `${(n / 1024 / 1024 / 1024).toFixed(1)} GB`
}

function formatDate(iso) {
  if (!iso) return '—'
  try {
    const d = new Date(iso)
    const now = new Date()
    const sameDay = d.toDateString() === now.toDateString()
    if (sameDay) {
      return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
    }
    const sameYear = d.getFullYear() === now.getFullYear()
    return d.toLocaleDateString(undefined,
      sameYear ? { month: 'short', day: 'numeric' }
               : { year: 'numeric', month: 'short', day: 'numeric' })
  } catch {
    return iso
  }
}

function escapeHtml(s) {
  if (typeof s !== 'string') s = String(s ?? '')
  return s.replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
}

// --- listing fetch + render ---

function normaliseUrl(url) {
  if (!url) return url
  url = url.trim()
  // If no scheme, default to http for localhost / IPs / dev, https otherwise
  if (!/^[a-z]+:\/\//i.test(url)) {
    const isLocal = /^(localhost|127\.0\.0\.1|0\.0\.0\.0|192\.168\.|10\.|172\.)/.test(url)
    url = (isLocal ? 'http://' : 'https://') + url
  }
  return url
}

async function navigateTo(rawUrl, options = {}) {
  if (!rawUrl) return
  const paneIdx = options.paneIdx ?? state.activePane
  const url = normaliseUrl(rawUrl)
  // Validate it parses at all before doing anything else
  try { new URL(url) } catch {
    setBusy(false, `invalid URL: ${rawUrl}`, 'error')
    showToast(`Invalid URL: ${rawUrl}`, null, null, 4000)
    return
  }
  const p = P(paneIdx)
  // Push current onto history unless this navigation is from the back button
  if (p.here && !options.fromBack && p.here !== url) {
    p.history.push(p.here)
  }
  p.here = url
  p.selectedItem = null
  syncUrl(paneIdx)
  renderBreadcrumb(paneIdx)
  renderSidebar()
  // Remember the last successful URL so the next session opens here
  // (only the active pane writes this — secondary pane is ephemeral)
  if (paneIdx === 0) {
    try { localStorage.setItem(LS_LAST_URL, url) } catch {}
  }
  setBusy(true, `loading ${url}`)
  if (paneIdx === state.activePane) hidePreview()
  try {
    const r = await authFetch(url, { headers: { Accept: 'application/ld+json' } })
    if (!r.ok) throw new Error(`${r.status} ${r.statusText}`)
    sidebarAutoAdd(p.here)
    const ct = (r.headers.get('content-type') || '').split(';')[0].trim()
    const isLdJson = ct === 'application/ld+json' || ct === 'application/json'

    if (isLdJson) {
      const text = await r.text()
      let doc
      try { doc = JSON.parse(text) } catch { doc = null }
      if (doc && isContainerDoc(doc)) {
        if (!url.endsWith('/')) {
          p.here = url + '/'
          syncUrl(paneIdx)
          renderBreadcrumb(paneIdx)
        }
        await renderContainerFromDoc(doc, p.here, paneIdx)
        setBusy(false, 'idle')
        refreshNavButtons(paneIdx)
        return
      }
      // Resource (not a container) — preview is global; only show if this is the active pane
      if (paneIdx === state.activePane) {
        await openPreviewFromText(p.here, ct, text, r)
      }
      renderEmpty('—', paneIdx)
    } else {
      if (paneIdx === state.activePane) {
        hidePreview()
        await openPreview(p.here)
      }
      renderEmpty('—', paneIdx)
    }
    setBusy(false, 'idle')
  } catch (e) {
    setBusy(false, e.message, 'error')
    renderEmpty(`Could not load: ${e.message}`, paneIdx)
  }
  refreshNavButtons(paneIdx)
}

function isContainerDoc(doc) {
  const t = doc['@type']
  if (!t) return false
  const types = Array.isArray(t) ? t : [t]
  return types.some(x =>
    x === 'ldp:Container' ||
    x === 'ldp:BasicContainer' ||
    x === 'http://www.w3.org/ns/ldp#Container' ||
    x === 'http://www.w3.org/ns/ldp#BasicContainer'
  )
}

async function renderContainerFromDoc(doc, baseUrl, paneIdx) {
  paneIdx = paneIdx ?? state.activePane
  const contains = doc['ldp:contains'] || doc['http://www.w3.org/ns/ldp#contains'] || doc['contains'] || []
  const arr = Array.isArray(contains) ? contains : [contains]
  let items = arr.map(x => {
    if (typeof x === 'string') return { '@id': x }
    return x
  })
  items = items.filter(item => {
    const id = item['@id']
    if (!id) return false
    const name = id.replace(/\/$/, '').split('/').pop() || ''
    return !name.startsWith('.')
  })
  items.sort((a, b) => {
    const ac = isContainer(a['@id']) ? 0 : 1
    const bc = isContainer(b['@id']) ? 0 : 1
    if (ac !== bc) return ac - bc
    return (a['@id'] || '').localeCompare(b['@id'] || '')
  })
  const p = P(paneIdx)
  p.items = items
  p.focusedIndex = -1
  renderListing(items, baseUrl, paneIdx)
}

async function openPreviewFromText(url, ct, text, response) {
  const pane = document.getElementById('preview')
  const titleEl = document.getElementById('preview-title')
  const metaEl = document.getElementById('preview-meta')
  const bodyEl = document.getElementById('preview-body')
  pane.hidden = false
  titleEl.textContent = decodeURIComponent(url.replace(/\/$/, '').split('/').pop() || url)
  const size = response.headers.get('content-length')
  const modified = response.headers.get('last-modified')
  metaEl.innerHTML = `
    <span>${escapeHtml(ct || 'unknown')}</span>
    <span>${size ? formatBytes(parseInt(size, 10)) : formatBytes(new Blob([text]).size)}</span>
    <span>${modified ? formatDate(new Date(modified).toISOString()) : '—'}</span>
  `
  try {
    const obj = JSON.parse(text)
    bodyEl.innerHTML = renderJsonLd(obj)
  } catch {
    bodyEl.textContent = text
  }
}

function renderListing(items, baseUrl, paneIdx) {
  paneIdx = paneIdx ?? state.activePane
  const listEl = paneEl(paneIdx).querySelector('.listing')
  listEl.innerHTML = ''
  if (items.length === 0) {
    renderEmpty(isContainer(baseUrl) ? 'Empty container.' : 'No items.', paneIdx)
    return
  }
  for (const item of items) {
    const id = item['@id']
    if (!id) continue
    const isC = isContainer(id)
    const name = decodeURIComponent((id.replace(/\/$/, '').split('/').pop() || '/'))
    const size = item['stat:size'] ?? item['http://www.w3.org/ns/posix/stat#size']
    const modified = item['dcterms:modified'] ?? item['http://purl.org/dc/terms/modified']
    const li = document.createElement('li')
    li.dataset.url = id
    li.dataset.pane = String(paneIdx)
    li.innerHTML = `
      <span class="row-name">
        <span class="row-icon ${isC ? 'container' : ''}">${isC ? '▸' : '·'}</span>
        <span class="row-label">${escapeHtml(name)}${isC ? '/' : ''}</span>
      </span>
      <span class="row-acl loading" title="Loading permissions…">…</span>
      <span class="row-meta">${isC ? '—' : formatBytes(size)}</span>
      <span class="row-meta">${formatDate(modified)}</span>
    `
    const chip = li.querySelector('.row-acl')
    chip.addEventListener('click', (e) => {
      e.preventDefault()
      e.stopPropagation()
      setActivePane(paneIdx)
      openAclEditor(id)
    })
    aclEnqueue(id)
    li.draggable = true
    li.addEventListener('click', (e) => {
      e.preventDefault()
      setActivePane(paneIdx)
      if (isC) {
        navigateTo(id, { paneIdx })
      } else {
        selectItem(id, paneIdx)
        openPreview(id).catch(err => setBusy(false, err.message, 'error'))
      }
    })
    li.addEventListener('dblclick', (e) => {
      e.preventDefault()
      const onName = e.target.closest('.row-label')
      if (onName) {
        beginRename(li, paneIdx)
      } else if (!isC) {
        navigateTo(id, { paneIdx })
      }
    })
    // Drag source — remember which pane originated the drag, so the
    // drop handler can decide MOVE (same pane/origin) vs COPY (cross).
    li.addEventListener('dragstart', (e) => {
      P(paneIdx).dragSource = { url: id }
      e.dataTransfer.effectAllowed = 'copyMove'
      e.dataTransfer.setData('text/plain', id)
      e.dataTransfer.setData('application/x-explorer-source', JSON.stringify({ url: id, paneIdx }))
      li.classList.add('dragging')
    })
    li.addEventListener('dragend', () => {
      P(paneIdx).dragSource = null
      li.classList.remove('dragging')
      document.querySelectorAll('.drop-target').forEach(el => el.classList.remove('drop-target'))
    })
    if (isC) {
      li.addEventListener('dragover', (e) => {
        const src = currentDragSource()
        if (!src || src.url === id) return
        // Don't drop a container into itself or its descendants — only
        // matters when the source is within the same origin/pane tree.
        if (sameOrigin(src.url, id) && src.url.endsWith('/') && id.startsWith(src.url)) return
        e.preventDefault()
        e.dataTransfer.dropEffect = sameOrigin(src.url, id) ? 'move' : 'copy'
        li.classList.add('drop-target')
      })
      li.addEventListener('dragleave', () => li.classList.remove('drop-target'))
      li.addEventListener('drop', (e) => {
        e.preventDefault()
        li.classList.remove('drop-target')
        const src = currentDragSource(e)
        if (!src || src.url === id) return
        if (sameOrigin(src.url, id)) {
          moveItem(src.url, id)
        } else {
          copyItemAcrossPods(src.url, id)
        }
      })
    }
    listEl.appendChild(li)
  }
}

function renderEmpty(text, paneIdx) {
  paneIdx = paneIdx ?? state.activePane
  const listEl = paneEl(paneIdx).querySelector('.listing')
  listEl.innerHTML = `<li class="empty">${escapeHtml(text)}</li>`
}

function selectItem(url, paneIdx) {
  paneIdx = paneIdx ?? state.activePane
  P(paneIdx).selectedItem = url
  paneEl(paneIdx).querySelectorAll('.listing li').forEach(li => {
    li.classList.toggle('selected', li.dataset.url === url)
  })
}

// Lookup the in-flight drag source from either pane (or from the
// drop-event's dataTransfer payload as a fallback for cross-window or
// cross-process drags — not used today but kept harmless).
function currentDragSource(event) {
  for (let i = 0; i < state.panes.length; i++) {
    if (state.panes[i].dragSource) return { ...state.panes[i].dragSource, paneIdx: i }
  }
  if (event && event.dataTransfer) {
    try {
      const raw = event.dataTransfer.getData('application/x-explorer-source')
      if (raw) return JSON.parse(raw)
    } catch {}
  }
  return null
}

function sameOrigin(a, b) {
  try { return new URL(a).origin === new URL(b).origin } catch { return false }
}

// --- preview ---

async function openPreview(url) {
  const pane = document.getElementById('preview')
  const titleEl = document.getElementById('preview-title')
  const metaEl = document.getElementById('preview-meta')
  const bodyEl = document.getElementById('preview-body')
  pane.hidden = false
  titleEl.textContent = decodeURIComponent(url.split('/').pop() || url)
  metaEl.innerHTML = '<span>loading…</span>'
  bodyEl.innerHTML = ''
  setBusy(true, 'fetching ' + url)

  let r
  try {
    r = await authFetch(url)
  } catch (e) {
    bodyEl.textContent = `Network error: ${e.message}`
    setBusy(false, e.message, 'error')
    return
  }
  if (!r.ok) {
    bodyEl.textContent = `HTTP ${r.status} ${r.statusText}`
    metaEl.innerHTML = `<span>error</span>`
    setBusy(false, `${r.status}`, 'error')
    return
  }
  const ct = (r.headers.get('content-type') || '').split(';')[0].trim()
  const size = r.headers.get('content-length')
  const modified = r.headers.get('last-modified')
  metaEl.innerHTML = `
    <span>${escapeHtml(ct || 'unknown')}</span>
    <span>${size ? formatBytes(parseInt(size, 10)) : '—'}</span>
    <span>${modified ? formatDate(new Date(modified).toISOString()) : '—'}</span>
  `

  if (ct.startsWith('image/')) {
    const blob = await r.blob()
    const objUrl = URL.createObjectURL(blob)
    bodyEl.innerHTML = `<img src="${objUrl}" alt="">`
  } else if (ct.startsWith('audio/')) {
    const blob = await r.blob()
    const objUrl = URL.createObjectURL(blob)
    bodyEl.innerHTML = `<audio controls src="${objUrl}"></audio>`
  } else if (ct.startsWith('video/')) {
    const blob = await r.blob()
    const objUrl = URL.createObjectURL(blob)
    bodyEl.innerHTML = `<video controls src="${objUrl}"></video>`
  } else if (ct === 'application/ld+json' || ct === 'application/json' || url.endsWith('.jsonld') || url.endsWith('.json')) {
    const text = await r.text()
    try {
      const obj = JSON.parse(text)
      bodyEl.innerHTML = renderJsonLd(obj)
    } catch {
      bodyEl.textContent = text
    }
  } else {
    // text-ish fallback
    const text = await r.text()
    // Truncate enormously long files
    bodyEl.textContent = text.length > 60000 ? text.slice(0, 60000) + '\n\n…(truncated)' : text
  }
  setBusy(false, 'idle')
}

function hidePreview() {
  const pane = document.getElementById('preview')
  pane.hidden = true
  // Reset content so we don't briefly flash the previous preview on reopen
  document.getElementById('preview-title').textContent = ''
  document.getElementById('preview-meta').innerHTML = ''
  document.getElementById('preview-body').innerHTML = ''
}

// JSON-LD aware pretty-print: render URI values as clickable links.
function renderJsonLd(obj, indent = 0) {
  const pad = '  '.repeat(indent)
  if (obj === null) return '<span class="json-null">null</span>'
  if (typeof obj === 'string') {
    if (/^https?:\/\//.test(obj)) {
      return `<a href="${escapeHtml(obj)}" data-link>${escapeHtml(obj)}</a>`
    }
    return escapeHtml(JSON.stringify(obj))
  }
  if (typeof obj === 'number' || typeof obj === 'boolean') return escapeHtml(String(obj))
  if (Array.isArray(obj)) {
    if (obj.length === 0) return '[]'
    const inner = obj.map(v => pad + '  ' + renderJsonLd(v, indent + 1)).join(',\n')
    return `[\n${inner}\n${pad}]`
  }
  if (typeof obj === 'object') {
    const keys = Object.keys(obj)
    if (keys.length === 0) return '{}'
    const inner = keys.map(k => {
      let v = obj[k]
      // @id values: render as clickable link
      if (k === '@id' && typeof v === 'string') {
        return pad + '  ' + escapeHtml(JSON.stringify(k)) + ': ' + `<a href="${escapeHtml(v)}" data-link>${escapeHtml(JSON.stringify(v))}</a>`
      }
      return pad + '  ' + escapeHtml(JSON.stringify(k)) + ': ' + renderJsonLd(v, indent + 1)
    }).join(',\n')
    return `{\n${inner}\n${pad}}`
  }
  return escapeHtml(String(obj))
}

// --- breadcrumb ---

function renderBreadcrumb(paneIdx) {
  paneIdx = paneIdx ?? state.activePane
  const el = paneEl(paneIdx).querySelector('.breadcrumb')
  el.innerHTML = ''
  const here = P(paneIdx).here
  if (!here) return
  let u
  try { u = new URL(here) } catch { return }
  const segments = u.pathname.split('/').filter(s => s !== '')
  const origin = u.origin
  const append = (label, href) => {
    const a = document.createElement('a')
    a.textContent = label
    a.href = '#'
    a.addEventListener('click', (e) => {
      e.preventDefault()
      navigateTo(href, { paneIdx })
    })
    el.appendChild(a)
  }
  const sep = () => {
    const s = document.createElement('span')
    s.className = 'sep'
    s.textContent = '/'
    el.appendChild(s)
  }
  append(origin, origin + '/')
  let acc = '/'
  for (const seg of segments) {
    sep()
    acc += seg + '/'
    append(seg, origin + acc)
  }
  if (!u.pathname.endsWith('/') && segments.length > 0) {
    const lastIsDir = el.lastChild && el.lastChild.tagName === 'A'
    if (lastIsDir) {
      const lastSeg = segments[segments.length - 1]
      el.removeChild(el.lastChild)
      const span = document.createElement('span')
      span.textContent = lastSeg
      el.appendChild(span)
    }
  }
}

// --- nav buttons ---

function refreshNavButtons(paneIdx) {
  paneIdx = paneIdx ?? state.activePane
  const el = paneEl(paneIdx)
  el.querySelector('.btn-back').disabled = P(paneIdx).history.length === 0
  el.querySelector('.btn-up').disabled = !parentOf(P(paneIdx).here)
}

function syncUrl(paneIdx) {
  paneIdx = paneIdx ?? state.activePane
  paneEl(paneIdx).querySelector('.url').value = P(paneIdx).here || ''
}

function setBusy(busy, text, kind) {
  state.loading = busy
  const el = document.getElementById('status')
  el.textContent = text || (busy ? 'loading' : 'idle')
  el.className = 'status' + (busy ? ' busy' : '') + (kind === 'error' ? ' error' : '')
}

// --- identity ---

function renderIdentity() {
  const pill = document.getElementById('topbar-id')
  const id = meWebId()
  if (id) {
    let label
    if (id.startsWith('http')) {
      try { label = new URL(id).host } catch { label = id }
    } else {
      label = id.length > 16 ? id.slice(0, 8) + '…' + id.slice(-4) : id
    }
    pill.textContent = label
    pill.hidden = false
    state.ownPod = podFromWebId(id)
    if (!P(0).here && state.ownPod) {
      const guess = state.ownPod + '/public/'
      paneEl(0).querySelector('.url').value = guess
    }
  } else {
    pill.hidden = true
  }
}

function watchLogin() {
  let last = meWebId()
  setInterval(() => {
    const now = meWebId()
    if (now !== last) { last = now; renderIdentity(); renderSidebar() }
  }, 500)
}

// --- buttons ---

function bindButtons() {
  // Bind per-pane controls. Both panes get the same handlers, each
  // closed over its paneIdx.
  document.querySelectorAll('.pane').forEach(pEl => {
    const paneIdx = parseInt(pEl.dataset.pane, 10)
    pEl.addEventListener('mousedown', () => setActivePane(paneIdx), { capture: true })

    pEl.querySelector('.btn-go').addEventListener('click', () => {
      const v = pEl.querySelector('.url').value.trim()
      if (v) { setActivePane(paneIdx); navigateTo(v, { paneIdx }) }
    })
    pEl.querySelector('.url').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        const v = e.target.value.trim()
        if (v) { setActivePane(paneIdx); navigateTo(v, { paneIdx }) }
      }
    })
    pEl.querySelector('.btn-up').addEventListener('click', () => {
      const par = parentOf(P(paneIdx).here)
      if (par) navigateTo(par, { paneIdx })
    })
    pEl.querySelector('.btn-back').addEventListener('click', () => {
      if (P(paneIdx).history.length === 0) return
      const prev = P(paneIdx).history.pop()
      if (prev) navigateTo(prev, { paneIdx, fromBack: true })
    })
    pEl.querySelector('.btn-refresh').addEventListener('click', () => refresh(paneIdx))

    // New… menu (per-pane popover)
    pEl.querySelector('.btn-new').addEventListener('click', (e) => {
      e.stopPropagation()
      setActivePane(paneIdx)
      togglePopover(undefined, paneIdx)
    })
    pEl.querySelectorAll('.popover-new .popover-item').forEach(btn => {
      btn.addEventListener('click', () => {
        togglePopover(false, paneIdx)
        const action = btn.dataset.action
        if (action === 'container') newContainer(paneIdx)
        else if (action === 'file') newFile(paneIdx)
        else if (action === 'upload') document.querySelector(`.file-picker[data-pane="${paneIdx}"]`).click()
      })
    })

    const split = pEl.querySelector('.btn-split')
    if (split) split.addEventListener('click', () => toggleSplit(true))
    const close = pEl.querySelector('.btn-close-pane')
    if (close) close.addEventListener('click', () => toggleSplit(false))
  })

  // Per-pane file pickers
  document.querySelectorAll('.file-picker').forEach(picker => {
    const paneIdx = parseInt(picker.dataset.pane, 10)
    picker.addEventListener('change', (e) => {
      uploadFiles(e.target.files, paneIdx)
      e.target.value = ''
    })
  })

  // Global controls
  document.getElementById('btn-close-preview').addEventListener('click', hidePreview)
  document.getElementById('toast-close').addEventListener('click', hideToast)
  document.getElementById('preview-body').addEventListener('click', (e) => {
    const a = e.target.closest('a[data-link]')
    if (!a) return
    e.preventDefault()
    navigateTo(a.getAttribute('href'))
  })
}

// --- refresh ---

function refresh(paneIdx) {
  paneIdx = paneIdx ?? state.activePane
  const here = P(paneIdx).here
  if (!here) return
  navigateTo(here, { paneIdx, fromBack: true })
}

// --- split mode ---

function toggleSplit(force) {
  const want = force != null ? force : !state.split
  if (want === state.split) return
  state.split = want
  const right = paneEl(1)
  right.hidden = !want
  document.body.classList.toggle('split', want)
  if (want) {
    // Opening split closes any side panel — they can't share the right column
    hidePreview()
    if (state.acl.open) closeAclEditor()
    // Seed pane 1 from pane 0 if it's empty
    if (!P(1).here) {
      const seed = P(0).here || defaultUrl()
      paneEl(1).querySelector('.url').value = seed
      navigateTo(seed, { paneIdx: 1 })
    }
  } else {
    if (state.activePane === 1) setActivePane(0)
  }
  updatePaneActiveClass()
}

function setActivePane(idx) {
  if (idx === state.activePane) return
  if (!state.split && idx !== 0) return
  state.activePane = idx
  updatePaneActiveClass()
}

function updatePaneActiveClass() {
  document.querySelectorAll('.pane').forEach(p => {
    const i = parseInt(p.dataset.pane, 10)
    p.classList.toggle('active', i === state.activePane)
  })
}

// --- delete (soft, with undo) ---

function isInTrash(url) {
  return url && url.includes(TRASH_PATH)
}

// Refresh every pane currently showing the given container URL — keeps
// both panes in sync after any mutation (delete, rename, copy).
function refreshIfAffected(parentUrl) {
  for (let i = 0; i < state.panes.length; i++) {
    if (P(i).here === parentUrl) refresh(i)
  }
}

async function softDelete(url, paneIdx) {
  if (!url) return
  if (!meWebId()) {
    showToast('Login required to delete.', null, null, 3000)
    return
  }
  if (isInTrash(url)) return permanentDelete(url, paneIdx)
  if (!state.ownPod) {
    showToast('Cannot find your pod root for trash. Login may be incomplete.', null, null, 4000)
    return
  }
  if (isContainer(url)) {
    return softDeleteContainer(url, paneIdx)
  }
  return softDeleteResource(url, paneIdx)
}

async function permanentDelete(url, paneIdx) {
  const name = decodeURIComponent(url.replace(/\/$/, '').split('/').pop() || '')
  const isC = isContainer(url)
  if (!confirm(`Permanently delete "${name}${isC ? '/' : ''}"? This cannot be undone.`)) return
  setBusy(true, 'deleting…')
  try {
    if (isC) {
      const cs = [], ls = []
      await walkTree(url, cs, ls)
      for (const leaf of ls) {
        const d = await authFetch(leaf, { method: 'DELETE' })
        if (!d.ok) throw new Error(`delete ${leaf}: ${d.status}`)
      }
      cs.sort((a, b) => b.length - a.length)
      for (const c of cs) {
        await authFetch(c, { method: 'DELETE' }).catch(() => {})
      }
    } else {
      const r = await authFetch(url, { method: 'DELETE' })
      if (!r.ok) throw new Error(`${r.status}`)
    }
    setBusy(false, 'idle')
    refreshIfAffected(parentOf(url))
    showToast(`Permanently deleted "${name}"`, null, null, 2500)
  } catch (e) {
    setBusy(false, e.message, 'error')
    showToast(`Couldn't delete: ${e.message}`, null, null, 5000)
  }
}

// --- copy-and-delete primitive (shared by rename + move) ---

// LDP has no native MOVE / COPY / RENAME. Everything is read source → write dest → delete source.
async function copyAndDelete(srcUrl, destUrl) {
  if (srcUrl === destUrl) return
  if (isContainer(srcUrl)) return copyAndDeleteContainer(srcUrl, destUrl)
  return copyAndDeleteResource(srcUrl, destUrl)
}

async function copyAndDeleteResource(srcUrl, destUrl) {
  // Refuse to overwrite existing destination
  try {
    const h = await authFetch(destUrl, { method: 'HEAD' })
    if (h.ok) throw new Error(`destination exists: ${destUrl.split('/').pop()}`)
  } catch (e) {
    // Network errors on HEAD: treat as "doesn't exist" and proceed
    if (e.message.startsWith('destination exists')) throw e
  }
  const r = await authFetch(srcUrl)
  if (!r.ok) throw new Error(`read source: ${r.status}`)
  const ct = r.headers.get('content-type') || 'application/octet-stream'
  const blob = await r.blob()
  const w = await authFetch(destUrl, {
    method: 'PUT',
    headers: { 'Content-Type': ct },
    body: blob
  })
  if (!w.ok) throw new Error(`write dest: ${w.status}`)
  const d = await authFetch(srcUrl, { method: 'DELETE' })
  if (!d.ok) {
    // Roll back: delete what we just wrote
    authFetch(destUrl, { method: 'DELETE' }).catch(() => {})
    throw new Error(`delete source: ${d.status}`)
  }
}

async function copyAndDeleteContainer(srcUrl, destUrl) {
  const containers = []
  const leaves = []
  await walkTree(srcUrl, containers, leaves)
  for (const leafUrl of leaves) {
    const rel = leafUrl.slice(srcUrl.length)
    await copyAndDeleteResource(leafUrl, destUrl + rel)
  }
  // Delete the now-empty source containers deepest-first
  containers.sort((a, b) => b.length - a.length)
  for (const c of containers) {
    await authFetch(c, { method: 'DELETE' }).catch(() => {})
  }
}

// --- rename ---

async function renameItem(srcUrl, newName) {
  const parent = parentOf(srcUrl)
  if (!parent) throw new Error('cannot rename the pod root')
  const trailing = isContainer(srcUrl) ? '/' : ''
  const destUrl = parent + encodeURIComponent(newName) + trailing
  if (destUrl === srcUrl) return srcUrl
  await copyAndDelete(srcUrl, destUrl)
  return destUrl
}

function beginRename(li, paneIdx) {
  if (!li) return
  const url = li.dataset.url
  if (!url || isInTrash(url)) return  // can't rename in trash
  const labelEl = li.querySelector('.row-label')
  if (!labelEl) return
  const isC = isContainer(url)
  const currentName = decodeURIComponent(url.replace(/\/$/, '').split('/').pop() || '')

  const originalHtml = labelEl.innerHTML
  const input = document.createElement('input')
  input.type = 'text'
  input.value = currentName
  input.className = 'rename-input'
  input.setAttribute('aria-label', 'New name')
  labelEl.innerHTML = ''
  labelEl.appendChild(input)
  input.focus()
  input.select()

  let done = false
  const cleanup = () => {
    if (done) return
    done = true
    labelEl.innerHTML = originalHtml
  }
  const commit = async () => {
    if (done) return
    const newName = input.value.trim()
    if (!newName || newName === currentName) { cleanup(); return }
    if (newName.includes('/') || newName.includes('\\')) {
      showToast('Name cannot contain / or \\.', null, null, 3500)
      cleanup()
      return
    }
    done = true
    setBusy(true, `renaming "${currentName}" → "${newName}"…`)
    try {
      await renameItem(url, newName)
      setBusy(false, 'idle')
      refreshIfAffected(parentOf(url))
      showToast(`Renamed to "${newName}"`, null, null, 2500)
    } catch (e) {
      setBusy(false, e.message, 'error')
      showToast(`Couldn't rename: ${e.message}`, null, null, 5000)
      refreshIfAffected(parentOf(url))
    }
  }
  input.addEventListener('keydown', (e) => {
    e.stopPropagation()  // don't fall through to global keyboard handler
    if (e.key === 'Enter') { e.preventDefault(); commit() }
    else if (e.key === 'Escape') { e.preventDefault(); cleanup() }
  })
  input.addEventListener('blur', commit)
  input.addEventListener('click', e => e.stopPropagation())
  input.addEventListener('dblclick', e => e.stopPropagation())
}

// --- move ---

async function moveItem(srcUrl, targetContainerUrl) {
  if (!targetContainerUrl.endsWith('/')) targetContainerUrl += '/'
  const trailing = isContainer(srcUrl) ? '/' : ''
  const name = decodeURIComponent(srcUrl.replace(/\/$/, '').split('/').pop() || '')
  const destUrl = targetContainerUrl + encodeURIComponent(name) + trailing
  if (destUrl === srcUrl) return
  // Disallow moving a container into itself or a descendant
  if (isContainer(srcUrl) && targetContainerUrl.startsWith(srcUrl)) {
    throw new Error('cannot move a container into itself')
  }
  setBusy(true, `moving "${name}"…`)
  try {
    await copyAndDelete(srcUrl, destUrl)
    setBusy(false, 'idle')
    refreshIfAffected(parentOf(srcUrl))
    refreshIfAffected(targetContainerUrl)
    showToast(`Moved "${name}" → ${decodeURIComponent(targetContainerUrl.split('/').slice(-2, -1)[0] || '/')}/`, null, null, 2500)
  } catch (e) {
    setBusy(false, e.message, 'error')
    showToast(`Couldn't move: ${e.message}`, null, null, 5000)
    refreshIfAffected(parentOf(srcUrl))
    refreshIfAffected(targetContainerUrl)
  }
}

// Cross-pod copy: keeps source intact (no DELETE). Used when drag
// crosses an origin boundary in split mode.
async function copyItemAcrossPods(srcUrl, targetContainerUrl) {
  if (!targetContainerUrl.endsWith('/')) targetContainerUrl += '/'
  const trailing = isContainer(srcUrl) ? '/' : ''
  const name = decodeURIComponent(srcUrl.replace(/\/$/, '').split('/').pop() || '')
  const destUrl = targetContainerUrl + encodeURIComponent(name) + trailing
  if (destUrl === srcUrl) return
  setBusy(true, `copying "${name}" across pods…`)
  try {
    if (isContainer(srcUrl)) {
      const containers = []
      const leaves = []
      await walkTree(srcUrl, containers, leaves)
      let done = 0
      for (const leaf of leaves) {
        const rel = leaf.slice(srcUrl.length)
        await copyResource(leaf, destUrl + rel)
        done++
        setBusy(true, `copying ${done} / ${leaves.length}…`)
      }
    } else {
      await copyResource(srcUrl, destUrl)
    }
    setBusy(false, 'idle')
    refreshIfAffected(targetContainerUrl)
    showToast(`Copied "${name}" to ${new URL(targetContainerUrl).host}`, null, null, 3000)
  } catch (e) {
    setBusy(false, e.message, 'error')
    showToast(`Couldn't copy: ${e.message}`, null, null, 5000)
  }
}

async function copyResource(srcUrl, destUrl) {
  try {
    const h = await authFetch(destUrl, { method: 'HEAD' })
    if (h.ok) throw new Error(`destination exists: ${destUrl.split('/').pop()}`)
  } catch (e) {
    if (e.message.startsWith('destination exists')) throw e
  }
  const r = await authFetch(srcUrl)
  if (!r.ok) throw new Error(`read source: ${r.status}`)
  const ct = r.headers.get('content-type') || 'application/octet-stream'
  const blob = await r.blob()
  const w = await authFetch(destUrl, {
    method: 'PUT',
    headers: { 'Content-Type': ct },
    body: blob
  })
  if (!w.ok) throw new Error(`write dest: ${w.status}`)
}

async function softDeleteResource(url) {
  const original = url
  const name = decodeURIComponent(original.replace(/\/$/, '').split('/').pop() || 'untitled')
  const ts = new Date().toISOString().replace(/[:.]/g, '-')
  const trashUrl = `${state.ownPod}${TRASH_PATH}${ts}-${name}`
  setBusy(true, 'moving to trash…')
  let ct
  try {
    const r = await authFetch(original)
    if (!r.ok) throw new Error(`read source: ${r.status}`)
    ct = r.headers.get('content-type') || 'application/octet-stream'
    const blob = await r.blob()
    const w = await authFetch(trashUrl, {
      method: 'PUT',
      headers: { 'Content-Type': ct },
      body: blob
    })
    if (!w.ok) throw new Error(`write trash: ${w.status}`)
    const d = await authFetch(original, { method: 'DELETE' })
    if (!d.ok) {
      authFetch(trashUrl, { method: 'DELETE' }).catch(() => {})
      throw new Error(`delete original: ${d.status}`)
    }
    setBusy(false, 'idle')
    refreshIfAffected(parentOf(original))
    showToast(
      `Moved “${name}” to Trash`,
      'Undo',
      () => undoSoftDelete([{ originalUrl: original, trashUrl, ct }]),
      8000
    )
  } catch (e) {
    setBusy(false, e.message, 'error')
    showToast(`Couldn't delete: ${e.message}`, null, null, 5000)
  }
}

async function softDeleteContainer(url) {
  const name = decodeURIComponent(url.replace(/\/$/, '').split('/').pop() || 'untitled')
  if (!confirm(`Delete container "${name}" and everything inside it?`)) return
  const ts = new Date().toISOString().replace(/[:.]/g, '-')
  const trashBase = `${state.ownPod}${TRASH_PATH}${ts}-${name}/`
  setBusy(true, `moving "${name}" to trash…`)
  const restores = []  // each: { originalUrl, trashUrl, ct } for undo
  try {
    // Walk the tree. For each leaf, copy to a path-preserving trash URL,
    // then DELETE source. After leaves, DELETE empty containers
    // (deepest-first).
    const allContainers = []  // deepest first after sort
    const allLeaves = []      // collected during walk
    await walkTree(url, allContainers, allLeaves)

    // Move each leaf to trash
    for (const leafUrl of allLeaves) {
      const relPath = leafUrl.slice(url.length)
      const trashUrl = trashBase + relPath
      const r = await authFetch(leafUrl)
      if (!r.ok) throw new Error(`read ${leafUrl}: ${r.status}`)
      const ct = r.headers.get('content-type') || 'application/octet-stream'
      const blob = await r.blob()
      const w = await authFetch(trashUrl, {
        method: 'PUT',
        headers: { 'Content-Type': ct },
        body: blob
      })
      if (!w.ok) throw new Error(`write trash for ${leafUrl}: ${w.status}`)
      const d = await authFetch(leafUrl, { method: 'DELETE' })
      if (!d.ok) throw new Error(`delete ${leafUrl}: ${d.status}`)
      restores.push({ originalUrl: leafUrl, trashUrl, ct })
    }
    // Delete now-empty containers, deepest first
    allContainers.sort((a, b) => b.length - a.length)
    for (const c of allContainers) {
      await authFetch(c, { method: 'DELETE' }).catch(() => {})  // best-effort
    }
    setBusy(false, 'idle')
    refreshIfAffected(parentOf(url))
    const n = restores.length
    showToast(
      `Moved "${name}" (${n} item${n === 1 ? '' : 's'}) to Trash`,
      'Undo',
      () => undoSoftDelete(restores),
      10000
    )
  } catch (e) {
    setBusy(false, e.message, 'error')
    showToast(`Couldn't delete container: ${e.message}`, null, null, 6000)
  }
}

async function walkTree(containerUrl, outContainers, outLeaves) {
  const r = await authFetch(containerUrl, { headers: { Accept: 'application/ld+json' } })
  if (!r.ok) throw new Error(`list ${containerUrl}: ${r.status}`)
  const doc = await r.json()
  outContainers.push(containerUrl)
  const contains = doc['ldp:contains'] || doc['http://www.w3.org/ns/ldp#contains'] || doc['contains'] || []
  const arr = Array.isArray(contains) ? contains : [contains]
  for (const x of arr) {
    const id = typeof x === 'string' ? x : x['@id']
    if (!id) continue
    if (isContainer(id)) {
      await walkTree(id, outContainers, outLeaves)
    } else {
      outLeaves.push(id)
    }
  }
}

async function undoSoftDelete(restores) {
  setBusy(true, `restoring ${restores.length} item${restores.length === 1 ? '' : 's'}…`)
  try {
    for (const { originalUrl, trashUrl, ct } of restores) {
      const r = await authFetch(trashUrl)
      if (!r.ok) throw new Error(`read trash ${trashUrl}: ${r.status}`)
      const blob = await r.blob()
      const w = await authFetch(originalUrl, {
        method: 'PUT',
        headers: { 'Content-Type': ct || 'application/octet-stream' },
        body: blob
      })
      if (!w.ok) throw new Error(`restore ${originalUrl}: ${w.status}`)
      authFetch(trashUrl, { method: 'DELETE' }).catch(() => {})
    }
    setBusy(false, 'idle')
    // Refresh any pane showing the parent of the first restored item
    if (restores[0]) refreshIfAffected(parentOf(restores[0].originalUrl))
    showToast('Restored', null, null, 2000)
  } catch (e) {
    setBusy(false, e.message, 'error')
    showToast(`Couldn't restore: ${e.message}`, null, null, 5000)
  }
}

// --- create container / file ---

async function newContainer(paneIdx) {
  paneIdx = paneIdx ?? state.activePane
  const here = P(paneIdx).here
  if (!isContainer(here)) {
    showToast('Navigate to a container first.', null, null, 3000)
    return
  }
  const raw = prompt('New container name:')
  if (!raw) return
  const name = raw.trim().replace(/[/\\]/g, '-')
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_. -]*$/.test(name)) {
    showToast('Invalid name. Use letters, numbers, _ . - and spaces.', null, null, 4000)
    return
  }
  setBusy(true, 'creating container…')
  try {
    const r = await authFetch(here, {
      method: 'POST',
      headers: {
        'Content-Type': 'text/turtle',
        'Slug': name,
        'Link': '<http://www.w3.org/ns/ldp#BasicContainer>; rel="type"'
      },
      body: ''
    })
    if (!r.ok) throw new Error(`POST → ${r.status}`)
    setBusy(false, 'idle')
    refresh(paneIdx)
    showToast(`Created "${name}/"`, null, null, 2500)
  } catch (e) {
    setBusy(false, e.message, 'error')
    showToast(`Couldn't create container: ${e.message}`, null, null, 5000)
  }
}

const EXTENSION_TYPES = {
  txt: 'text/plain',
  md:  'text/markdown',
  html:'text/html',
  htm: 'text/html',
  css: 'text/css',
  js:  'application/javascript',
  json:'application/json',
  jsonld:'application/ld+json',
  ttl: 'text/turtle',
  csv: 'text/csv',
  xml: 'application/xml',
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg:'image/jpeg',
  gif: 'image/gif',
  webp:'image/webp',
  pdf: 'application/pdf',
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  mp4: 'video/mp4',
  webm:'video/webm'
}

function contentTypeFromName(name) {
  const i = name.lastIndexOf('.')
  if (i < 0) return 'text/plain'
  const ext = name.slice(i + 1).toLowerCase()
  return EXTENSION_TYPES[ext] || 'application/octet-stream'
}

async function newFile(paneIdx) {
  paneIdx = paneIdx ?? state.activePane
  const here = P(paneIdx).here
  if (!isContainer(here)) {
    showToast('Navigate to a container first.', null, null, 3000)
    return
  }
  const raw = prompt('New file name (e.g. notes.md):')
  if (!raw) return
  const name = raw.trim().replace(/[/\\]/g, '-')
  if (!name || name.startsWith('.')) {
    showToast('Invalid name.', null, null, 4000)
    return
  }
  const ct = contentTypeFromName(name)
  const url = here + encodeURIComponent(name)
  setBusy(true, 'creating file…')
  try {
    const r = await authFetch(url, {
      method: 'PUT',
      headers: { 'Content-Type': ct },
      body: ''
    })
    if (!r.ok) throw new Error(`PUT → ${r.status}`)
    setBusy(false, 'idle')
    refresh(paneIdx)
    showToast(`Created "${name}"`, null, null, 2500)
  } catch (e) {
    setBusy(false, e.message, 'error')
    showToast(`Couldn't create file: ${e.message}`, null, null, 5000)
  }
}

// --- upload ---

async function uploadFiles(fileList, paneIdx) {
  paneIdx = paneIdx ?? state.activePane
  const here = P(paneIdx).here
  if (!fileList || fileList.length === 0) return
  if (!isContainer(here)) {
    showToast('Navigate to a container first.', null, null, 3000)
    return
  }
  if (!meWebId()) {
    showToast('Login required to upload.', null, null, 3000)
    return
  }
  const files = Array.from(fileList)
  let ok = 0
  let fail = 0
  const failures = []  // { name, size, message }
  setBusy(true, `uploading 0 / ${files.length}…`)
  // Concurrency 3
  const queue = files.slice()
  async function worker() {
    while (queue.length > 0) {
      const file = queue.shift()
      if (!file) return
      const safeName = file.name.replace(/[/\\]/g, '-')
      try {
        const url = here + encodeURIComponent(safeName)
        const ct = file.type || contentTypeFromName(safeName)
        const r = await authFetch(url, {
          method: 'PUT',
          headers: { 'Content-Type': ct },
          body: file
        })
        if (!r.ok) {
          // Pull a short body excerpt for the error message — JSS error
          // payloads are usually JSON with a "message" field
          let detail = ''
          try {
            const text = (await r.text()).slice(0, 240)
            try { detail = JSON.parse(text).message || text } catch { detail = text }
          } catch {}
          if (r.status === 413) detail = 'file too large for server'
          else if (r.status === 401 || r.status === 403) detail = 'forbidden — check login + ACL'
          throw new Error(`HTTP ${r.status}${detail ? ' — ' + detail : ''}`)
        }
        ok++
      } catch (e) {
        fail++
        failures.push({ name: safeName, size: file.size, message: e.message })
      }
      setBusy(true, `uploading ${ok + fail} / ${files.length}…`)
    }
  }
  await Promise.all([worker(), worker(), worker()])
  setBusy(false, 'idle')
  refresh(paneIdx)
  if (fail === 0) {
    showToast(`Uploaded ${ok} file${ok === 1 ? '' : 's'}`, null, null, 3000)
  } else if (ok === 0 && fail === 1) {
    const f = failures[0]
    showToast(`Couldn't upload "${f.name}" (${formatBytes(f.size)}): ${f.message}`, null, null, 10000)
  } else {
    const first = failures[0]
    showToast(`Uploaded ${ok}, failed ${fail}. First: "${first.name}" — ${first.message}`, null, null, 10000)
  }
}

// --- ACL: parsing, chip loading, editor ---
//
// WAC (Web Access Control) lives in companion docs:
//   - resource /foo  →  ACL at /foo.acl
//   - container /foo/ →  ACL at /foo/.acl
// If a resource has no own ACL, the closest ancestor container's ACL
// applies via acl:default. We walk up until we find one or hit root.

const ACL_NS = 'http://www.w3.org/ns/auth/acl#'
const FOAF_NS = 'http://xmlns.com/foaf/0.1/'
const MODES = ['Read', 'Write', 'Append', 'Control']

// Per-URL ACL summary cache: { kind, chip, label, explicit, error? }
const aclCache = new Map()
const aclInFlight = new Set()
const aclQueue = []
const ACL_CONCURRENCY = 4
let aclActiveWorkers = 0

function aclUrlFor(url) {
  // Both forms: /foo → /foo.acl ;  /foo/ → /foo/.acl
  return url + '.acl'
}

function aclEnqueue(url) {
  if (aclCache.has(url)) {
    renderAclChip(url, aclCache.get(url))
    return
  }
  if (aclInFlight.has(url)) return
  aclInFlight.add(url)
  aclQueue.push(url)
  aclPump()
}

function aclPump() {
  while (aclActiveWorkers < ACL_CONCURRENCY && aclQueue.length > 0) {
    const url = aclQueue.shift()
    aclActiveWorkers++
    loadAclSummary(url).finally(() => {
      aclInFlight.delete(url)
      aclActiveWorkers--
      aclPump()
    })
  }
}

async function loadAclSummary(url) {
  // Use the WAC-Allow response header (HEAD) for a summary — no .acl
  // fetch needed, works without auth. The .acl walk only runs when the
  // editor opens (where we need full authorization detail).
  try {
    const r = await authFetch(url, { method: 'HEAD' })
    const wac = r.headers.get('wac-allow')
    if (wac) {
      const summary = summariseWacAllow(wac)
      aclCache.set(url, summary)
      renderAclChip(url, summary)
      return
    }
    throw new Error('no wac-allow header')
  } catch (e) {
    const sum = { kind: 'unknown', chip: '?', label: 'unknown', explicit: false, error: e.message }
    aclCache.set(url, sum)
    renderAclChip(url, sum)
  }
}

function parseWacAllow(header) {
  // wac-allow: user="read write", public="read"
  const result = { user: new Set(), public: new Set() }
  if (!header) return result
  for (const part of header.split(',')) {
    const m = part.trim().match(/^(\w+)\s*=\s*"([^"]*)"/)
    if (!m) continue
    const who = m[1]
    const modes = m[2].split(/\s+/).filter(Boolean)
    for (const mode of modes) {
      if (who === 'user') result.user.add(mode)
      else if (who === 'public') result.public.add(mode)
    }
  }
  return result
}

function summariseWacAllow(header) {
  const wac = parseWacAllow(header)
  const publicRead = wac.public.has('read')
  const userRead = wac.user.has('read')
  const youWrite = wac.user.has('write') || wac.user.has('append')
  if (publicRead) {
    return { kind: 'public', chip: '🌐',
      label: youWrite ? 'Public — anyone can read; you can write' : 'Public — anyone can read',
      explicit: true }
  }
  if (userRead) {
    return { kind: 'shared', chip: '👥',
      label: youWrite ? 'Shared — logged-in users can read; you can write' : 'Shared — logged-in users can read',
      explicit: true }
  }
  return { kind: 'private', chip: '🔒',
    label: youWrite ? 'Private — you have write access' : 'Private — not accessible to you',
    explicit: true }
}

// Walk up from targetUrl looking for an .acl. Returns
// { aclUrl, doc, accessToUrl, explicit }.
async function findEffectiveAcl(targetUrl) {
  let cur = targetUrl
  let first = true
  while (cur) {
    const aclUrl = aclUrlFor(cur)
    let r
    try {
      r = await authFetch(aclUrl, { headers: { Accept: 'application/ld+json' } })
    } catch (e) {
      throw new Error(`network: ${e.message}`)
    }
    if (r.ok) {
      const doc = await r.json().catch(() => null)
      if (!doc) throw new Error('acl not JSON-LD')
      return { aclUrl, doc, accessToUrl: cur, explicit: first }
    }
    if (r.status === 401 || r.status === 403) {
      throw new Error(`forbidden (${r.status})`)
    }
    if (r.status !== 404) {
      throw new Error(`HTTP ${r.status} on ${aclUrl}`)
    }
    first = false
    if (cur === targetUrl && !cur.endsWith('/')) {
      // For a resource, the next step up is its container, not strip-and-up.
      cur = parentOf(cur)
    } else {
      cur = parentOf(cur)
    }
  }
  throw new Error('no acl found')
}

// Normalise prefixed / expanded property names in JSON-LD ACL nodes.
function aclProp(node, suffix) {
  const keys = [`acl:${suffix}`, `${ACL_NS}${suffix}`, suffix]
  for (const k of keys) {
    if (node[k] != null) {
      const v = node[k]
      const arr = Array.isArray(v) ? v : [v]
      return arr.map(x => typeof x === 'string' ? x : (x && x['@id'])).filter(Boolean)
    }
  }
  return []
}

function aclTypes(node) {
  const t = node['@type']
  if (!t) return []
  return Array.isArray(t) ? t : [t]
}

function isAuthorization(node) {
  return aclTypes(node).some(t =>
    t === 'Authorization' || t === 'acl:Authorization' || t === ACL_NS + 'Authorization'
  )
}

function normaliseMode(uri) {
  if (!uri) return null
  let m = String(uri)
  if (m.startsWith(ACL_NS)) m = m.slice(ACL_NS.length)
  else if (m.startsWith('acl:')) m = m.slice(4)
  return MODES.includes(m) ? m : null
}

function classifyAgentClass(uri) {
  if (!uri) return null
  if (uri === 'foaf:Agent' || uri === FOAF_NS + 'Agent') return 'public'
  if (uri === 'acl:AuthenticatedAgent' || uri === ACL_NS + 'AuthenticatedAgent') return 'authenticated'
  return null
}

function extractAuthorizations(doc) {
  let nodes = []
  if (Array.isArray(doc)) nodes = doc
  else if (doc['@graph']) nodes = Array.isArray(doc['@graph']) ? doc['@graph'] : [doc['@graph']]
  else nodes = [doc]
  const auths = []
  for (const n of nodes) {
    if (!n || typeof n !== 'object') continue
    if (!isAuthorization(n)) continue
    const agents = aclProp(n, 'agent')
    const classes = aclProp(n, 'agentClass').map(classifyAgentClass).filter(Boolean)
    const modes = new Set(aclProp(n, 'mode').map(normaliseMode).filter(Boolean))
    const defaults = aclProp(n, 'default')
    auths.push({ id: n['@id'] || null, agents, classes, modes, hasDefault: defaults.length > 0 })
  }
  return auths
}

function summariseAcl(eff) {
  const auths = extractAuthorizations(eff.doc)
  const me = meWebId()
  let hasPublic = false, hasAuth = false, hasOther = false
  for (const a of auths) {
    if (!a.modes.has('Read')) continue
    if (a.classes.includes('public')) hasPublic = true
    if (a.classes.includes('authenticated')) hasAuth = true
    for (const ag of a.agents) {
      if (ag !== me) hasOther = true
    }
  }
  let kind, chip, label
  if (hasPublic) { kind = 'public'; chip = '🌐'; label = 'Public' }
  else if (hasAuth || hasOther) { kind = 'shared'; chip = '👥'; label = 'Shared' }
  else { kind = 'private'; chip = '🔒'; label = 'Private' }
  return { kind, chip, label, explicit: eff.explicit, inheritedFrom: eff.explicit ? null : eff.accessToUrl }
}

function renderAclChip(url, summary) {
  const li = document.querySelector(`#listing li[data-url="${CSS.escape(url)}"]`)
  if (!li) return
  const chipEl = li.querySelector('.row-acl')
  if (!chipEl) return
  chipEl.textContent = summary.chip
  chipEl.classList.toggle('inherited', !summary.explicit)
  chipEl.classList.toggle('unknown', summary.kind === 'unknown')
  chipEl.classList.remove('loading')
  let tip = `${summary.label}`
  if (summary.kind !== 'unknown') {
    tip += summary.explicit ? ' (this resource)' : ` (inherited from ${summary.inheritedFrom || 'parent'})`
  } else if (summary.error) {
    tip = `Permissions: ${summary.error}`
  }
  tip += ' — click to edit'
  chipEl.title = tip
}

// --- ACL editor ---

async function openAclEditor(targetUrl) {
  if (!targetUrl) return
  if (!meWebId()) {
    showToast('Login required to edit access.', null, null, 3000)
    return
  }
  hidePreview()
  const pane = document.getElementById('acl-editor')
  pane.hidden = false
  const titleEl = document.getElementById('acl-title')
  const metaEl = document.getElementById('acl-meta')
  const bodyEl = document.getElementById('acl-body')
  const name = decodeURIComponent(targetUrl.replace(/\/$/, '').split('/').pop() || '/') +
               (targetUrl.endsWith('/') ? '/' : '')
  titleEl.textContent = `Permissions: ${name}`
  metaEl.innerHTML = '<span>loading…</span>'
  bodyEl.innerHTML = ''
  state.acl.open = true
  state.acl.target = targetUrl
  state.acl.aclUrl = aclUrlFor(targetUrl)
  state.acl.saving = false

  try {
    const eff = await findEffectiveAcl(targetUrl)
    state.acl.inheritedFrom = eff.explicit ? null : eff.accessToUrl
    const auths = extractAuthorizations(eff.doc)
    state.acl.items = auths.map(a => {
      // Each authorization gets one card. Multiple agents/classes on one
      // authorization → split into separate cards for clarity.
      // But for simplicity we just take the first subject and warn if more.
      let subject
      if (a.classes.includes('public')) subject = { type: 'public', value: '' }
      else if (a.classes.includes('authenticated')) subject = { type: 'authenticated', value: '' }
      else if (a.agents.length > 0) subject = { type: 'agent', value: a.agents[0] }
      else subject = { type: 'agent', value: '' }
      return {
        subject,
        modes: new Set(a.modes),
        default: a.hasDefault,
        extraAgents: a.agents.slice(1),     // preserved on save
        extraClasses: a.classes.slice(1)
      }
    })
    renderAclMeta()
    renderAclCards()
  } catch (e) {
    metaEl.innerHTML = `<span class="acl-badge inherited">error</span> <span>${escapeHtml(e.message)}</span>`
    bodyEl.innerHTML = `<div class="acl-empty">Could not load ACL. Save will create a new one.</div>`
    state.acl.inheritedFrom = null
    state.acl.items = []
    renderAclCards()
  }
}

function closeAclEditor() {
  state.acl.open = false
  state.acl.target = null
  state.acl.items = []
  document.getElementById('acl-editor').hidden = true
}

function renderAclMeta() {
  const metaEl = document.getElementById('acl-meta')
  const explicit = !state.acl.inheritedFrom
  metaEl.innerHTML = ''
  const badge = document.createElement('span')
  badge.className = 'acl-badge' + (explicit ? '' : ' inherited')
  badge.textContent = explicit ? 'Explicit' : 'Inherited'
  metaEl.appendChild(badge)
  const note = document.createElement('span')
  if (explicit) {
    note.textContent = `${state.acl.aclUrl}`
  } else {
    note.textContent = `from ${state.acl.inheritedFrom} — save creates an override`
  }
  metaEl.appendChild(note)
}

function renderAclCards() {
  const bodyEl = document.getElementById('acl-body')
  bodyEl.innerHTML = ''
  if (state.acl.items.length === 0) {
    const empty = document.createElement('div')
    empty.className = 'acl-empty'
    empty.textContent = 'No authorizations. Click + Add to grant access.'
    bodyEl.appendChild(empty)
    return
  }
  const isContainer = state.acl.target && state.acl.target.endsWith('/')
  state.acl.items.forEach((item, idx) => {
    bodyEl.appendChild(renderAclCard(item, idx, isContainer))
  })
}

function renderAclCard(item, idx, isContainer) {
  const card = document.createElement('div')
  card.className = 'acl-card'
  card.dataset.idx = idx

  // Subject row
  const r1 = document.createElement('div')
  r1.className = 'acl-card-row'
  r1.innerHTML = `
    <span class="acl-card-label">Who</span>
    <select class="acl-subject-type">
      <option value="agent">Specific WebID</option>
      <option value="public">Public (anyone)</option>
      <option value="authenticated">Authenticated (any logged-in)</option>
    </select>
    <input type="text" class="acl-subject-value" placeholder="https://example.com/profile#me">
  `
  const sel = r1.querySelector('.acl-subject-type')
  const inp = r1.querySelector('.acl-subject-value')
  sel.value = item.subject.type
  inp.value = item.subject.value || ''
  inp.style.display = item.subject.type === 'agent' ? '' : 'none'
  sel.addEventListener('change', () => {
    item.subject.type = sel.value
    inp.style.display = item.subject.type === 'agent' ? '' : 'none'
    if (item.subject.type !== 'agent') item.subject.value = ''
  })
  inp.addEventListener('input', () => { item.subject.value = inp.value.trim() })

  // Modes row
  const r2 = document.createElement('div')
  r2.className = 'acl-card-row'
  r2.innerHTML = `<span class="acl-card-label">Modes</span>`
  for (const m of MODES) {
    const label = document.createElement('label')
    label.className = 'acl-mode' + (item.modes.has(m) ? ' checked' : '')
    const cb = document.createElement('input')
    cb.type = 'checkbox'
    cb.dataset.mode = m
    cb.checked = item.modes.has(m)
    cb.addEventListener('change', () => {
      if (cb.checked) item.modes.add(m); else item.modes.delete(m)
      label.classList.toggle('checked', cb.checked)
    })
    label.appendChild(cb)
    label.appendChild(document.createTextNode(' ' + m))
    r2.appendChild(label)
  }

  // Default + Remove row
  const r3 = document.createElement('div')
  r3.className = 'acl-card-row'
  if (isContainer) {
    const defLabel = document.createElement('label')
    defLabel.className = 'acl-default'
    const defCb = document.createElement('input')
    defCb.type = 'checkbox'
    defCb.checked = item.default
    defCb.addEventListener('change', () => { item.default = defCb.checked })
    defLabel.appendChild(defCb)
    defLabel.appendChild(document.createTextNode(' Apply to contents (default)'))
    r3.appendChild(defLabel)
  }
  const rm = document.createElement('button')
  rm.className = 'acl-remove'
  rm.type = 'button'
  rm.textContent = 'Remove'
  rm.addEventListener('click', () => {
    state.acl.items.splice(idx, 1)
    renderAclCards()
  })
  r3.appendChild(rm)

  card.appendChild(r1)
  card.appendChild(r2)
  card.appendChild(r3)
  return card
}

function aclAddItem() {
  state.acl.items.push({
    subject: { type: 'agent', value: meWebId() || '' },
    modes: new Set(['Read']),
    default: false,
    extraAgents: [],
    extraClasses: []
  })
  renderAclCards()
}

// Serialise current state.acl.items → JSON-LD ACL doc
function serialiseAcl() {
  const target = state.acl.target
  const isContainer = target.endsWith('/')
  const graph = []
  state.acl.items.forEach((item, i) => {
    const node = {
      '@id': `#auth${i}`,
      '@type': 'acl:Authorization',
      'acl:accessTo': { '@id': target }
    }
    if (item.subject.type === 'public') {
      node['acl:agentClass'] = [{ '@id': FOAF_NS + 'Agent' }, ...item.extraClasses.map(c =>
        c === 'public' ? null : c === 'authenticated' ? { '@id': ACL_NS + 'AuthenticatedAgent' } : null
      ).filter(Boolean)]
    } else if (item.subject.type === 'authenticated') {
      node['acl:agentClass'] = [{ '@id': ACL_NS + 'AuthenticatedAgent' }]
    } else {
      const agents = [item.subject.value, ...item.extraAgents].filter(Boolean)
      if (agents.length > 0) node['acl:agent'] = agents.map(a => ({ '@id': a }))
    }
    node['acl:mode'] = [...item.modes].map(m => ({ '@id': ACL_NS + m }))
    if (item.default && isContainer) {
      node['acl:default'] = { '@id': target }
    }
    graph.push(node)
  })
  return {
    '@context': { acl: ACL_NS, foaf: FOAF_NS },
    '@graph': graph
  }
}

function validateAclItems() {
  for (let i = 0; i < state.acl.items.length; i++) {
    const it = state.acl.items[i]
    if (it.modes.size === 0) return `Card ${i + 1}: choose at least one mode.`
    if (it.subject.type === 'agent' && !it.subject.value) return `Card ${i + 1}: enter a WebID.`
    if (it.subject.type === 'agent' && !/^https?:\/\//.test(it.subject.value)) {
      return `Card ${i + 1}: WebID must start with http(s)://`
    }
  }
  // Warn if no one has Control — they'd lock themselves out
  const hasControl = state.acl.items.some(it => it.modes.has('Control'))
  if (!hasControl) {
    if (!confirm('No authorization has Control. You will not be able to edit this ACL again. Continue?')) {
      return 'cancelled'
    }
  }
  return null
}

async function saveAcl() {
  if (state.acl.saving) return
  const err = validateAclItems()
  if (err) {
    if (err !== 'cancelled') showToast(err, null, null, 5000)
    return
  }
  state.acl.saving = true
  const saveBtn = document.getElementById('btn-acl-save')
  saveBtn.disabled = true
  saveBtn.textContent = 'Saving…'
  setBusy(true, 'saving access…')
  try {
    const doc = serialiseAcl()
    const body = JSON.stringify(doc, null, 2)
    const r = await authFetch(state.acl.aclUrl, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/ld+json' },
      body
    })
    if (!r.ok) throw new Error(`PUT ${state.acl.aclUrl} → ${r.status}`)
    aclCache.delete(state.acl.target)
    const target = state.acl.target
    closeAclEditor()
    setBusy(false, 'idle')
    showToast('Saved permissions', null, null, 2500)
    aclEnqueue(target)
  } catch (e) {
    setBusy(false, e.message, 'error')
    showToast(`Couldn't save: ${e.message}`, null, null, 5000)
  } finally {
    state.acl.saving = false
    saveBtn.disabled = false
    saveBtn.textContent = 'Save'
  }
}

function bindAclEditor() {
  document.getElementById('btn-close-acl').addEventListener('click', closeAclEditor)
  document.getElementById('btn-acl-cancel').addEventListener('click', closeAclEditor)
  document.getElementById('btn-acl-add').addEventListener('click', aclAddItem)
  document.getElementById('btn-acl-save').addEventListener('click', saveAcl)
}

// --- popover ---

function togglePopover(force, paneIdx) {
  paneIdx = paneIdx ?? state.activePane
  const pop = paneEl(paneIdx).querySelector('.popover-new')
  const open = force != null ? force : pop.hidden
  // Close any other open popovers first (single popover at a time)
  document.querySelectorAll('.popover-new').forEach(el => { if (el !== pop) el.hidden = true })
  pop.hidden = !open
  if (open) {
    setTimeout(() => {
      document.addEventListener('click', closeOnOutside, { once: true })
    }, 0)
  }
}
function closeOnOutside(e) {
  const host = e.target.closest('.popover-host')
  if (!host) {
    document.querySelectorAll('.popover-new').forEach(el => { el.hidden = true })
  }
}

// --- drag-drop ---

function bindDragDrop() {
  document.querySelectorAll('.pane').forEach(pEl => {
    const paneIdx = parseInt(pEl.dataset.pane, 10)
    const wrap = pEl.querySelector('.listing-wrap')
    const overlay = pEl.querySelector('.drop-overlay')
    let counter = 0
    wrap.addEventListener('dragenter', (e) => {
      if (!e.dataTransfer || !e.dataTransfer.types.includes('Files')) return
      counter++
      overlay.hidden = false
    })
    wrap.addEventListener('dragleave', () => {
      counter--
      if (counter <= 0) {
        counter = 0
        overlay.hidden = true
      }
    })
    wrap.addEventListener('dragover', (e) => {
      if (!e.dataTransfer || !e.dataTransfer.types.includes('Files')) return
      e.preventDefault()
      e.dataTransfer.dropEffect = 'copy'
    })
    wrap.addEventListener('drop', (e) => {
      if (!e.dataTransfer || !e.dataTransfer.files || e.dataTransfer.files.length === 0) return
      e.preventDefault()
      counter = 0
      overlay.hidden = true
      setActivePane(paneIdx)
      uploadFiles(e.dataTransfer.files, paneIdx)
    })
  })
}

// --- toast ---

function showToast(message, actionLabel, actionFn, durationMs = 5000) {
  if (!message) return  // never show an empty toast
  const el = document.getElementById('toast')
  document.getElementById('toast-msg').textContent = message
  const actionBtn = document.getElementById('toast-action')
  if (actionLabel && actionFn) {
    actionBtn.hidden = false
    actionBtn.textContent = actionLabel
    actionBtn.onclick = () => { hideToast(); actionFn() }
  } else {
    actionBtn.hidden = true
    actionBtn.onclick = null
  }
  el.hidden = false
  if (toastTimer) clearTimeout(toastTimer)
  toastTimer = setTimeout(hideToast, durationMs)
}

function hideToast() {
  document.getElementById('toast').hidden = true
  if (toastTimer) { clearTimeout(toastTimer); toastTimer = null }
}

// --- keyboard nav ---

function bindKeyboard() {
  document.addEventListener('keydown', (e) => {
    const tag = (e.target.tagName || '').toLowerCase()
    if (tag === 'input' || tag === 'textarea') return

    const paneIdx = state.activePane
    const p = P(paneIdx)
    const pEl = paneEl(paneIdx)

    if (e.key === 'ArrowDown') {
      e.preventDefault()
      focusItem(p.focusedIndex < 0 ? 0 : Math.min(p.focusedIndex + 1, p.items.length - 1), paneIdx)
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      focusItem(p.focusedIndex < 0 ? p.items.length - 1 : Math.max(p.focusedIndex - 1, 0), paneIdx)
    } else if (e.key === 'Enter') {
      if (p.focusedIndex < 0 || !p.items[p.focusedIndex]) return
      e.preventDefault()
      const id = p.items[p.focusedIndex]['@id']
      if (isContainer(id)) navigateTo(id, { paneIdx })
      else { selectItem(id, paneIdx); openPreview(id).catch(err => setBusy(false, err.message, 'error')) }
    } else if (e.key === 'Tab' && state.split) {
      e.preventDefault()
      setActivePane(state.activePane === 0 ? 1 : 0)
    } else if (e.key === 'Backspace') {
      e.preventDefault()
      const par = parentOf(p.here)
      if (par) navigateTo(par, { paneIdx })
    } else if (e.key === 'Delete' || (e.key === 'Backspace' && e.metaKey)) {
      if (p.focusedIndex < 0 || !p.items[p.focusedIndex]) return
      e.preventDefault()
      const id = p.items[p.focusedIndex]['@id']
      softDelete(id, paneIdx)
    } else if (e.key === 'Escape') {
      e.preventDefault()
      if (state.acl.open) closeAclEditor()
      else hidePreview()
      hideToast()
    } else if (e.key === 'r' || e.key === 'R') {
      e.preventDefault()
      refresh(paneIdx)
    } else if (e.key === '/') {
      e.preventDefault()
      const inp = pEl.querySelector('.url')
      inp.focus(); inp.select()
    } else if (e.key === 'n' || e.key === 'N') {
      e.preventDefault()
      togglePopover(true, paneIdx)
    } else if (e.key === 'u' || e.key === 'U') {
      e.preventDefault()
      document.querySelector(`.file-picker[data-pane="${paneIdx}"]`).click()
    } else if (e.key === 'F2') {
      if (p.focusedIndex < 0 || !p.items[p.focusedIndex]) return
      e.preventDefault()
      const id = p.items[p.focusedIndex]['@id']
      const li = pEl.querySelector(`.listing li[data-url="${CSS.escape(id)}"]`)
      beginRename(li, paneIdx)
    } else if (e.key === 'a' || e.key === 'A') {
      if (p.focusedIndex < 0 || !p.items[p.focusedIndex]) return
      e.preventDefault()
      const id = p.items[p.focusedIndex]['@id']
      openAclEditor(id)
    }
  })
}

function focusItem(index, paneIdx) {
  paneIdx = paneIdx ?? state.activePane
  P(paneIdx).focusedIndex = index
  const items = paneEl(paneIdx).querySelectorAll('.listing li')
  items.forEach((li, i) => {
    li.classList.toggle('kbd-focus', i === index)
  })
  if (items[index]) {
    items[index].scrollIntoView({ block: 'nearest' })
  }
}

// --- sidebar (saved pods) ---
//
// Multi-pod browse: localStorage-backed list of pod origins, rendered
// as a quick-jump column on the left. Click an entry → navigate to its
// /public/ root. Auto-adds whatever origin you successfully navigate to,
// so the list grows organically as you browse.

function loadPods() {
  try {
    const arr = JSON.parse(localStorage.getItem(LS_PODS) || '[]')
    return Array.isArray(arr) ? arr : []
  } catch { return [] }
}

function savePods(pods) {
  try { localStorage.setItem(LS_PODS, JSON.stringify(pods)) } catch {}
}

function podLabelFromOrigin(origin) {
  try { return new URL(origin).host } catch { return origin }
}

function originOfUrl(url) {
  try { return new URL(url).origin } catch { return null }
}

function sidebarAddPod(origin) {
  if (!origin) return false
  const pods = loadPods()
  if (pods.some(p => p.origin === origin)) return false
  pods.push({
    origin,
    label: podLabelFromOrigin(origin),
    addedAt: Date.now()
  })
  savePods(pods)
  renderSidebar()
  return true
}

function sidebarRemovePod(origin) {
  const pods = loadPods().filter(p => p.origin !== origin)
  savePods(pods)
  renderSidebar()
}

function sidebarAutoAdd(url) {
  const o = originOfUrl(url)
  if (o) sidebarAddPod(o)
}

function renderSidebar() {
  const listEl = document.getElementById('sidebar-list')
  if (!listEl) return
  const pods = loadPods()
  listEl.innerHTML = ''
  if (pods.length === 0) {
    listEl.innerHTML = '<li class="sidebar-empty">No pods yet. Add one below or just navigate — visited pods are remembered.</li>'
    return
  }
  // Active if any pane currently shows this origin
  const activeOrigins = new Set(state.panes.map(pp => pp.here ? originOfUrl(pp.here) : null).filter(Boolean))
  const ownOrigin = state.ownPod
  pods.forEach(pod => {
    const li = document.createElement('li')
    li.className = 'sidebar-pod'
    if (activeOrigins.has(pod.origin)) li.classList.add('active')
    if (pod.origin === ownOrigin) li.classList.add('authed')
    li.innerHTML = `
      <span class="sidebar-pod-dot"></span>
      <span class="sidebar-pod-label"></span>
      <button class="sidebar-pod-remove" title="Remove from sidebar">×</button>
    `
    const labelEl = li.querySelector('.sidebar-pod-label')
    labelEl.textContent = pod.label
    labelEl.title = pod.origin
    li.addEventListener('click', (e) => {
      if (e.target.closest('.sidebar-pod-remove')) return
      navigateTo(pod.origin + '/public/')
    })
    li.querySelector('.sidebar-pod-remove').addEventListener('click', (e) => {
      e.stopPropagation()
      sidebarRemovePod(pod.origin)
    })
    listEl.appendChild(li)
  })
}

function sidebarAddPrompt() {
  const raw = prompt('Pod URL (e.g. https://alice.solidcommunity.net):')
  if (!raw) return
  const url = normaliseUrl(raw.trim())
  const origin = originOfUrl(url)
  if (!origin) {
    showToast('Invalid URL.', null, null, 3000)
    return
  }
  sidebarAddPod(origin)
  navigateTo(origin + '/public/')
}

function toggleSidebar(force) {
  const layout = document.querySelector('.layout')
  if (!layout) return
  const collapsed = force != null ? force : !layout.classList.contains('sidebar-collapsed')
  layout.classList.toggle('sidebar-collapsed', collapsed)
  try { localStorage.setItem(LS_SIDEBAR_COLLAPSED, collapsed ? '1' : '0') } catch {}
}

function bindSidebar() {
  document.getElementById('btn-sidebar-add').addEventListener('click', sidebarAddPrompt)
  document.getElementById('btn-sidebar-toggle').addEventListener('click', () => toggleSidebar())
  let collapsed = false
  try { collapsed = localStorage.getItem(LS_SIDEBAR_COLLAPSED) === '1' } catch {}
  if (collapsed) toggleSidebar(true)
  // First-run: seed with the default pod so the sidebar isn't empty
  if (loadPods().length === 0) {
    const def = originOfUrl(defaultUrl())
    if (def) {
      savePods([{ origin: def, label: podLabelFromOrigin(def), addedAt: Date.now() }])
    }
  }
  renderSidebar()
}

// --- init ---

function init() {
  bindButtons()
  bindKeyboard()
  bindDragDrop()
  bindAclEditor()
  bindSidebar()
  renderIdentity()
  watchLogin()
  refreshNavButtons()

  // Pick a starting URL with sensible fallbacks:
  //   1. ?url= query param (deep-link)
  //   2. last visited URL from localStorage
  //   3. logged-in user's pod /public/ (if already authed at init)
  //   4. DEFAULT_URL (http://localhost:4443/)
  const params = new URLSearchParams(location.search)
  let startUrl = params.get('url')
  if (startUrl) startUrl = decodeURIComponent(startUrl)
  if (!startUrl) {
    try { startUrl = localStorage.getItem(LS_LAST_URL) || null } catch { startUrl = null }
  }
  if (!startUrl && meWebId() && state.ownPod) startUrl = state.ownPod + '/public/'
  if (!startUrl) startUrl = defaultUrl()
  // Sync placeholders on both panes
  document.querySelectorAll('.pane .url').forEach(el => { el.placeholder = defaultUrl() })
  updatePaneActiveClass()
  navigateTo(startUrl, { paneIdx: 0 })
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init)
} else {
  init()
}
