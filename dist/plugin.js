// SPDX-License-Identifier: MIT
// Shortcut Bar - an HFS plugin
// A launcher of icon shortcuts. Two bars share one engine:
//   - "main"   -> shown under the file list (afterList), for web shortcuts
//   - "header" -> shown above the header (beforeHeader), for the site's own internal links
// Each signed-in user keeps their own set; admins can flag individual icons to be shared with everyone.

exports.version = 1
exports.description = "Adds customizable shortcut/launcher bars. A main bar under the file list for web shortcuts, and a header bar for site-internal links. Add a shortcut with the + button and set its URL. Each signed-in user keeps their own set, and the admin can mark single icons to be shared with everyone."
exports.apiRequired = 11.6 // customRest, openDb, notifyClient, subscribeConfig, getCurrentUsername, getAccount, getUsernames

// per-bar layout maxes live on each bar (BARS.main / BARS.header: iconMax, columnsMax)
const LAYOUT_ALIGNS = ['left', 'center', 'right']
const LAYOUT_VISIBILITY = ['show', 'hide', 'hover'] // per-bar: show / auto-hide / auto-hide + reveal on hover

// Search engines every admin starts with; shared so a fresh install isn't empty.
// Only names + URLs are shipped (no bundled logo artwork); icons are fetched at runtime,
// so there's no trademark redistribution. Icons come from DuckDuckGo's icon service by
// default (a more privacy-focused pick than Google's favicon service); the optional 4th
// tuple value overrides it for engines whose own .ico looks better.
const DEFAULT_SHORTCUTS = [
    ['Google', 'https://www.google.com/', 'google.com'],
    ['Bing', 'https://www.bing.com/', 'bing.com', 'https://www.bing.com/favicon.ico'],
    ['DuckDuckGo', 'https://duckduckgo.com/', 'duckduckgo.com'],
    ['Brave Search', 'https://search.brave.com/', 'search.brave.com'],
    ['Startpage', 'https://www.startpage.com/', 'startpage.com', 'https://www.startpage.com/favicon.ico'],
    ['Ecosia', 'https://www.ecosia.org/', 'ecosia.org'],
    ['Yahoo', 'https://search.yahoo.com/', 'search.yahoo.com'],
    ['Mojeek', 'https://www.mojeek.com/', 'mojeek.com'],
].map(([label, url, domain, icon]) => ({
    icon: icon || `https://icons.duckduckgo.com/ip3/${domain}.ico`,
    label,
    url,
    share: true,
}))

// Placeholder internal links the header bar starts with; edit them to your own.
// Shared so a fresh install has a starter nav bar. Icons are kept, URLs are placeholders.
const DEFAULT_HEADER_SHORTCUTS = [
    { icon: '🏠', label: 'Home', url: '/', share: true },
    { icon: '🎬', label: 'Media', url: '/media', share: true },
    { icon: '👤', label: 'Users', url: '/users', share: true },
    { icon: '🔗', label: 'Links', url: '/links', share: true },
]

// Built-in layout defaults (must mirror the frontend).
const DEFAULT_LAYOUT = {
    iconSize: 32,
    columns: 8,
    lineGap: 8, // vertical gap between rows, in px
    align: 'center',
    visibility: 'show', // 'show' | 'hide' | 'hover'
}

// The header bar is a navigation strip: keep the user's own order, keep it visible.
const DEFAULT_HEADER_LAYOUT = {
    iconSize: 64,
    columns: 4,
    lineGap: 8, // vertical gap between rows, in px
    align: 'center',
    visibility: 'show', // 'show' | 'hide' | 'hover'
}

