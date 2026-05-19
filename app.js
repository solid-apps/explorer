// explorer — solid-apps/explorer
//
// Phase 1: container navigation + JSON-LD-aware preview.
// Single pod, no multi-pod browse yet. xlogin in the topbar; authFetch
// for any read that needs auth (private containers).
//
// Phases beyond this one (see README):
//   2. operations (create / rename / delete / move / trash)
//   3. preview pane media (image/audio/video/PDF)
//   4. ACL editor
//   5. subscribe + multi-user
//   6. upload + drag-drop
//   7. cross-pod browse
//   8. search + bulk

const state = {
  here: null,           // current URL (container or resource)
  history: [],          // back-button stack
  loading: false,
  selectedItem: null,   // child URL currently shown in preview
  ownPod: null,         // derived from xlogin identity when available
  items: [],            // current container's items (for keyboard nav)
  focusedIndex: -1      // keyboard-focused index into items
}

const TRASH_PATH = '/private/.trash/'
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
  const url = normaliseUrl(rawUrl)
  // Validate it parses at all before doing anything else
  try { new URL(url) } catch {
    setBusy(false, `invalid URL: ${rawUrl}`, 'error')
    showToast(`Invalid URL: ${rawUrl}`, null, null, 4000)
    return
  }
  // Push current onto history unless this navigation is from the back button
  if (state.here && !options.fromBack && state.here !== url) {
    state.history.push(state.here)
  }
  state.here = url
  state.selectedItem = null
  syncUrl()
  renderBreadcrumb()
  setBusy(true, `loading ${url}`)
  hidePreview()
  try {
    // Fetch once with JSON-LD preference; decide listing vs preview from
    // the response, not from URL shape. Solid pods return JSON-LD container
    // bodies even when the URL is missing its trailing slash.
    const r = await authFetch(url, { headers: { Accept: 'application/ld+json' } })
    if (!r.ok) throw new Error(`${r.status} ${r.statusText}`)
    const ct = (r.headers.get('content-type') || '').split(';')[0].trim()
    const isLdJson = ct === 'application/ld+json' || ct === 'application/json'

    if (isLdJson) {
      const text = await r.text()
      let doc
      try { doc = JSON.parse(text) } catch { doc = null }
      if (doc && isContainerDoc(doc)) {
        // Normalise URL to have a trailing slash so future navigation works
        if (!url.endsWith('/')) {
          state.here = url + '/'
          syncUrl()
          renderBreadcrumb()
        }
        await renderContainerFromDoc(doc, state.here)
        setBusy(false, 'idle')
        refreshNavButtons()
        return
      }
      // JSON resource (not a container) — show in preview pane
      await openPreviewFromText(state.here, ct, text, r)
      renderEmpty('—')
    } else {
      // Non-JSON resource — open preview, fetch fresh for the right blob
      hidePreview()
      await openPreview(state.here)
      renderEmpty('—')
    }
    setBusy(false, 'idle')
  } catch (e) {
    setBusy(false, e.message, 'error')
    renderEmpty(`Could not load: ${e.message}`)
  }
  refreshNavButtons()
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

