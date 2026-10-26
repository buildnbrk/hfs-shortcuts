// SPDX-License-Identifier: MIT
'use strict';{
    const { h, React, t } = HFS
    const config = HFS.getPluginConfig() || {}
    const IMAGE_RE = /^(data:|https?:\/\/|\/\/|\/|\.{1,2}\/)/i
    const LAYOUT_KEY = 'hfs_shortcuts_layout'
    const ALIGNS = ['left', 'center', 'right']
    const VIEW_MODES = ['show', 'hide', 'hover'] // per-bar: show / auto-hide / auto-hide + reveal on hover
    const MAX_SHORTCUTS = 250 // per bar; mirrors the server's MAX_LIST
    // 1×1 transparent GIF, used for a deliberately blank tile
    const TRANSPARENT_ICON = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7'

    // Per-bar built-in layout; the admin's Customize settings override these for everyone.
    const BAR_DEFAULTS = {
        main: { columns: 8, iconSize: 32, lineGap: 8, align: 'center', visibility: 'show' },
        header: { columns: 4, iconSize: 64, lineGap: 8, align: 'center', visibility: 'show' },
    }

    function defaultsFor(bar) {
        return BAR_DEFAULTS[bar === 'header' ? 'header' : 'main']
    }

    // the main bar caps its icon size at 64; the header bar may go up to 128
    function iconMaxFor(bar) {
        return bar === 'header' ? 128 : 64
    }

    // the header bar caps "icons across" lower than the main bar
    function columnsMaxFor(bar) {
        return bar === 'header' ? 12 : 24
    }

    function adminDefaults(adminLayout, defaults, maxIcon, maxCols) {
        const out = { ...defaults }
        if (adminLayout && typeof adminLayout === 'object') {
            const cols = num(adminLayout.columns, 1, maxCols)
            if (cols !== undefined) out.columns = cols
            const size = num(adminLayout.iconSize, 16, maxIcon)
            if (size !== undefined) out.iconSize = size
            const gap = num(adminLayout.lineGap, 0, 60)
            if (gap !== undefined) out.lineGap = gap
            if (ALIGNS.includes(adminLayout.align)) out.align = adminLayout.align
            if (VIEW_MODES.includes(adminLayout.visibility)) out.visibility = adminLayout.visibility
        }
        return out
    }

    // Two bars share this component. The admin picks one of four placements for each bar:
    // above the header, below the header, above the file list, below the file list.
    // HFS exposes only three slots (beforeHeader, afterHeader, afterList) and has no
    // "beforeList", so "Below the header" and "Above the file list" share afterHeader — the
    // one spot ahead of the file list. `rank` orders two bars that land on the same slot.
    const POSITIONS = {
        aboveHeader: { slot: 'beforeHeader', rank: 1 },
        belowHeader: { slot: 'afterHeader', rank: 2 },
        aboveList: { slot: 'afterHeader', rank: 3 },
        belowList: { slot: 'afterList', rank: 4 },
    }
    // plain HFS event names, still accepted (saved by an earlier version of this plugin)
    const LEGACY_POSITIONS = { beforeHeader: 'aboveHeader', afterHeader: 'belowHeader', afterList: 'belowList' }
    const DEFAULT_POSITION = { header: 'aboveHeader', main: 'belowList' }

    // any unknown/missing value falls back to the bar's default placement
    function resolvePosition(value, bar) {
        const name = POSITIONS[value] ? value : LEGACY_POSITIONS[value] || DEFAULT_POSITION[bar]
        return POSITIONS[name]
    }

    function mountBar(bar, configured) {
        const { slot, rank } = resolvePosition(configured, bar)
        // inside the shared afterHeader slot a bar placed "above the list" sits closer to the
        // list than one placed "below the header"; the header bar wins a tie (lower goes first)
        const order = rank + (bar === 'main' ? .1 : 0)
        HFS.onEvent(slot, (params, extra) => {
            // setOrder is newer than this plugin's apiRequired, so don't assume it's there
            if (typeof extra?.setOrder === 'function') extra.setOrder(order)
            return h(ShortcutBar, { bar })
        })
    }

    if (config.enabled !== false)
        mountBar('main', config.mainPosition)
    if (config.headerEnabled !== false)
        mountBar('header', config.headerPosition)

    const rest = {
        load: bar => HFS.customRestCall('shortcuts_getAll', { bar }),
        save: (list, bar) => HFS.customRestCall('shortcuts_save', { list, bar }, { timeout: 60 }),
        restore: bar => HFS.customRestCall('shortcuts_restore', { bar }, { timeout: 60 }),
        saveLayout: (layout, bar) => HFS.customRestCall('shortcuts_saveLayout', { layout, bar }, { timeout: 60 }),
    }

    function ShortcutBar({ bar = 'main' }) {
        bar = bar === 'header' ? 'header' : 'main'
        const isHeader = bar === 'header'
        const defaults = defaultsFor(bar)
        const iconMax = iconMaxFor(bar)
        const columnsMax = columnsMaxFor(bar)
        // press-and-hold delay before Customize opens, set by the admin (default 500ms)
        const holdMs = num(config.holdMs, 200, 3000, 500)
        const { username } = HFS.useSnapState()
        const signedIn = Boolean(username)
        const [remote, setRemote] = React.useState(null)
        const [overrides, setOverrides] = React.useState(() => readOverrides(username, bar)) // {} = built-in defaults
        const [editing, setEditing] = React.useState(false)
        const [draft, setDraft] = React.useState(null)
        const [loadError, setLoadError] = React.useState('')
        const [dragList, setDragList] = React.useState(null) // live order while dragging
        const dragFrom = React.useRef(null)
        const dragData = React.useRef(null)
        const dragMoved = React.useRef(false)
        const press = React.useRef({ timer: 0, long: false })
        // debounce layout saves so rapid typing / arrow presses don't spam the server (and race)
        const saveTimer = React.useRef(0)
        const pendingLayout = React.useRef(null)
        const importRef = React.useRef(null) // hidden file input used by the Import button
        // collapsed = showing only the "···"; driven by the bar's Show/Hide/Hover mode
        const [collapsed, setCollapsed] = React.useState(false)
        const importModeRef = React.useRef('replace') // 'replace' | 'add', chosen by the Import dialog
        const barRef = React.useRef(null) // the icons row, so revealing it can scroll to it
        const revealPending = React.useRef(false) // the ··· expanded the bar: scroll it into view

        const reload = React.useCallback(() => {
            rest.load(bar).then(
                res => { setRemote(res); setLoadError('') },
                e => { console.error('shortcuts: load failed', e); setLoadError(errMsg(e)) })
        }, [bar])
        const reloadRef = React.useRef(reload)
        reloadRef.current = reload

        React.useEffect(() => { reload() }, [reload, username])

        // refresh when the backend reports a change (config edit, another tab, shares, ...).
        // Debounced so a burst of changes (e.g. an admin dragging controls) collapses into one reload.
        React.useEffect(() => {
            let source
            let timer = 0
            HFS.getNotifications('shortcuts', () => {
                clearTimeout(timer)
                timer = setTimeout(() => reloadRef.current(), 300)
            }).then(s => { source = s })
            return () => { source?.close(); clearTimeout(timer) }
        }, [])

        // reload every bar in this page after an import rewrites its data
        React.useEffect(() => {
            const onReload = () => reloadRef.current()
            window.addEventListener('shortcuts:reload', onReload)
            return () => window.removeEventListener('shortcuts:reload', onReload)
        }, [])

        React.useEffect(() => { setOverrides(readOverrides(username, bar)) }, [username, bar])

        // the server is the source of truth for a signed-in user's overrides, but never
        // mid-edit: while customizing (or while our own save is in flight) local edits win,
        // otherwise a late/out-of-order response would snap the value to a stale number.
        React.useEffect(() => {
            if (!signedIn || !remote || remote.username !== username) return
            if (editing || pendingLayout.current) return
            const o = sanitizeOverrides(remote.layout, bar)
            setOverrides(o)
            saveLocalOverrides(username, o, bar)
        }, [remote, signedIn, username, bar, editing])

        // cancel any pending save when the bar unmounts
        React.useEffect(() => () => clearTimeout(saveTimer.current), [])

        // this bar's layout: the admin's settings as defaults, with this user's own overrides on top
        const layout = { ...adminDefaults(remote?.adminLayout, defaults, iconMax, columnsMax), ...overrides }
        layout.iconSize = num(layout.iconSize, 16, iconMax, defaults.iconSize) // enforce this bar's cap
        layout.columns = num(layout.columns, 1, columnsMax, defaults.columns)
        layout.lineGap = num(layout.lineGap, 0, 60, defaults.lineGap) // vertical gap between rows
        // show / hide / hover, per user (the admin's choice is the default for everyone)
        const visibility = VIEW_MODES.includes(layout.visibility) ? layout.visibility : 'show'
        const autoHideEff = visibility !== 'show'
        const hoverReveal = visibility === 'hover'
        // (re)collapse to match the mode whenever it changes; the ··· still toggles it at runtime
        React.useEffect(() => { setCollapsed(autoHideEff) }, [autoHideEff])
        const showBar = autoHideEff ? (editing || !collapsed) : true

        // The revealed icons sit *below* the ··· line, so when the ··· is near the bottom of the
        // page the bar would appear off-screen and the click would look like it did nothing.
        // After a reveal, scroll just enough to bring the whole row of icons into view.
        React.useEffect(() => {
            if (collapsed || !revealPending.current) return
            revealPending.current = false
            // the row was just mounted; wait one frame so its height is measurable
            const frame = requestAnimationFrame(() => {
                const el = barRef.current
                if (!el || typeof el.scrollIntoView !== 'function') return
                const viewport = window.innerHeight || document.documentElement.clientHeight || 0
                // a bar taller than the viewport reads better from its first row; otherwise
                // 'nearest' scrolls only as far as needed to show the whole bar
                const tall = el.getBoundingClientRect().height > viewport * .9
                const reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches
                el.scrollIntoView({ block: tall ? 'start' : 'nearest', behavior: reduce ? 'auto' : 'smooth' })
            })
            return () => cancelAnimationFrame(frame)
        }, [collapsed])

        if (config.showForGuests === false && !signedIn)
            return null
        // the backend tells us whether this account is an admin; the snap-state value isn't the
        // current user's boolean, so use the authoritative one from the server reply
        const admin = remote?.isAdmin === true
        // an admin can lock a bar so non-admins can't add shortcuts or change the shared layout
        const locked = remote ? remote.locked === true : (isHeader ? config.lockHeader === true : config.lockMain === true)
        const canEditList = signedIn && (admin || !locked)
        const listEditing = canEditList && editing

        // one combined list: the admin's shared icons lead, then your own
        const own = signedIn ? (remote?.mine || []) : []
        const sharedAll = remote?.shared || []
        const ownByUrl = new Set(own.map(o => o.url)) // dedupes a shared icon you also have yourself
        const hiddenShared = new Set(overrides.hiddenShared || [])
        const edits = new Map((overrides.edits || []).map(e => [e.from, e]))
        const combined = []
        // the admin's shared icons come first (so a restored bar shows them ahead of your own)
        for (const s of sharedAll) {
            if (ownByUrl.has(s.url) || hiddenShared.has(s.url)) continue
            const e = edits.get(s.url)
            const item = e ? { ...s, icon: e.icon, label: e.label, url: e.url, wide: e.wide === true, zoom: e.zoom } : s
            // shared items carry their own order key (so shared blank/spacer tiles keep their spot)
            const ok = s.orderKey || s.url
            combined.push({ item, index: null, from: s.url, orderKey: ok, key: 'sx:' + ok })
        }
        // orderKey is normally the URL, but URL-less (blank) tiles get a unique index-based key
        own.forEach((o, i) => combined.push({ item: o, index: i, from: null, orderKey: o.url || ('blank:' + i), key: 'o' + i }))

        // display order: the live drag order wins; otherwise the saved order
        const items = dragList || orderItems(combined)

        function orderItems(list) {
            const saved = overrides.order || []
            if (!saved.length) return list
            const at = new Map(saved.map((u, i) => [u, i]))
            const pos = u => (at.has(u) ? at.get(u) : Infinity)
            return list.slice().sort((a, b) => pos(a.orderKey) - pos(b.orderKey)) // stable
        }

        function persist(next) {
            if (!signedIn) return
            rest.save(next, bar).then(setRemote, e => HFS.toast(errMsg(e), 'error'))
        }

        // Persist the layout, debounced: rapid typing / arrow presses collapse into one save,
        // so the server can't race the user with out-of-order responses.
        function flushLayout() {
            if (!pendingLayout.current) return
            clearTimeout(saveTimer.current)
            saveTimer.current = 0
            const next = pendingLayout.current
            rest.saveLayout(next, bar).then(
                res => { pendingLayout.current = null; setRemote(res) },
                e => { pendingLayout.current = null; HFS.toast(errMsg(e), 'error') })
        }

        function applyOverrides(next) {
            setOverrides(next)
            saveLocalOverrides(username, next, bar)
            if (!signedIn) return
            pendingLayout.current = next
            clearTimeout(saveTimer.current)
            saveTimer.current = setTimeout(flushLayout, 500)
        }

        function changeLayout(key, value) {
            applyOverrides(sanitizeOverrides({ ...overrides, [key]: value }, bar))
            if (key === 'visibility') setCollapsed(value !== 'show')
        }

        // click reveals/hides the icons; press-and-hold opens Customize
        function menuClick() {
            if (press.current.long) { press.current.long = false; return }
            if (editing) { setEditing(false); setDraft(null); return }
            if (autoHideEff) {
                if (collapsed) revealPending.current = true // reveal: scroll the icons into view
                setCollapsed(v => !v)
                return
            }
            if (canEditList) setEditing(true)
        }
        function menuDown() {
            if (!canEditList) return
            press.current.long = false
            press.current.timer = setTimeout(() => {
                press.current.long = true
                setEditing(true)
            }, holdMs)
        }
        function menuUp() {
            clearTimeout(press.current.timer)
        }

        // the ··· is hidden when there are icons and auto-hide is off, so the same gestures
        // on any icon open Customize
        function tileDown() {
            if (!canEditList || listEditing) return
            press.current.long = false
            press.current.timer = setTimeout(() => { press.current.long = true; setEditing(true) }, holdMs)
        }
        function tileUp() { clearTimeout(press.current.timer) }

        async function confirmRemove(item) {
            const name = item && (item.label || item.url) ? '\n' + (item.label || item.url) : ''
            return ask(t('shortcuts_remove_confirm', 'Remove this shortcut?') + name, { skippable: true })
        }

        async function removeAt(index) {
            if (!await confirmRemove(own[index])) return
            persist(own.filter((_, i) => i !== index))
        }

        function toggleShare(index) {
            persist(own.map((x, i) => i === index ? { ...x, share: !x.share } : x))
        }

        async function hideShared(url) {
            if (!await ask(t('shortcuts_hide_confirm', 'Hide this shared shortcut?'), { skippable: true }))
                return
            const cur = overrides.hiddenShared || []
            if (!cur.includes(url))
                applyOverrides(sanitizeOverrides({ ...overrides, hiddenShared: [...cur, url] }, bar))
        }

        function openNew(base) {
            setDraft({ index: null, from: null, icon: '', label: '', url: '', wide: false, zoom: 100, ...base })
        }

        function saveDraft(item) {
            const { index, from } = draft
            setDraft(null)
            if (index != null) { persist(own.map((x, i) => i === index ? item : x)); return }
            if (from) { // an edit of a shared icon: kept for this user only
                const next = (overrides.edits || []).filter(e => e.from !== from)
                next.push({ from, icon: item.icon, label: item.label, url: item.url, wide: item.wide === true, zoom: item.zoom })
                applyOverrides(sanitizeOverrides({ ...overrides, edits: next }, bar))
                return
            }
            // new shortcut: append it to your list and pin it at the end of the current order
            const newKey = item.url || ('blank:' + own.length) // must match the combined orderKey
            persist([...own, item])
            const keys = items.map(w => w.orderKey)
            if (!keys.includes(newKey)) keys.push(newKey)
            applyOverrides(sanitizeOverrides({ ...overrides, order: keys }, bar))
        }

        async function deleteDraft() {
            const { index, from } = draft
            if (index != null && !await confirmRemove(own[index])) return
            setDraft(null)
            if (index != null) { persist(own.filter((_, i) => i !== index)); return }
            if (from) // drop the personal edit → the admin's original shows again
                applyOverrides(sanitizeOverrides({ ...overrides, edits: (overrides.edits || []).filter(e => e.from !== from) }, bar))
        }

        // pointer-based reordering (native HTML5 drag is unreliable inside HFS)
        function startDrag(e, pos) {
            if (!listEditing) return
            e.preventDefault()
            e.stopPropagation()
            dragFrom.current = pos
            dragData.current = items.slice()
            dragMoved.current = false
            setDragList(dragData.current)
            window.addEventListener('pointermove', onDragMove)
            window.addEventListener('pointerup', onDragUp, { once: true })
            window.addEventListener('pointercancel', onDragUp, { once: true })
        }

        // data-own-index holds the on-screen position of each tile while customizing
        function indexFromPoint(x, y) {
            const el = document.elementFromPoint(x, y)
            const tile = el && el.closest && el.closest('.shortcut[data-own-index]')
            const n = tile && Number(tile.getAttribute('data-own-index'))
            return Number.isInteger(n) ? n : -1
        }

        function onDragMove(e) {
            const list = dragData.current
            if (!list) return
            const to = indexFromPoint(e.clientX, e.clientY)
            const from = dragFrom.current
            if (to < 0 || to >= list.length || to === from) return
            const next = list.slice()
            const [moved] = next.splice(from, 1)
            next.splice(to, 0, moved)
            dragData.current = next
            dragFrom.current = to
            dragMoved.current = true
            setDragList(next)
        }

        function onDragUp() {
            window.removeEventListener('pointermove', onDragMove)
            const list = dragData.current
            dragData.current = null
            dragFrom.current = null
            setDragList(null)
            if (list && dragMoved.current)
                // remember the order for this user (leaving the default order)
                applyOverrides(sanitizeOverrides({ ...overrides, order: list.map(w => w.orderKey) }, bar))
            dragMoved.current = false
        }

        // internal links (starting with "/") stay in the same tab for the header nav; all else opens a new one
        function linkTarget(url) {
            if (isHeader && /^\//.test(String(url || ''))) return '_self'
            return '_blank'
        }

        // index = position in the user's own list (null for a shared icon); pos = on-screen position
        function renderTile(item, key, index, pos, from) {
            const editingTile = listEditing && index != null // your own icon: edit/remove/share
            const dragging = dragList && dragFrom.current === pos && pos != null
            // a tile without a URL (blank/spacer) isn't a link: don't render an anchor or its hover box
            const href = safeUrl(item.url)
            const props = {
                key,
                className: 'shortcut'
                    + (listEditing ? ' shortcut-editing' : '')
                    + (index == null ? ' shortcut-shared' : '')
                    + (href ? '' : ' shortcut-nolink')
                    + (item.wide ? ' shortcut-wide' : '')
                    + (dragging ? ' shortcut-dragging' : ''),
                title: item.label || item.url,
                style: { '--shortcut-zoom': String((item.zoom || 100) / 100) },
            }
            if (listEditing) props['data-own-index'] = pos // every tile is a drop target
            const innerProps = {
                className: 'shortcut-link', draggable: false,
                onPointerDown: tileDown, onPointerUp: tileUp, onPointerLeave: tileUp,
                onClick: e => {
                    if (listEditing) { e.preventDefault(); return } // don't open while editing
                    if (press.current.long) { press.current.long = false; e.preventDefault(); return }
                    if (!editing && autoHideEff) setCollapsed(true) // back to ··· after opening
                },
            }
            if (href) Object.assign(innerProps, {
                href, target: linkTarget(item.url), rel: 'noopener',
            })
            return h('div', props,
                h(href ? 'a' : 'span', innerProps, h(IconView, { icon: item.icon })),
                editingTile && admin && h('button', {
                    type: 'button', title: t('shortcuts_share', 'Share with everyone'),
                    className: 'shortcut-btn shortcut-share' + (item.share ? ' on' : ''),
                    onClick: () => toggleShare(index),
                }, item.share ? '✔' : ''),
                editingTile && h('button', {
                    type: 'button', className: 'shortcut-btn shortcut-edit', title: t('shortcuts_edit', 'Edit'),
                    onClick: () => setDraft({ index, from: null, icon: item.icon || '', label: item.label || '', url: item.url || '', wide: item.wide === true, zoom: item.zoom }),
                }, '✎'),
                listEditing && index == null && h('button', {
                    type: 'button', className: 'shortcut-btn shortcut-edit', title: t('shortcuts_edit_shared', 'Edit for me (the admin’s icon is unchanged)'),
                    onClick: () => setDraft({ index: null, from, icon: item.icon || '', label: item.label || '', url: item.url || '', wide: item.wide === true, zoom: item.zoom }),
                }, '✎'),
                editingTile && h('button', {
                    type: 'button', className: 'shortcut-btn shortcut-remove', title: t('shortcuts_remove', 'Remove'),
                    onClick: () => removeAt(index),
                }, '×'),
                listEditing && index == null && h('button', {
                    type: 'button', className: 'shortcut-btn shortcut-remove', title: t('shortcuts_hide', 'Hide'),
                    onClick: () => hideShared(from),
                }, '×'),
                listEditing && h('button', {
                    type: 'button', className: 'shortcut-btn shortcut-move', title: t('shortcuts_move', 'Drag to reorder'),
                    onPointerDown: e => startDrag(e, pos),
                    onClick: e => e.preventDefault(),
                }, '⠿'),
            )
        }

        function renderBar(items, lay, editable) {
            const cols = num(lay.columns, 1, columnsMax, defaults.columns)
            const rowGap = num(lay.lineGap, 0, 60, defaults.lineGap)
            const isEditing = editable && listEditing
            return h('div', {
                ref: barRef,
                className: 'shortcuts-bar columns'
                    + (isEditing ? ' editing' : ''),
                style: {
                    justifyContent: justifyFor(lay.align),
                    columnGap: '0',
                    rowGap: rowGap + 'px',
                    '--shortcut-icon': lay.iconSize + 'px',
                    '--shortcut-columns': String(cols),
                },
            },
                items.map((w, pos) => renderTile(w.item, w.key, w.index, pos, w.from)),
                isEditing && h('button', {
                    type: 'button', className: 'shortcut shortcut-add', title: t('shortcuts_add', 'Add shortcut'),
                    onClick: () => openNew({}),
                }, '+'),
            )
        }

        // ---- export (both bars) / import (current bar) the user's own shortcuts ----

        // popup with the three import choices, applied to the bar you're customizing
        async function chooseImportAction() {
            const d = HFS.dialogLib
            if (!d || typeof d.newDialog !== 'function') return null
            return new Promise(resolve => {
                d.newDialog({
                    className: 'dialog-confirm',
                    icon: '?',
                    title: t('shortcuts_import_title', 'Import'),
                    onClose: resolve,
                    Content: () => h('div', {},
                        h('p', {}, t('shortcuts_import_choose', 'Import into this bar:')),
                        h('div', { className: 'shortcuts-import-actions' },
                            h('button', { type: 'button', onClick: () => d.closeDialog('replace') }, t('shortcuts_import_replace', 'Replace')),
                            h('button', { type: 'button', onClick: () => d.closeDialog('add') }, t('shortcuts_import_add', 'Add')),
                            h('button', { type: 'button', onClick: () => d.closeDialog('restore') }, t('shortcuts_restore', 'Restore')),
                        )),
                })
            })
        }

        async function onImportClick() {
            const action = await chooseImportAction()
            if (action === 'restore')
                return onRestore()
            if (action === 'replace' || action === 'add') {
                importModeRef.current = action
                importRef.current?.click()
            }
        }

        // Export all of the user's own shortcuts (both bars), after a confirmation
        async function onExportShortcuts() {
            if (!await ask(t('shortcuts_export_confirm', 'Export all your shortcuts (both bars) to a file?')))
                return
            try {
                const [mainRes, headerRes] = await Promise.all([rest.load('main'), rest.load('header')])
                // include each bar's saved order so positions are restored on import
                const pack = res => {
                    const lay = (res && res.layout) || {}
                    const out = { list: (res && res.mine) || [] }
                    if (Array.isArray(lay.order) && lay.order.length) out.order = lay.order
                    return out
                }
                const bars = { main: pack(mainRes), header: pack(headerRes) }
                const payload = { app: 'hfs-shortcuts', version: 2, exportedAt: new Date().toISOString(), bars }
                const stamp = new Date().toISOString().slice(0, 10)
                downloadJson('hfs-shortcuts-' + (username || 'user') + '-' + stamp + '.json', payload)
            }
            catch (e) { HFS.toast(errMsg(e), 'error') }
        }

        async function onImportFile(e) {
            const input = e.target
            const file = input.files && input.files[0]
            input.value = '' // let the same file be picked again later
            if (!file) return
            let data
            try { data = await readJsonFile(file) }
            catch { return void HFS.toast(t('shortcuts_import_bad', "That file isn't valid JSON"), 'error') }
            const bars = data && typeof data === 'object' && data.bars && typeof data.bars === 'object' ? data.bars
                : Array.isArray(data) ? { main: data } : null
            // a bar is either a bare array (older files) or { list, order? }
            const barData = v => Array.isArray(v) ? { list: v }
                : (v && typeof v === 'object' && Array.isArray(v.list)) ? v : null
            // Import targets the bar you're customizing
            const d = bars && barData(bars[bar])
            if (!d)
                return void HFS.toast(t('shortcuts_import_invalid', 'That file has no shortcuts for this bar'), 'error')
            const add = importModeRef.current === 'add'
            if (!await ask(add
                ? t('shortcuts_import_confirm_add', 'Add the imported shortcuts to this bar?')
                : t('shortcuts_import_confirm', 'Replace this bar\u2019s shortcuts with the imported ones?')))
                return
            try {
                let list = cleanShortcutList(d.list)
                if (add) { // merge with this bar's current list, skipping duplicate URLs
                    const cur = await rest.load(bar).then(r => r?.mine || [], () => [])
                    list = mergeShortcuts(cleanShortcutList(cur), list)
                }
                if (list.length > MAX_SHORTCUTS) {
                    HFS.toast(t('shortcuts_import_capped', 'Only the first 250 shortcuts per bar were kept'), 'warning')
                    list = list.slice(0, MAX_SHORTCUTS)
                }
                await rest.save(list, bar)
                // restore the saved positions (Replace only; Add keeps your current order)
                if (!add && Array.isArray(d.order) && d.order.length)
                    await patchBarOverrides(bar, { order: d.order })
                reload()
                HFS.toast(t('shortcuts_imported', 'Shortcuts imported'), 'info')
            }
            catch (err) { HFS.toast(errMsg(err), 'error') }
        }

        // write a per-bar override patch: the bar being customized updates its local state and
        // flushes the save immediately (so a following reload can't race the debounce); other
        // bars are updated over REST
        async function patchBarOverrides(b, patch) {
            if (b === bar) {
                applyOverrides(sanitizeOverrides({ ...overrides, ...patch }, bar))
                flushLayout() // save now instead of waiting for the debounce
                return
            }
            const res = await rest.load(b).catch(() => null)
            const cur = (res && res.layout) || {}
            await rest.saveLayout(sanitizeOverrides({ ...cur, ...patch }, b), b)
        }

        // Bring back shortcuts that were removed, without deleting anything the user or the
        // admins added, and reset the bar's positions: a user gets back the admin's shared icons
        // they hid; an admin gets back the shipped default icons missing from their list, at their
        // original spots. Deleting is done in Customize. Applies to the current bar.
        async function onRestore() {
            if (!await ask(admin
                ? t('shortcuts_restore_confirm_admin', "Restore the default shortcuts that come with the plugin and reset their positions? Your own and your users' shortcuts are kept.")
                : t('shortcuts_restore_confirm', "Restore the shortcuts the admin shares that you removed and reset their positions? Your own shortcuts are kept.")))
                return
            try {
                await rest.restore(bar)
                // while customizing, this bar's overrides aren't refreshed from the server reply,
                // so clear them locally too: drop the custom order (and, for a user, the hidden
                // shared icons), showing the restored icons in the default order right away
                const next = sanitizeOverrides({ ...overrides }, bar)
                delete next.order
                if (!admin) delete next.hiddenShared
                setOverrides(next)
                saveLocalOverrides(username, next, bar)
                reload()
                HFS.toast(t('shortcuts_restored', 'Shortcuts restored'), 'info')
            }
            catch (e) { HFS.toast(errMsg(e), 'error') }
        }

        const noIcons = !combined.length
        // in HFS tiles mode the bars span the full width; each bar can opt out in the admin panel
        const tilesOff = isHeader ? config.disableTilesHeader === true : config.disableTilesMain === true
        // in 'hover' mode the bar reveals while the pointer is over it instead of showing the ··· button
        const hoverHidden = hoverReveal && autoHideEff && !editing
        // show the ··· while auto-hiding (to toggle) or when there are no icons (to add)
        const showMenu = noIcons || (autoHideEff && !hoverReveal)
        return h('div', {
            className: 'shortcuts-wrap'
                + (tilesOff ? ' shortcuts-tiles-off' : '')
                + (hoverHidden && collapsed ? ' shortcuts-hover-strip' : ''),
            onMouseEnter: hoverHidden ? () => setCollapsed(false) : undefined,
            onMouseLeave: hoverHidden ? () => setCollapsed(true) : undefined,
        },
            h('input', {
                type: 'file', accept: '.json,application/json', ref: importRef,
                style: { display: 'none' }, onChange: onImportFile,
            }),
            editing && h(LayoutControls, {
                    // while editing, the "···" is replaced by the settings box
                    layout,
                    iconMax,
                    columnsMax,
                    onChange: changeLayout,
                    onExport: onExportShortcuts,
                    onImport: onImportClick,
                    onReset: async () => {
                        if (!await ask(admin
                            ? t('shortcuts_reset_confirm_admin', 'Reset your layout settings?')
                            : t('shortcuts_reset_confirm', 'Reset your layout to the admin’s settings?')))
                            return
                        // clear only the layout settings; leave the icon list, order and
                        // hidden/edited shared icons untouched (icon restore lives in Export / Import)
                        const next = { ...overrides }
                        delete next.iconSize
                        delete next.columns
                        delete next.lineGap
                        delete next.align
                        delete next.visibility
                        applyOverrides(sanitizeOverrides(next, bar))
                    },
                    onDone: () => { flushLayout(); setEditing(false); setDraft(null) },
                }),
            !editing && showMenu && h('div', { className: 'shortcuts-menu-row', style: { justifyContent: justifyFor(layout.align) } },
                    h('button', {
                        type: 'button',
                        className: 'shortcut shortcut-menu',
                        title: canEditList
                            ? (autoHideEff
                                ? t('shortcuts_menu_hint', 'Click to show/hide · press and hold to customize')
                                : t('shortcuts_menu_hint_add', 'Customize to add shortcuts'))
                            : (autoHideEff ? t('shortcuts_menu_hint_guest', 'Click to show/hide') : t('shortcuts_none', 'No shortcuts')),
                        onClick: menuClick,
                        onPointerDown: menuDown,
                        onPointerUp: menuUp,
                        onPointerLeave: menuUp,
                    }, '···'),
                ),
            showBar && renderBar(items, layout, canEditList),
            showBar && noIcons && loadError && h('span', { className: 'shortcuts-empty' },
                t('shortcuts_load_error', 'Could not load shortcuts: ') + loadError),
            draft && h(Editor, {
                draft,
                onCancel: () => setDraft(null),
                onSave: saveDraft,
                onDelete: deleteDraft,
            }),
        )
    }

    function justifyFor(align) {
        return align === 'center' ? 'center' : align === 'right' ? 'flex-end' : 'flex-start'
    }

    // inline layout controls shown while in Customize mode
    function LayoutControls({ layout, iconMax, columnsMax, onChange, onReset, onDone, onExport, onImport }) {
        function field(key, min, max, label) {
            return h(NumberField, { min, max, label, value: layout[key], onCommit: v => onChange(key, v) })
        }
        return h('div', { className: 'shortcuts-settings' },
            h('div', { className: 'shortcuts-settings-fields' },
                h('button', {
                    type: 'button', className: 'shortcuts-reset', onClick: onReset,
                }, t('shortcuts_reset', 'Reset')),
                field('columns', 1, columnsMax, t('shortcuts_columns', 'Icons across')),
                field('iconSize', 16, iconMax, t('shortcuts_icon_size', 'Icon size (px)')),
                field('lineGap', 0, 60, t('shortcuts_line_gap', 'Line gap (px)')),
                h('label', {}, t('shortcuts_align', 'Alignment'),
                    h('select', {
                        value: layout.align,
                        onChange: e => onChange('align', e.target.value),
                    },
                        h('option', { value: 'left' }, t('left', 'Left')),
                        h('option', { value: 'center' }, t('center', 'Center')),
                        h('option', { value: 'right' }, t('right', 'Right')),
                    )),
                h('label', {}, t('shortcuts_visibility', 'Bar'),
                    h('select', {
                        value: layout.visibility || 'show',
                        onChange: e => onChange('visibility', e.target.value),
                    },
                        h('option', { value: 'show' }, t('shortcuts_vis_show', 'Show')),
                        h('option', { value: 'hide' }, t('shortcuts_vis_hide', 'Hide')),
                        h('option', { value: 'hover' }, t('shortcuts_vis_hover', 'Hover')),
                    )),
                h('button', { type: 'button', className: 'shortcuts-export', onClick: onExport }, t('shortcuts_export', 'Export')),
                h('button', { type: 'button', className: 'shortcuts-import', onClick: onImport }, t('shortcuts_import', 'Import')),
                h('button', { type: 'button', className: 'shortcuts-done', onClick: onDone }, t('shortcuts_done', 'Done')),
            ),
        )
    }

    // number input that doesn't snap while typing: commits on blur/Enter, with a live preview when in range
    function NumberField({ value, min, max, label, onCommit }) {
        const [text, setText] = React.useState(String(value))
        const focused = React.useRef(false)
        // mirror external changes only when the field isn't being edited, so the value
        // never jumps/teleports under the user while they type or hold the arrows
        React.useEffect(() => {
            if (!focused.current) setText(String(value))
        }, [value])
        function commit() {
            const v = num(text, min, max, value)
            setText(String(v))
            if (v !== value) onCommit(v)
        }
        return h('label', {}, label,
            h('input', {
                type: 'number', min, max, value: text,
                onFocus: () => { focused.current = true },
                onChange: e => {
                    const raw = e.target.value
                    setText(raw)
                    const v = Number(raw)
                    if (raw !== '' && Number.isFinite(v) && v >= min && v <= max) onCommit(Math.round(v))
                },
                onBlur: () => { focused.current = false; commit() },
                onKeyDown: e => { if (e.key === 'Enter') { e.preventDefault(); commit() } },
            }))
    }

    function Editor({ draft, onCancel, onSave, onDelete }) {
        const isNew = draft.index == null && !draft.from
        const [icon, setIcon] = React.useState(draft.icon || '')
        const [label, setLabel] = React.useState(draft.label || '')
        const [url, setUrl] = React.useState(draft.url || '')
        const [wide, setWide] = React.useState(draft.wide === true)
        const [zoom, setZoom] = React.useState(draft.zoom === undefined ? 100 : draft.zoom)
        // follow the site icon automatically until the user picks an icon of their own
        const [auto, setAuto] = React.useState(() => !draft.icon || draft.icon === faviconFor(draft.url))
        const iconIsData = icon.startsWith('data:')

        function changeUrl(value) {
            setUrl(value)
            if (auto) setIcon(faviconFor(value))
        }

        function changeIcon(value) {
            setAuto(false)
            setIcon(value)
        }

        // a deliberate blank tile: a transparent icon and no link
        function useBlank() {
            setAuto(false)
            setIcon(TRANSPARENT_ICON)
            setUrl('')
            setLabel('')
        }

        function submit(e) {
            e.preventDefault()
            const raw = url.trim()
            const clean = raw ? safeUrl(raw) : '' // an empty URL is allowed (a blank/spacer tile)
            if (raw && !clean) // a non-web scheme (javascript:, data:, …) would be a script-injection risk
                return void HFS.toast(t('shortcuts_url_invalid', 'Enter a web address (http:// or https://) or a site path starting with /'), 'warning')
            if (clean && !/^[a-z][a-z0-9+.-]*:/i.test(clean) && !clean.startsWith('/'))
                HFS.toast(t('shortcuts_url_relative', 'Tip: this looks like a relative address'), 'info')
            onSave({ icon: icon.trim(), label: label.trim(), url: clean, wide, zoom })
        }

        return h('div', {
            className: 'shortcuts-editor',
            onClick: e => { if (e.target === e.currentTarget) onCancel() },
        },
            h('form', { onSubmit: submit },
                h('h3', {}, draft.from ? t('shortcuts_edit_shared_title', 'Edit for yourself')
                    : isNew ? t('shortcuts_new', 'New shortcut')
                        : t('shortcuts_edit_title', 'Edit shortcut')),
                h('label', {}, t('shortcuts_url', 'URL'),
                    h('input', { type: 'text', value: url, placeholder: 'https://example.com', onChange: e => changeUrl(e.target.value) }),
                ),
                h('label', {}, t('shortcuts_icon', 'Icon'),
                    h('div', { className: 'shortcuts-icon-picker' },
                        h('div', { className: 'shortcuts-icon-preview', style: { '--shortcut-zoom': String(zoom / 100) } }, h(IconView, { icon })),
                        h('input', {
                            type: 'file', accept: 'image/*',
                            onChange: e => {
                                const f = e.target.files?.[0]
                                if (f) { setAuto(false); fileToIcon(f, wide).then(setIcon, () => HFS.toast(t('shortcuts_bad_image', "Couldn't read that image"), 'error')) }
                            },
                        }),
                    ),
                ),
                h('label', {}, t('shortcuts_icon_hint', 'Emoji or image URL'),
                    h('input', {
                        type: 'text', value: iconIsData ? '' : icon, placeholder: '🔗  https://…/icon.png',
                        onChange: e => changeIcon(e.target.value),
                    }),
                ),
                h('div', { className: 'shortcuts-autoicon' },
                    auto ? h('span', {}, t('shortcuts_icon_auto', 'Icon is taken from the site automatically'))
                        : h('button', { type: 'button', className: 'as-text', onClick: () => { setAuto(true); setIcon(faviconFor(url)) } }, t('shortcuts_icon_use_site', 'Use the site icon')),
                    h('button', { type: 'button', className: 'as-text', onClick: useBlank }, t('shortcuts_icon_blank', 'Blank tile')),
                ),
                h(IconCandidates, { url, onPick: changeIcon }),
                h('label', {}, t('shortcuts_label', 'Label (optional)'),
                    h('input', { type: 'text', value: label, onChange: e => setLabel(e.target.value) }),
                ),
                h('div', { className: 'shortcuts-inline' },
                    h('label', { className: 'shortcuts-check' },
                        h('input', {
                            type: 'checkbox', checked: wide,
                            onChange: e => setWide(e.target.checked),
                        }),
                        t('shortcuts_wide', 'Wide (2 columns)')),
                    h(NumberField, {
                        min: 10, max: 500, label: t('shortcuts_zoom', 'Zoom %'),
                        value: zoom, onCommit: setZoom,
                    })),
                h('div', { className: 'shortcuts-editor-buttons' },
                    h('button', { type: 'submit' }, t('save', 'Save')),
                    h('button', { type: 'button', className: 'as-text', onClick: onCancel }, t('cancel', 'Cancel')),
                    !isNew && h('button', { type: 'button', className: 'danger', onClick: onDelete },
                        draft.from ? t('shortcuts_restore', 'Restore original') : t('delete', 'Delete')),
                ),
            ),
        )
    }

    // renders an icon, falling back to a link emoji if the image can't load
    function IconView({ icon }) {
        const [failed, setFailed] = React.useState(false)
        React.useEffect(() => { setFailed(false) }, [icon])
        if (icon && IMAGE_RE.test(icon) && !failed)
            return h('img', {
                className: 'shortcut-img', src: icon, alt: '', draggable: false,
                // keep the HFS page URL out of the favicon provider's logs, and don't
                // request icons that aren't on screen yet
                referrerPolicy: 'no-referrer', loading: 'lazy',
                onError: () => setFailed(true),
            })
        return h('span', { className: 'shortcut-emoji' }, icon && !IMAGE_RE.test(icon) ? icon : '🔗')
    }

    // best-effort site icon for an absolute http(s) URL, via DuckDuckGo's icon service
    function faviconFor(url) {
        const host = absoluteHost(url)
        return host ? 'https://icons.duckduckgo.com/ip3/' + encodeURIComponent(host) + '.ico' : ''
    }

    // ---- candidate icons for the editor picker ----
    // Simple Icons slugs for hosts whose product icon differs from the base brand (e.g. Google apps)
    const SIMPLE_ICON_HOSTS = {
        'google.com': 'google',
        'drive.google.com': 'googledrive',
        'docs.google.com': 'googledocs',
        'sheets.google.com': 'googlesheets',
        'slides.google.com': 'googleslides',
        'maps.google.com': 'googlemaps',
        'mail.google.com': 'gmail',
        'calendar.google.com': 'googlecalendar',
        'photos.google.com': 'googlephotos',
        'news.google.com': 'googlenews',
        'translate.google.com': 'googletranslate',
        'play.google.com': 'googleplay',
        'meet.google.com': 'googlemeet',
        'keep.google.com': 'googlekeep',
        'chat.google.com': 'googlechat',
        'youtube.com': 'youtube',
        'outlook.com': 'microsoftoutlook',
        'live.com': 'microsoftoutlook',
        'office.com': 'microsoftoffice',
    }

    // Google products that live under google.com/<path> (e.g. google.com/maps, google.com/drive)
    const GOOGLE_PATH_SLUGS = {
        maps: 'googlemaps', drive: 'googledrive', mail: 'gmail', docs: 'googledocs',
        sheets: 'googlesheets', slides: 'googleslides', calendar: 'googlecalendar',
        photos: 'googlephotos', news: 'googlenews', translate: 'googletranslate',
        play: 'googleplay', meet: 'googlemeet', keep: 'googlekeep', chat: 'googlechat',
        videos: 'youtube',
    }

    // hex of the theme's text colour, so Simple Icons glyphs stay visible in light and dark themes
    function themeHex() {
        try {
            const rgb = getComputedStyle(document.body).color.match(/\d+/g)
            if (rgb && rgb.length >= 3)
                return rgb.slice(0, 3).map(n => (+n).toString(16).padStart(2, '0')).join('')
        }
        catch { /* ignore */ }
        return ''
    }

    function simpleIconUrl(slug) {
        const hex = themeHex()
        return 'https://cdn.simpleicons.org/' + slug + (hex ? '/' + hex : '')
    }

    // slug guesses for a URL: an explicit host map, a Google "<path>" hint (google.com/maps),
    // "google"+sub for Google subdomains, the label before the TLD, and the first label
    function simpleSlugs(u) {
        const host = u.hostname.toLowerCase()
        const bare = host.replace(/^www\./, '')
        const seg = (u.pathname.split('/')[1] || '').toLowerCase()
        const parts = bare.split('.')
        const label = parts[0]
        const out = new Set()
        if (SIMPLE_ICON_HOSTS[host]) out.add(SIMPLE_ICON_HOSTS[host])
        if (SIMPLE_ICON_HOSTS[bare]) out.add(SIMPLE_ICON_HOSTS[bare])
        const isGoogle = /(^|\.)google\.com$/.test(bare)
        if (isGoogle && GOOGLE_PATH_SLUGS[seg]) out.add(GOOGLE_PATH_SLUGS[seg])
        if (isGoogle && label !== 'google' && label !== 'www') out.add('google' + label)
        if (parts.length >= 2) out.add(parts[parts.length - 2])
        out.add(label)
        return [...out].filter(Boolean)
    }

    // candidate icon URLs for a URL, in preference order
    function candidateIcons(url) {
        const out = []
        let u
        try { u = new URL(String(url || '').trim()) } catch { return out }
        if (!/^https?:$/.test(u.protocol)) return out
        const seen = new Set()
        const add = (src, label) => { if (src && !seen.has(src)) { seen.add(src); out.push({ src, label }) } }
        add('https://icons.duckduckgo.com/ip3/' + u.hostname + '.ico', 'DuckDuckGo')
        add(u.origin + '/favicon.ico', 'Site favicon.ico')
        add(u.origin + '/favicon.svg', 'Site favicon.svg')
        add(u.origin + '/apple-touch-icon.png', 'Site apple-touch-icon')
        for (const slug of simpleSlugs(u)) add(simpleIconUrl(slug), 'Simple Icons · ' + slug)
        return out
    }

    // a strip of candidate icons for the URL; candidates that fail to load are dropped
    function IconCandidates({ url, onPick }) {
        const [list, setList] = React.useState([])
        const [failed, setFailed] = React.useState({})
        React.useEffect(() => {
            const timer = setTimeout(() => { setFailed({}); setList(candidateIcons(url)) }, 400)
            return () => clearTimeout(timer)
        }, [url])
        const shown = list.filter(c => !failed[c.src])
        if (!shown.length) return null
        return h('div', { className: 'shortcuts-icon-candidates' },
            h('span', { className: 'shortcuts-icon-candidates-label' }, t('shortcuts_more_icons', 'More icons:')),
            shown.map(c => h('button', {
                key: c.src, type: 'button', className: 'shortcuts-icon-candidate', title: c.label,
                onClick: () => onPick(c.src),
            }, h('img', {
                src: c.src, alt: '', draggable: false,
                referrerPolicy: 'no-referrer', loading: 'lazy',
                onError: () => setFailed(s => ({ ...s, [c.src]: true })),
            }))),
        )
    }

    function absoluteHost(url) {
        try {
            const u = new URL(String(url || '').trim())
            return /^https?:$/.test(u.protocol) ? u.hostname : ''
        }
        catch { return '' }
    }

    // read a dropped/selected image and shrink it to a small data-URL (256×128 for a wide icon, else 128×128)
    function fileToIcon(file, wide) {
        return readAsDataUrl(file).then(dataUrl => downscaleIcon(dataUrl, wide))
    }

    function downscaleIcon(dataUrl, wide) {
        return new Promise(resolve => {
            const img = new Image()
            img.onload = () => {
                try {
                    const w = wide ? 256 : 128
                    const hh = 128
                    const canvas = document.createElement('canvas')
                    canvas.width = w
                    canvas.height = hh
                    const ctx = canvas.getContext('2d')
                    if (wide) {
                        // fill top-to-bottom exactly (no vertical space), preserving aspect;
                        // the width may overflow and is cropped evenly on both sides
                        const scale = hh / img.height
                        const dw = Math.max(1, Math.round(img.width * scale))
                        ctx.drawImage(img, (w - dw) / 2, 0, dw, hh)
                    }
                    else {
                        // normal icons: fit the whole image inside the square (no upscaling)
                        const scale = Math.min(w / img.width, hh / img.height, 1)
                        const dw = Math.max(1, Math.round(img.width * scale))
                        const dh = Math.max(1, Math.round(img.height * scale))
                        ctx.drawImage(img, (w - dw) / 2, (hh - dh) / 2, dw, dh)
                    }
                    resolve(canvas.toDataURL('image/png'))
                }
                catch { resolve(dataUrl) }
            }
            img.onerror = () => resolve(dataUrl)
            img.src = dataUrl
        })
    }

    function readAsDataUrl(file) {
        return new Promise((resolve, reject) => {
            const r = new FileReader()
            r.onload = () => resolve(String(r.result))
            r.onerror = () => reject(r.error)
            r.readAsDataURL(file)
        })
    }

    function readJsonFile(file) {
        return new Promise((resolve, reject) => {
            const r = new FileReader()
            r.onload = () => { try { resolve(JSON.parse(String(r.result))) } catch (e) { reject(e) } }
            r.onerror = () => reject(r.error)
            r.readAsText(file)
        })
    }

    function downloadJson(filename, data) {
        const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }))
        const a = document.createElement('a')
        a.href = url
        a.download = filename
        document.body.appendChild(a)
        a.click()
        a.remove()
        setTimeout(() => URL.revokeObjectURL(url), 1000)
    }

    // append incoming shortcuts after the existing ones, skipping duplicate URLs
    function mergeShortcuts(existing, incoming) {
        const out = Array.isArray(existing) ? existing.slice() : []
        const seen = new Set(out.map(x => x.url))
        for (const x of (Array.isArray(incoming) ? incoming : [])) {
            if (!x || !x.url || seen.has(x.url)) continue
            seen.add(x.url)
            out.push(x)
        }
        return out
    }

    // keep only valid shortcuts from an imported file (mirrors the server's sanitize)
    function cleanShortcutList(list) {
        if (!Array.isArray(list)) return []
        // keep URL-less items too, so imported blank/spacer tiles survive
        return list.map(x => x && typeof x === 'object' ? {
            icon: typeof x.icon === 'string' ? x.icon.slice(0, 131072) : '',
            label: typeof x.label === 'string' ? x.label.slice(0, 200) : '',
            url: safeUrl(x.url).slice(0, 2000),
            wide: x.wide === true,
            zoom: zoomValue(x.zoom),
            share: x.share === true,
        } : null).filter(x => x)
    }

    function localOverrides(username, bar) {
        try { return sanitizeOverrides(JSON.parse(localStorage.getItem(layoutStoreKey(username, bar))), bar) }
        catch { return {} }
    }

    // last-used settings win until the account-specific ones are known, so the bar renders
    // immediately with the right size/hidden state (no flash)
    function readOverrides(username, bar) {
        return { ...localOverrides('last', bar), ...localOverrides(username, bar) }
    }

    function saveLocalOverrides(username, overrides, bar) {
        try {
            const json = JSON.stringify(overrides)
            localStorage.setItem(layoutStoreKey(username || 'guest', bar), json)
            localStorage.setItem(layoutStoreKey('last', bar), json)
        }
        catch (e) { console.warn('shortcuts: cannot save layout locally', e) }
    }

    function layoutStoreKey(username, bar) {
        return LAYOUT_KEY + ':' + bar + ':' + (username || 'guest')
    }

    // keep only known keys, clamped to their allowed range/enum (mirrors the backend)
    function sanitizeOverrides(obj, bar = 'main') {
        const out = {}
        if (!obj || typeof obj !== 'object') return out
        // per-bar caps, mirroring the server's sanitizeLayout (which is authoritative)
        for (const [key, [min, max]] of Object.entries({
            iconSize: [16, iconMaxFor(bar)], columns: [1, columnsMaxFor(bar)], lineGap: [0, 60],
        })) {
            const v = Number(obj[key])
            if (Number.isFinite(v)) out[key] = Math.max(min, Math.min(max, Math.round(v)))
        }
        if (ALIGNS.includes(obj.align)) out.align = obj.align
        if (VIEW_MODES.includes(obj.visibility)) out.visibility = obj.visibility
        if (Array.isArray(obj.hiddenShared))
            out.hiddenShared = obj.hiddenShared.filter(x => typeof x === 'string' && x).slice(0, 500)
        // the user's combined icon order (urls)
        if (Array.isArray(obj.order))
            out.order = obj.order.filter(x => typeof x === 'string' && x).slice(0, 250) // mirrors MAX_LIST
        // this user's personal edits of the admin's shared icons (the originals stay untouched)
        if (Array.isArray(obj.edits))
            out.edits = obj.edits.filter(e => e && typeof e === 'object' && typeof e.from === 'string' && e.from)
                .slice(0, 100) // mirrors the server caps in plugin.js
                .map(e => ({
                    from: e.from.slice(0, 2000),
                    icon: typeof e.icon === 'string' ? e.icon.slice(0, 131072) : '',
                    label: typeof e.label === 'string' ? e.label.slice(0, 200) : '',
                    url: safeUrl(e.url).slice(0, 2000),
                    wide: e.wide === true,
                    zoom: zoomValue(e.zoom),
                }))
        return out
    }

    // Only web links are kept: http(s) absolute, or a site-relative path (e.g. "/media").
    // Any other scheme — javascript:, data:, vbscript:, file:, blob:, … — is rejected, so a
    // shortcut can never become a script-executing href. Control characters (which browsers
    // silently ignore, e.g. "java\tscript:") are stripped before the check.
    function safeUrl(value) {
        const s = String(value == null ? '' : value).replace(/[\u0000-\u001F\u007F]/g, '').trim()
        if (!s) return ''
        const m = /^([a-z][a-z0-9+.-]*):/i.exec(s)
        return m && !/^https?$/i.test(m[1]) ? '' : s
    }

    // Confirmation through HFS's in-page dialog (falls back to the native one if unavailable).
    // Native confirm() lets the browser offer "prevent this page from creating additional
    // dialogs", after which it silently returns false and blocks every later confirmation.
    // Repeatable actions (deleting/hiding icons) pass skippable: true, which shows a
    // "Don't ask again" checkbox; ticking it auto-accepts those for the rest of this session.
    // The flag lives in memory only, so a browser refresh clears it.
    let skipConfirm = false
    async function ask(msg, { skippable = false } = {}) {
        const d = HFS.dialogLib
        const hasDialog = d && typeof d.confirmDialog === 'function'
        if (!hasDialog) return confirm(msg) // fallback: nothing to add the checkbox to
        if (skippable && skipConfirm) return true
        let dontAsk = false
        const content = skippable
            ? h('div', {},
                h('p', {}, msg),
                h('label', { className: 'shortcuts-dont-ask' },
                    h('input', { type: 'checkbox', onChange: e => { dontAsk = e.target.checked } }),
                    t('shortcuts_dont_ask', "Don't ask again")))
            : msg
        try {
            const ok = Boolean(await d.confirmDialog(content))
            if (ok && skippable && dontAsk) skipConfirm = true
            return ok
        }
        catch { return confirm(msg) }
    }

    function errMsg(e) {
        return (e && (e.message || e.data)) ? String(e.message || e.data) : String(e)
    }

    function num(value, min, max, fallback) {
        const v = Number(value)
        if (!Number.isFinite(v)) return fallback
        return Math.max(min, Math.min(max, Math.round(v)))
    }

    // per-shortcut zoom (percent), clamped; undefined when not set
    function zoomValue(v) {
        const n = Number(v)
        return Number.isFinite(n) ? Math.max(10, Math.min(500, Math.round(n))) : undefined
    }
}