// Key order here is the order the settings appear in the Admin panel, so the
// header-bar options are listed before the main-bar ones.
exports.config = {
    headerEnabled: {
        type: 'boolean',
        label: "Enable header shortcut bar",
        helperText: "A bar shown above the header, meant for the site's own internal links.",
        defaultValue: true,
        frontend: true,
    },
    disableTilesHeader: {
        type: 'boolean',
        label: "Disable tiles mode for the header bar",
        helperText: "When HFS is in tiles mode the header bar spans the full width, like the file list. Turn this on to keep it at the list width instead.",
        defaultValue: false,
        frontend: true,
    },
    lockHeader: {
        type: 'boolean',
        label: "Lock the header bar",
        helperText: "Non-admin users cannot add their own shortcuts or change the bar's layout or shared icons; they just see what you set.",
        defaultValue: false,
        frontend: true,
    },
    enabled: {
        type: 'boolean',
        label: "Enable main shortcut bar",
        helperText: "The launcher bar shown under the file list.",
        defaultValue: true,
        frontend: true,
    },
    disableTilesMain: {
        type: 'boolean',
        label: "Disable tiles mode for the main bar",
        helperText: "When HFS is in tiles mode the main bar spans the full width, matching the file list. Turn this on to keep it at the list width instead.",
        defaultValue: false,
        frontend: true,
    },
    lockMain: {
        type: 'boolean',
        label: "Lock the main bar",
        helperText: "Non-admin users cannot add their own shortcuts or change the bar's layout or shared icons; they just see what you set.",
        defaultValue: false,
        frontend: true,
    },
    showForGuests: {
        type: 'boolean',
        label: "Show the bars to visitors who are not signed in",
        helperText: "Visitors cannot add their own shortcuts, but still see the icons shared by the admin.",
        defaultValue: true,
        frontend: true,
    },
    holdMs: {
        type: 'number',
        label: "Hold time to customize",
        helperText: "How long to press and hold a shortcut (or the ···) before Customize opens.",
        defaultValue: 500,
        min: 200,
        max: 3000,
        unit: 'ms',
        frontend: true,
    },
}