async function renderContainerFromDoc(doc, baseUrl) {
  const contains = doc['ldp:contains'] || doc['http://www.w3.org/ns/ldp#contains'] || doc['contains'] || []
  const arr = Array.isArray(contains) ? contains : [contains]
  let items = arr.map(x => {
    if (typeof x === 'string') return { '@id': x }
    return x
  })
  // Filter dotfiles (.acl, .meta, anything starting with .) — same convention as Finder.
  // Tier B / C will add a "show hidden" toggle.
  items = items.filter(item => {
    const id = item['@id']
    if (!id) return false
    const name = id.replace(/\/$/, '').split('/').pop() || ''
    return !name.startsWith('.')
  })
  // Sort: containers first, then by name (so keyboard nav order matches visual order)
  items.sort((a, b) => {
    const ac = isContainer(a['@id']) ? 0 : 1
    const bc = isContainer(b['@id']) ? 0 : 1
    if (ac !== bc) return ac - bc
    return (a['@id'] || '').localeCompare(b['@id'] || '')
  })
  state.items = items
  state.focusedIndex = -1
  renderListing(items, baseUrl)
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

function renderListing(items, baseUrl) {
  const listEl = document.getElementById('listing')
  listEl.innerHTML = ''
  if (items.length === 0) {
    renderEmpty(isContainer(baseUrl) ? 'Empty container.' : 'No items.')
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
    li.innerHTML = `
      <span class="row-name">
        <span class="row-icon ${isC ? 'container' : ''}">${isC ? '▸' : '·'}</span>
        <span class="row-label">${escapeHtml(name)}${isC ? '/' : ''}</span>
      </span>
      <span class="row-meta">${isC ? '—' : formatBytes(size)}</span>
      <span class="row-meta">${formatDate(modified)}</span>
    `
    li.addEventListener('click', (e) => {
      e.preventDefault()
      if (isC) {
        navigateTo(id)
      } else {
        // Open preview without navigation
        selectItem(id)
        openPreview(id).catch(err => setBusy(false, err.message, 'error'))
      }
    })
    li.addEventListener('dblclick', (e) => {
      e.preventDefault()
      // Double-click on resource: navigate to it (full page)
      if (!isC) navigateTo(id)
    })
    listEl.appendChild(li)
  }
}

function renderEmpty(text) {
  const listEl = document.getElementById('listing')
  listEl.innerHTML = `<li class="empty">${escapeHtml(text)}</li>`
}

function selectItem(url) {
  state.selectedItem = url
  const items = document.querySelectorAll('#listing li')
  items.forEach(li => {
    li.classList.toggle('selected', li.dataset.url === url)
  })
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

function renderBreadcrumb() {
  const el = document.getElementById('breadcrumb')
  el.innerHTML = ''
  if (!state.here) return
  let u
  try { u = new URL(state.here) } catch { return }
  const segments = u.pathname.split('/').filter(s => s !== '')
  const origin = u.origin
  const append = (label, href) => {
    const a = document.createElement('a')
    a.textContent = label
    a.href = '#'
    a.addEventListener('click', (e) => {
      e.preventDefault()
      navigateTo(href)
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
  // If we're on a resource (no trailing slash), show the last segment plain
  if (!u.pathname.endsWith('/') && segments.length > 0) {
    // The above loop already added the last segment as a "directory" — strip it & re-add as plain
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

function refreshNavButtons() {
  document.getElementById('btn-back').disabled = state.history.length === 0
  document.getElementById('btn-up').disabled = !parentOf(state.here)
}

function syncUrl() {
  document.getElementById('url').value = state.here || ''
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
    // If we don't have a current URL, default to user's own pod public root
    if (!state.here && state.ownPod) {
      const guess = state.ownPod + '/public/'
      document.getElementById('url').value = guess
    }
  } else {
    pill.hidden = true
  }
}

function watchLogin() {
  let last = meWebId()
  setInterval(() => {
    const now = meWebId()
    if (now !== last) { last = now; renderIdentity() }
  }, 500)
}

// --- buttons ---

function bindButtons() {
  document.getElementById('btn-go').addEventListener('click', () => {
    const v = document.getElementById('url').value.trim()
    if (v) navigateTo(v)
  })
  document.getElementById('url').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      const v = e.target.value.trim()
      if (v) navigateTo(v)
    }
  })
  document.getElementById('btn-up').addEventListener('click', () => {
    const p = parentOf(state.here)
    if (p) navigateTo(p)
  })
  document.getElementById('btn-back').addEventListener('click', () => {
    if (state.history.length === 0) return
    const prev = state.history.pop()
    if (prev) navigateTo(prev, { fromBack: true })
  })
  document.getElementById('btn-refresh').addEventListener('click', () => refresh())
  document.getElementById('btn-close-preview').addEventListener('click', hidePreview)
  document.getElementById('toast-close').addEventListener('click', hideToast)

  // Delegate clicks on links inside the preview body to navigate within the app
  document.getElementById('preview-body').addEventListener('click', (e) => {
    const a = e.target.closest('a[data-link]')
    if (!a) return
    e.preventDefault()
    navigateTo(a.getAttribute('href'))
  })
}

// --- refresh ---

function refresh() {
  if (!state.here) return
  // Re-navigate to current URL without pushing onto history
  navigateTo(state.here, { fromBack: true })
}

// --- delete (soft, with undo) ---

async function softDelete(url) {
  if (!url) return
  if (isContainer(url)) {
    showToast('Cannot delete containers yet (only resources).', null, null, 4000)
    return
  }
  if (!meWebId()) {
    showToast('Login required to delete.', null, null, 3000)
    return
  }
  // Determine the trash destination on the user's own pod
  if (!state.ownPod) {
    showToast('Cannot find your pod root for trash. Login may be incomplete.', null, null, 4000)
    return
  }
  const original = url
  const name = decodeURIComponent(original.replace(/\/$/, '').split('/').pop() || 'untitled')
  const ts = new Date().toISOString().replace(/[:.]/g, '-')
  const trashUrl = `${state.ownPod}${TRASH_PATH}${ts}-${name}`
  setBusy(true, 'moving to trash…')
  try {
    // Read source
    const r = await authFetch(original)
    if (!r.ok) throw new Error(`read source: ${r.status}`)
    const ct = r.headers.get('content-type') || 'application/octet-stream'
    const blob = await r.blob()
    // Write to trash
    const w = await authFetch(trashUrl, {
      method: 'PUT',
      headers: { 'Content-Type': ct },
      body: blob
    })
    if (!w.ok) throw new Error(`write trash: ${w.status}`)
    // Delete original
    const d = await authFetch(original, { method: 'DELETE' })
    if (!d.ok) {
      // Best-effort cleanup of orphaned trash
      authFetch(trashUrl, { method: 'DELETE' }).catch(() => {})
      throw new Error(`delete original: ${d.status}`)
    }
    setBusy(false, 'idle')
    // Refresh listing to drop the deleted item
    refresh()
    // Toast with undo
    showToast(
      `Moved “${name}” to Trash`,
      'Undo',
      () => undoSoftDelete(original, trashUrl, ct),
      8000
    )
  } catch (e) {
    setBusy(false, e.message, 'error')
    showToast(`Couldn't delete: ${e.message}`, null, null, 5000)
  }
}

async function undoSoftDelete(originalUrl, trashUrl, ct) {
  setBusy(true, 'restoring…')
  try {
    const r = await authFetch(trashUrl)
    if (!r.ok) throw new Error(`read trash: ${r.status}`)
    const blob = await r.blob()
    const w = await authFetch(originalUrl, {
      method: 'PUT',
      headers: { 'Content-Type': ct || 'application/octet-stream' },
      body: blob
    })
    if (!w.ok) throw new Error(`restore: ${w.status}`)
    // Clean up the trash copy
    authFetch(trashUrl, { method: 'DELETE' }).catch(() => {})
    setBusy(false, 'idle')
    refresh()
    showToast('Restored', null, null, 2000)
  } catch (e) {
    setBusy(false, e.message, 'error')
    showToast(`Couldn't restore: ${e.message}`, null, null, 5000)
  }
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
    // Don't hijack keys when typing in a text field
    const tag = (e.target.tagName || '').toLowerCase()
    if (tag === 'input' || tag === 'textarea') return

    if (e.key === 'ArrowDown') {
      e.preventDefault()
      focusItem(state.focusedIndex < 0 ? 0 : Math.min(state.focusedIndex + 1, state.items.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      focusItem(state.focusedIndex < 0 ? state.items.length - 1 : Math.max(state.focusedIndex - 1, 0))
    } else if (e.key === 'Enter') {
      if (state.focusedIndex < 0 || !state.items[state.focusedIndex]) return
      e.preventDefault()
      const id = state.items[state.focusedIndex]['@id']
      if (isContainer(id)) navigateTo(id)
      else { selectItem(id); openPreview(id).catch(err => setBusy(false, err.message, 'error')) }
    } else if (e.key === 'Backspace') {
      e.preventDefault()
      const p = parentOf(state.here)
      if (p) navigateTo(p)
    } else if (e.key === 'Delete' || (e.key === 'Backspace' && e.metaKey)) {
      if (state.focusedIndex < 0 || !state.items[state.focusedIndex]) return
      e.preventDefault()
      const id = state.items[state.focusedIndex]['@id']
      softDelete(id)
    } else if (e.key === 'Escape') {
      e.preventDefault()
      hidePreview()
      hideToast()
    } else if (e.key === 'r' || e.key === 'R') {
      e.preventDefault()
      refresh()
    } else if (e.key === '/') {
      e.preventDefault()
      document.getElementById('url').focus()
      document.getElementById('url').select()
    }
  })
}

function focusItem(index) {
  state.focusedIndex = index
  const items = document.querySelectorAll('#listing li')
  items.forEach((li, i) => {
    li.classList.toggle('kbd-focus', i === index)
  })
  if (items[index]) {
    items[index].scrollIntoView({ block: 'nearest' })
  }
}

// --- init ---

function init() {
  bindButtons()
  bindKeyboard()
  renderIdentity()
  watchLogin()
  refreshNavButtons()

  // Take URL from ?url= param if present
  const params = new URLSearchParams(location.search)
  const startUrl = params.get('url')
  if (startUrl) {
    navigateTo(decodeURIComponent(startUrl))
    return
  }
  // Otherwise, if logged in, jump to /public/ on the user's pod
  // (renderIdentity already filled the input with a guess).
  setBusy(false, 'enter a pod URL above')
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init)
} else {
  init()
}