exports.init = async api => {
    const db = await api.openDb('shortcuts.kv', { defaultPutDelay: 2_000 })
    let seeded, seeding
    // The shared/admin-layout aggregation is the same for every caller, so it's cached per bar
    // (invalidated on write) with a TTL as a fallback for account changes made outside the plugin.
    // Declared before subscribeConfig() below, whose callback (notify) runs synchronously.
    const GLOBALS_TTL = 60_000
    const globalsCache = new Map()      // bar name -> { at, promise }

    // Let every open frontend know the shortcuts changed, so the bars refresh live.
    api.subscribeConfig(['enabled', 'headerEnabled', 'showForGuests', 'disableTilesMain', 'disableTilesHeader', 'lockMain', 'lockHeader', 'holdMs'], notify)

    // One engine, two bars. "main" keeps the original storage keys for backward compatibility.
    const BARS = {
        main: {
            name: 'main',
            userPrefix: 'u:',
            layoutPrefix: 'l:',
            iconMax: 64,
            columnsMax: 24,
            defaults: DEFAULT_SHORTCUTS,
            layoutDefaults: () => ({ ...DEFAULT_LAYOUT }),
            enabled: () => api.getConfig('enabled') !== false,
            locked: () => api.getConfig('lockMain') === true,
        },
        header: {
            name: 'header',
            userPrefix: 'uh:',
            layoutPrefix: 'lh:',
            iconMax: 128,
            columnsMax: 12,
            defaults: DEFAULT_HEADER_SHORTCUTS,
            layoutDefaults: () => ({ ...DEFAULT_HEADER_LAYOUT }),
            enabled: () => api.getConfig('headerEnabled') !== false,
            locked: () => api.getConfig('lockHeader') === true,
        },
    }

    // Storage/abuse guards: a signed-in user must not be able to fill the database,
    // force huge reads/broadcasts, or hammer the save endpoints.
    const MAX_ICON = 128 * 1024         // ~ a 256×128 PNG; icons are downscaled client-side
    const MAX_LIST = 250                // items per bar
    const MAX_EDITS = 100               // personal edits of the admin's shared icons
    const MAX_PAYLOAD = 2 * 1024 * 1024 // total string bytes accepted per save
    const RATE_MAX = 40                 // saves allowed …
    const RATE_WINDOW = 10_000          // … per this many ms, per user
    const recentSaves = new Map()       // username -> [timestamps]

    function barOf(bar) {
        return bar === 'header' ? BARS.header : BARS.main
    }

    // Cheap size estimate of the stored fields, without building one giant JSON string.
    function payloadSize(v) {
        let n = 0
        const add = s => { if (typeof s === 'string') n += s.length }
        if (Array.isArray(v))
            for (const x of v) if (x) { add(x.icon); add(x.url); add(x.label) }
        else if (v && typeof v === 'object') {
            for (const u of (Array.isArray(v.order) ? v.order : [])) add(u)
            for (const u of (Array.isArray(v.hiddenShared) ? v.hiddenShared : [])) add(u)
            for (const e of (Array.isArray(v.edits) ? v.edits : [])) if (e) { add(e.icon); add(e.url); add(e.label); add(e.from) }
        }
        return n
    }

    // Per-user sliding-window throttle on the save endpoints.
    function throttle(username) {
        const now = Date.now()
        // drop entries that have fallen out of the window, so the map can't grow without bound
        for (const [u, times] of recentSaves)
            if (!times.length || now - times[times.length - 1] > RATE_WINDOW)
                recentSaves.delete(u)
        let hits = recentSaves.get(username)
        if (!hits) recentSaves.set(username, hits = [])
        while (hits.length && now - hits[0] > RATE_WINDOW) hits.shift()
        if (hits.length >= RATE_MAX)
            throw "Too many save requests; please slow down"
        hits.push(now)
    }

    return {
        frontend_js: 'main.js',
        frontend_css: 'style.css',

        customRest: {
            shortcuts_getAll: ({ bar } = {}, ctx) => reply(ctx, barOf(bar)),

            // Bring back shortcuts that were removed, without deleting anything the user or the
            // admins added, and reset the bar's positions (clearing any custom reordering).
            // A regular user gets back the admin's shared icons they hid; an admin gets back the
            // shipped default icons missing from their own list, at their original spots.
            // Deleting icons is only done from the Customize view.
            async shortcuts_restore({ bar } = {}, ctx) {
                const username = api.getCurrentUsername(ctx)
                if (!username)
                    throw "Please sign in to restore your shortcuts"
                throttle(username)
                const b = barOf(bar)
                if (b.locked() && !isAdmin(ctx))
                    throw "This bar is locked by the admin"
                // reset positions: drop this bar's saved order (and, for a user, un-hide the
                // shared icons) while keeping every other layout preference
                const layout = sanitizeLayout(await readValue(layoutKey(b, username)), b)
                delete layout.order
                if (isAdmin(ctx)) {
                    // rebuild as: defaults in their canonical order (restoring any missing ones, and
                    // reusing stored items so edits survive), then the rest in their saved order
                    const cur = await readList(b, username)
                    const defs = sanitize(b.defaults)
                    const byUrl = new Map(cur.map(x => [x.url, x]))
                    const defUrls = new Set(defs.map(d => d.url))
                    const next = defs.map(d => byUrl.get(d.url) || d)
                    for (const x of cur)
                        if (!defUrls.has(x.url)) next.push(x)
                    await db.put(userKey(b, username), next)
                    await db.put(layoutKey(b, username), layout)
                    notify()
                }
                else {
                    delete layout.hiddenShared
                    await db.put(layoutKey(b, username), layout)
                }
                return reply(ctx, b)
            },

            // save this user's own layout overrides (empty object = use the built-in defaults)
            async shortcuts_saveLayout({ layout, bar } = {}, ctx) {
                if (!layout || typeof layout !== 'object')
                    throw "Invalid settings payload" // never reset settings on a partial/bad request
                const username = api.getCurrentUsername(ctx)
                if (!username)
                    throw "Please sign in to save your settings"
                throttle(username)
                const b = barOf(bar)
                if (b.locked() && !isAdmin(ctx))
                    throw "This bar is locked by the admin"
                const clean = sanitizeLayout(layout, b)
                if (payloadSize(clean) > MAX_PAYLOAD)
                    throw "Settings are too large"
                await db.put(layoutKey(b, username), clean)
                if (isAdmin(ctx)) // the admin's own layout drives the shared defaults for everyone
                    notify()
                return reply(ctx, b)
            },

            async shortcuts_save({ list, bar } = {}, ctx) {
                if (!Array.isArray(list)) // guard a partial/aborted body: never wipe the list
                    throw "Invalid shortcuts payload"
                if (list.length > MAX_LIST)
                    throw "Too many shortcuts"
                const username = api.getCurrentUsername(ctx)
                if (!username)
                    throw "Please sign in to save your shortcuts"
                throttle(username)
                const b = barOf(bar)
                if (b.locked() && !isAdmin(ctx))
                    throw "This bar is locked by the admin"
                const clean = sanitize(list)
                if (!isAdmin(ctx)) // only admins may share icons with everyone
                    for (const x of clean) delete x.share
                if (payloadSize(clean) > MAX_PAYLOAD)
                    throw "Shortcuts are too large"
                await db.put(userKey(b, username), clean)
                // Only a change to shared icons affects other clients, so don't broadcast
                // (and force everyone to re-fetch) on every ordinary user's save.
                if (isAdmin(ctx))
                    notify()
                return reply(ctx, b)
            },
        },
    }

    // Seed the first admin's lists once (only if never saved), so a fresh install isn't empty.
    // Memoized only after an admin is seeded; a run with no admin yet, or a failure, is retried.
    function ensureSeeded() {
        if (seeded) return
        return seeding ||= (async () => {
            try {
                for (const u of api.getUsernames()) {
                    if (!api.getAccount(u)?.admin) continue
                    for (const b of Object.values(BARS)) {
                        const key = userKey(b, u)
                        if ((await readValue(key)) === undefined) {
                            await db.put(key, sanitize(b.defaults))
                            notify()
                        }
                    }
                    seeded = true
                    return
                }
            }
            finally { seeding = undefined } // allow a later retry (no admin yet, or it threw)
        })()
    }

    async function reply(ctx, b) {
        await ensureSeeded()
        const username = api.getCurrentUsername(ctx) || ''
        const { shared, adminLayout } = await collectGlobals(b)
        return {
            bar: b.name,
            enabled: b.enabled(),
            locked: b.locked(),
            isAdmin: isAdmin(ctx),
            username,
            shared,
            mine: username ? await readList(b, username) : [],
            layout: username ? sanitizeLayout(await readValue(layoutKey(b, username)), b) : {},
            adminLayout,
        }
    }

    // The first admin's effective layout (what others adopt on Reset), with defaults filled in.
    // Only the visual settings are exposed here: the stored layout may also hold the admin's own
    // order/edits/hiddenShared, which must not be handed to other users (or guests).
    async function collectAdminLayout(b) {
        const baseline = b.layoutDefaults()
        for (const u of api.getUsernames()) {
            if (!api.getAccount(u)?.admin) continue
            const lay = sanitizeLayout(await readValue(layoutKey(b, u)), b)
            const out = { ...baseline }
            for (const k of ['iconSize', 'columns', 'lineGap', 'align', 'visibility'])
                if (lay[k] !== undefined) out[k] = lay[k]
            return out
        }
        return baseline
    }

    // Shared + adminLayout are identical for every caller, so compute them once per bar and reuse.
    // Invalidated on any write (see notify); the TTL covers account changes made elsewhere.
    function collectGlobals(b) {
        const hit = globalsCache.get(b.name)
        if (hit && Date.now() - hit.at < GLOBALS_TTL) return hit.promise
        const promise = (async () => ({
            shared: await collectShared(b),
            adminLayout: await collectAdminLayout(b),
        }))()
        // drop a failed computation so the next call retries instead of reusing a rejection
        promise.catch(() => globalsCache.delete(b.name))
        globalsCache.set(b.name, { at: Date.now(), promise })
        return promise
    }

    // Icons the admins flagged to be shown to everyone, for this bar, in the admin's own order.
    async function collectShared(b) {
        const out = []
        for (const u of api.getUsernames()) {
            if (!api.getAccount(u)?.admin) continue
            const list = await readList(b, u)
            const lay = sanitizeLayout(await readValue(layoutKey(b, u)), b)
            const at = new Map((Array.isArray(lay.order) ? lay.order : []).map((k, i) => [k, i]))
            // the key the admin's own saved order uses for each item (url, or blank:<index>)
            const ownKey = (x, i) => x.url || ('blank:' + i)
            const rows = list.map((x, i) => ({ x, i }))
            if (at.size)
                rows.sort((p, q) => {
                    const kp = ownKey(p.x, p.i), kq = ownKey(q.x, q.i)
                    return (at.has(kp) ? at.get(kp) : Infinity) - (at.has(kq) ? at.get(kq) : Infinity)
                })
            for (const { x, i } of rows)
                if (x.share)
                    out.push({
                        icon: x.icon, label: x.label, url: x.url, wide: x.wide === true, zoom: x.zoom,
                        // client-side order key; URL-less tiles get a "s:" prefix so a shared blank
                        // can't collide with the viewing user's own blank keys
                        orderKey: x.url || ('s:blank:' + i),
                    })
        }
        return out
    }

    // Read a stored value, tolerating both sync-loaded and on-disk entries.
    async function readValue(key) {
        let v
        try { v = db.getSync(key) } catch { /* not in memory yet */ }
        if (v === undefined && typeof db.get === 'function')
            try { v = await db.get(key) } catch { /* missing */ }
        if (typeof v === 'string') // some storages return the raw JSON
            try { v = JSON.parse(v) } catch { v = undefined }
        return v
    }

    async function readList(b, username) {
        return sanitize(await readValue(userKey(b, username)))
    }

    function isAdmin(ctx) {
        const username = api.getCurrentUsername(ctx)
        return Boolean(username && api.getAccount(username)?.admin)
    }

    function notify() {
        globalsCache.clear() // any change invalidates the cached shared/admin-layout aggregation
        api.notifyClient('shortcuts', 'changed')
    }

    function userKey(b, username) {
        return b.userPrefix + username.toLowerCase()
    }

    function layoutKey(b, username) {
        return b.layoutPrefix + username.toLowerCase()
    }

    // Keep only known layout keys, clamped to their allowed range/enum (maxes are per bar).
    function sanitizeLayout(obj, b = BARS.main) {
        if (!obj || typeof obj !== 'object') return {}
        const out = {}
        const ranges = { iconSize: [16, b.iconMax], columns: [1, b.columnsMax], lineGap: [0, 60] }
        for (const [key, [min, max]] of Object.entries(ranges)) {
            const v = Number(obj[key])
            if (Number.isFinite(v)) out[key] = Math.max(min, Math.min(max, Math.round(v)))
        }
        if (LAYOUT_ALIGNS.includes(obj.align)) out.align = obj.align
        if (LAYOUT_VISIBILITY.includes(obj.visibility)) out.visibility = obj.visibility
        // shared icons this user hid
        if (Array.isArray(obj.hiddenShared))
            out.hiddenShared = obj.hiddenShared.filter(x => typeof x === 'string' && x).slice(0, 500)
        // the user's combined icon order (urls)
        if (Array.isArray(obj.order))
            out.order = obj.order.filter(x => typeof x === 'string' && x).slice(0, MAX_LIST)
        // this user's personal edits of the admin's shared icons (the originals stay untouched)
        if (Array.isArray(obj.edits))
            out.edits = obj.edits.filter(e => e && typeof e === 'object' && typeof e.from === 'string' && e.from)
                .slice(0, MAX_EDITS)
                .map(e => ({
                    from: e.from.slice(0, 2000),
                    icon: typeof e.icon === 'string' ? e.icon.slice(0, MAX_ICON) : '',
                    label: typeof e.label === 'string' ? e.label.slice(0, 200) : '',
                    url: safeUrl(e.url).slice(0, 2000),
                    wide: e.wide === true,
                    zoom: zoomValue(e.zoom),
                }))
        return out
    }

    // per-shortcut zoom (percent), clamped; undefined when not set
    function zoomValue(v) {
        const n = Number(v)
        return Number.isFinite(n) ? Math.max(10, Math.min(500, Math.round(n))) : undefined
    }

    // Only web links are kept: http(s) absolute, or a site-relative path (e.g. "/media").
    // Any other scheme — javascript:, data:, vbscript:, file:, blob:, … — is rejected, so a
    // stored shortcut can never become a script-executing href. Control characters (which
    // browsers silently ignore, e.g. "java\tscript:") are stripped before the check.
    function safeUrl(value) {
        const s = String(value == null ? '' : value).replace(/[\u0000-\u001F\u007F]/g, '').trim()
        if (!s) return ''
        const m = /^([a-z][a-z0-9+.-]*):/i.exec(s)
        return m && !/^https?$/i.test(m[1]) ? '' : s
    }

    function sanitize(list) {
        if (!Array.isArray(list)) return []
        // note: an empty URL is kept on purpose — a blank/spacer tile with no link
        return list.map(x => x && typeof x === 'object' ? {
            icon: typeof x.icon === 'string' ? x.icon.slice(0, MAX_ICON) : '',
            label: typeof x.label === 'string' ? x.label.slice(0, 200) : '',
            url: safeUrl(x.url).slice(0, 2000),
            wide: x.wide === true,
            zoom: zoomValue(x.zoom),
            share: x.share === true,
        } : null).filter(x => x).slice(0, MAX_LIST)
    }
}
