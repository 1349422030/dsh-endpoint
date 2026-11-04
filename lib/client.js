/**
 * dsh-endpoint — Client half.
 *
 * The settings page for the endpoint: whether the listener runs, where it
 * binds, and who may call it. Live state (the port actually bound, the
 * addresses that reach it, the current warnings) comes from the Host half's
 * same-origin status route, so the page reports what is running instead of
 * echoing back what was typed.
 *
 * This file must not import any Harness client package: the loader provides
 * only `react` and `react/jsx-runtime`.
 */
window.__ModuleLoader__.load({
    // The module id is the package name: the browser resolves this bundle from
    // the boot graph, whose rows are keyed by the package each entry loads. A
    // registration under any other id is a factory nobody can reach.
    id: '@fishhhh/dsh-endpoint',
    factory: (require) => {
        const module = { exports: {} };
        const exports = module.exports;
        const React = require('react');
        const h = React.createElement;
        const { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } = React;

        /** Locale namespace, also reported to the settings slot. */
        const LOCALE_NS = 'dsh-endpoint';
        /** Profile entry id, which is the settings namespace the Host writes. */
        const CONFIG_NS = 'dsh-endpoint';
        /** Same-origin status route mounted by the Host half. */
        const STATUS_ROUTE = '/plugins/dsh-endpoint';

        const en = {
            nav: 'Model endpoint',
            title: 'Model endpoint',
            intro:
                'Serves the models this profile is configured for over an OpenAI-compatible API. Point any OpenAI client at the base URL below.',
            unavailable: 'The Host half of this plugin is not answering, so the live state cannot be read.',
            readOnly: 'These settings are read-only in this session.',
            statusLabel: 'Status',
            statusRunning: 'Listening',
            statusStopped: 'Stopped',
            statusUnknown: 'Unknown',
            baseUrlLabel: 'Base URL',
            baseUrlHint: 'Use this as the OpenAI base URL. Any non-empty string works as the API key when authentication is off.',
            copy: 'Copy',
            copied: 'Copied',
            enabledLabel: 'Run the endpoint',
            enabledHint: 'Stop the listener without uninstalling the plugin.',
            hostLabel: 'Bind address',
            hostHint: '127.0.0.1 keeps it on this machine. 0.0.0.0 accepts every interface. Always set an API key; leaving it empty is only safe on a loopback bind.',
            hostPlaceholder: '127.0.0.1',
            portLabel: 'Port',
            portHint: 'The TCP port clients connect to.',
            apiKeyLabel: 'API key',
            apiKeyHint: 'When set, clients send it as Authorization: Bearer <key>.',
            apiKeyPlaceholder: 'no authentication',
            generate: 'Generate',
            generateHint: 'Fills the field with a fresh random key. Copy it into your client before saving; this field is the only place it is stored.',
            modelsLabel: 'Models behind this endpoint',
            modelsHint:
                'Check the models clients may use; give any of them a custom id, or leave the field empty to publish the provider/model default. An unchecked model is neither listed at /v1/models nor routable.',
            modelExposedLabel: 'Exposed',
            modelCustomIdLabel: 'Custom id',
            modelsEmpty: 'No model is routable from this profile yet.',
            modelsExposureEmpty:
                'At least one model must stay checked: an empty exposure list would mean "publish everything".',
            modelIdTaken: 'Another model already answers to this id.',
            modelIdReserved: 'This id is reserved: a request naming it selects the default model.',
            loading: 'Reading live state…',
            save: 'Save',
            saving: 'Saving…',
            saved: 'Saved.',
            discard: 'Discard',
            saveFailed: 'The setting could not be saved.',
        };

        const zh = {
            nav: '模型端点',
            title: '模型端点',
            intro: '把本 profile 已配置的模型以 OpenAI 兼容 API 提供出去。把 OpenAI 客户端的 base URL 指到下面这个地址即可。',
            unavailable: '插件的 Host 半没有响应，读不到实时状态。',
            readOnly: '本次会话中这些设置是只读的。',
            statusLabel: '状态',
            statusRunning: '监听中',
            statusStopped: '已停止',
            statusUnknown: '未知',
            baseUrlLabel: '基础地址',
            baseUrlHint: '把它作为 OpenAI 客户端的 base URL。未设鉴权时，API key 填任意非空字符串即可。',
            copy: '复制',
            copied: '已复制',
            enabledLabel: '启用端点',
            enabledHint: '关掉监听，但不用卸载插件。',
            hostLabel: '绑定地址',
            hostHint: '127.0.0.1 只在本机；0.0.0.0 接受所有网卡。始终建议设置 API key —— 只有绑定回环地址时留空才是安全的。',
            hostPlaceholder: '127.0.0.1',
            portLabel: '端口',
            portHint: '客户端连接的 TCP 端口。',
            apiKeyLabel: 'API key',
            apiKeyHint: '设置后，客户端需要以 Authorization: Bearer <key> 发送。',
            apiKeyPlaceholder: '不鉴权',
            generate: '生成',
            generateHint: '填入一个新的随机 key。保存前先复制到客户端 —— 这个字段是它唯一的存放处。',
            modelsLabel: '端点背后的模型',
            modelsHint:
                '勾选客户端可以使用的模型；自定义 id 留空即用默认的 provider/model 名字。未勾选的模型既不会出现在 /v1/models，也无法被路由。',
            modelExposedLabel: '对外暴露',
            modelCustomIdLabel: '自定义 id',
            modelsEmpty: '本 profile 暂无可路由的模型。',
            modelsExposureEmpty:
                '空的暴露名单语义是「全部发布」，所以至少要保留一个勾选，保存才会生效。',
            modelIdTaken: '这个 id 已经被另一个模型占用了。',
            modelIdReserved: '这个 id 是保留字：请求写它会被当成「用默认模型」。',
            loading: '正在读取实时状态…',
            save: '保存',
            saving: '保存中…',
            saved: '已保存。',
            discard: '放弃修改',
            saveFailed: '设置保存失败。',
        };

        const css = `
.dsh-ep{display:flex;flex-direction:column;gap:16px;font-size:14px;line-height:22px;color:var(--dsw-alias-label-primary)}
.dsh-ep-head{display:flex;flex-direction:column;gap:4px}
.dsh-ep-title{margin:0;font-size:16px;font-weight:600;line-height:24px}
.dsh-ep-intro{margin:0;color:var(--dsw-alias-label-secondary);font-size:13px;line-height:20px}
.dsh-ep-card{border:1px solid var(--dsw-alias-border-secondary,#e5e5e5);border-radius:8px;padding:12px;display:flex;flex-direction:column;gap:10px}
.dsh-ep-row{display:grid;grid-template-columns:160px 1fr;gap:12px;align-items:start}
.dsh-ep-row-label{color:var(--dsw-alias-label-secondary);font-size:13px}
.dsh-ep-value{display:flex;align-items:center;gap:8px;flex-wrap:wrap;word-break:break-all}
.dsh-ep-pill{display:inline-flex;align-items:center;gap:6px;font-size:12px;padding:2px 8px;border-radius:999px;background:var(--dsw-alias-fill-tertiary,#f2f2f2)}
.dsh-ep-pill[data-live=true]{background:var(--dsw-alias-state-success-quaternary,#e8f5e9);color:var(--dsw-alias-state-success-primary,#2e7d32)}
.dsh-ep-pill[data-live=false]{background:var(--dsw-alias-state-error-quaternary,#fdecea);color:var(--dsw-alias-label-error,#c62828)}
.dsh-ep-dot{width:6px;height:6px;border-radius:50%;background:currentColor}
.dsh-ep-mono{font-family:var(--dsw-alias-font-mono,ui-monospace,SFMono-Regular,Menlo,monospace);font-size:12px}
.dsh-ep-note{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}
.dsh-ep-note[data-tone=error]{color:var(--dsw-alias-label-error,#c62828)}
.dsh-ep-note[data-tone=success]{color:var(--dsw-alias-state-success-primary,#2e7d32)}
.dsh-ep-warn{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-error,#c62828)}
.dsh-ep-field{display:flex;flex-direction:column;gap:4px}
.dsh-ep-field-label{font-size:13px;font-weight:500}
.dsh-ep-input,.dsh-ep-number{height:30px;padding:0 8px;border:1px solid var(--dsw-alias-border-secondary,#d9d9d9);border-radius:6px;background:var(--dsw-alias-bg-primary,#fff);color:inherit;font-size:13px;width:100%;max-width:360px;box-sizing:border-box}
.dsh-ep-number{max-width:120px}
.dsh-ep-check{display:flex;align-items:center;gap:8px}
.dsh-ep-inline{display:flex;align-items:center;gap:8px}
.dsh-ep-ghost,.dsh-ep-primary{height:28px;padding:0 12px;border-radius:6px;font-size:13px;cursor:pointer;border:1px solid var(--dsw-alias-border-secondary,#d9d9d9);background:transparent;color:inherit}
.dsh-ep-primary{background:var(--dsw-alias-label-primary,#111);color:var(--dsw-alias-bg-primary,#fff);border-color:transparent}
.dsh-ep-ghost:disabled,.dsh-ep-primary:disabled{opacity:.45;cursor:default}
.dsh-ep-footer{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.dsh-ep-list{display:flex;flex-wrap:wrap;gap:4px}
.dsh-ep-tag{font-size:12px;padding:1px 6px;border-radius:4px;background:var(--dsw-alias-fill-tertiary,#f2f2f2)}
.dsh-ep-model-table{display:flex;flex-direction:column;gap:8px}
.dsh-ep-model-row{display:grid;grid-template-columns:1fr 260px;gap:12px;align-items:center}
.dsh-ep-model-row[data-checked="false"] .dsh-ep-model-id{opacity:.6}
.dsh-ep-model-id{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap;word-break:break-all}
.dsh-ep-model-name{color:var(--dsw-alias-label-secondary);font-size:12px}
.dsh-ep-model-input{max-width:260px;height:28px}
`;

        const cssTagId = 'dsh-endpoint/settings.module.css';
        if (
            typeof document !== 'undefined'
            && document.querySelector('style[data-plugin-css=' + JSON.stringify(cssTagId) + ']') === null
        ) {
            const tag = document.createElement('style');
            tag.dataset.plugin = 'dsh-endpoint';
            tag.dataset.pluginCss = cssTagId;
            tag.textContent = css;
            document.head.appendChild(tag);
        }

        /** Resolve one of the Host half's routes against the page base. */
        function api(path) {
            try {
                return new URL(path, document.baseURI).pathname;
            } catch {
                return path;
            }
        }

        /** Read a JSON body, tolerating a response that is not JSON. */
        async function readJson(response) {
            try {
                return await response.json();
            } catch {
                return null;
            }
        }

        /** Structural equality, so the dirty flag does not flicker on re-renders. */
        function sameValue(left, right) {
            if (Object.is(left, right)) return true;
            if (typeof left !== 'object' || typeof right !== 'object' || left === null || right === null) return false;
            try {
                return JSON.stringify(left) === JSON.stringify(right);
            } catch {
                return false;
            }
        }

        /** A fresh 256-bit key, as the hex string a client pastes. */
        function randomKey() {
            const bytes = new Uint8Array(32);
            globalThis.crypto.getRandomValues(bytes);
            return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
        }

        /**
         * The config's alias map, always an object.
         * @param {unknown} config - the saved config value.
         * @returns {Record<string, string>}
         */
        function modelIdsOf(config) {
            return config !== null
                && typeof config === 'object'
                && config.modelIds !== null
                && typeof config.modelIds === 'object'
                ? config.modelIds
                : {};
        }

        /**
         * One rendered row of the models section.
         * @typedef {{route: string, name: string, checked: boolean, customId: string}} ModelRow
         */

        /**
         * The rows the models card shows. The status document carries the
         * profile's routable models with their live exposure; the config value
         * carries the saved aliases. Unsaved changes ride in @overrides@ (keyed
         * by route), so a status poll refreshing between keystrokes can never
         * rewrite a field under the user's hands.
         * @param {unknown} document - the status document, or null when unavailable.
         * @param {unknown} config - the saved config value.
         * @param {Record<string, Partial<ModelRow>>} overrides
         * @returns {ModelRow[]}
         */
        function modelRows(document, config, overrides = {}) {
            const models =
                document !== null && typeof document === 'object' && Array.isArray(document.models) ? document.models : [];
            const ids = modelIdsOf(config);
            const rows = [];
            for (const model of models) {
                const route =
                    model !== null && typeof model === 'object' && typeof model.route === 'string' ? model.route : '';
                if (route === '') continue;
                const saved = ids[route];
                const override = overrides[route] ?? {};
                rows.push({
                    route,
                    name: typeof model.name === 'string' && model.name !== '' ? model.name : route,
                    checked: override.checked ?? model.exposed === true,
                    customId:
                        override.customId !== undefined
                            ? override.customId
                            : typeof saved === 'string' && saved !== ''
                                ? saved
                                : '',
                });
            }
            return rows;
        }

        /**
         * Fold the visible rows back into the two config fields the Host reads.
         * All rows checked collapses to the empty exposure list — that list means
         * "publish everything", so a model added later is exposed without a
         * settings visit — and otherwise the checked routes are named precisely.
         * Custom ids are only written where non-empty, so clearing a field
         * removes its alias. Saved aliases for routes the status document does
         * not list right now survive untouched.
         * @param {ModelRow[]} rows
         * @param {unknown} config - the saved config value.
         * @returns {{expose: string[], modelIds: Record<string, string>, emptySelection: boolean}}
         */
        function modelConfig(rows, config) {
            const known = new Set(rows.map((row) => row.route));
            const modelIds = {};
            for (const [route, alias] of Object.entries(modelIdsOf(config))) {
                if (!known.has(route) && typeof alias === 'string' && alias.trim() !== '') modelIds[route] = alias;
            }
            // The registry may not be enumerable right now: carrying no rows
            // must not silently turn a precise exposure list into "everything".
            if (rows.length === 0) {
                const expose = Array.isArray(config?.expose)
                    ? config.expose.filter((entry) => typeof entry === 'string')
                    : [];
                return { expose, modelIds, emptySelection: false };
            }
            const checked = [];
            for (const row of rows) {
                const id = typeof row.customId === 'string' ? row.customId.trim() : '';
                if (id !== '') modelIds[row.route] = id;
                if (row.checked) checked.push(row.route);
            }
            return {
                expose: checked.length === rows.length ? [] : checked,
                modelIds,
                emptySelection: rows.length > 0 && checked.length === 0,
            };
        }

        /**
         * Ids that never reach a custom name: the Host reads them as "pick the
         * default model", so an alias with one of these values would silently
         * publish a name that addresses something else. Mirrors DEFAULT_WORDS
         * in `lib/capabilities.js` — this half runs in the browser and cannot
         * import it.
         */
        const RESERVED_IDS = new Set(['auto', 'default', 'on', 'true', '1']);

        /**
         * Which rows carry an id that cannot be published.
         *
         * Two writers race for one name — a row's own route and any custom id —
         * so the check compares the *effective* id of every row, not the raw
         * inputs: typing `provider/model` into one field while another model
         * already answers to it is the same collision as two identical custom
         * ids, and the Host would answer such a request with "ambiguous".
         * @param {ModelRow[]} rows
         * @returns {Map<string, string>} route → translation key of its problem.
         */
        function modelIdIssues(rows) {
            const effective = new Map();
            for (const row of rows) {
                const custom = typeof row.customId === 'string' ? row.customId.trim() : '';
                const id = custom === '' ? row.route : custom;
                const routes = effective.get(id) ?? [];
                routes.push(row.route);
                effective.set(id, routes);
            }
            const issues = new Map();
            for (const row of rows) {
                const custom = typeof row.customId === 'string' ? row.customId.trim() : '';
                if (custom === '') continue;
                if (RESERVED_IDS.has(custom.toLowerCase())) {
                    issues.set(row.route, 'modelIdReserved');
                    continue;
                }
                if ((effective.get(custom) ?? []).length > 1) issues.set(row.route, 'modelIdTaken');
            }
            return issues;
        }

        /**
         * The config keys one row edit has to write.
         *
         * Only the field the user actually touched is written. Typing a custom
         * id must not rewrite the exposure list: that list may be a wildcard
         * (`provider/*`) whose whole point is to publish models added later,
         * and folding it into exact routes as a side effect of an unrelated
         * keystroke would quietly end that promise.
         * @param {{checked?: boolean, customId?: string}} patch
         * @param {{expose: string[], modelIds: Record<string, string>}} fold
         * @returns {Record<string, unknown>} config key → value to write.
         */
        function editedFields(patch, fold) {
            const fields = {};
            if (patch.checked !== undefined) fields.expose = fold.expose;
            if (patch.customId !== undefined) fields.modelIds = fold.modelIds;
            return fields;
        }

        /**
         * Local edit buffer over one config form.
         * @param {object} form - the settings form controller for this namespace.
         * @param {function(string): string} t - translator.
         */
        function useConfigForm(form, t) {
            const snapshot = useSyncExternalStore(
                useCallback((listener) => form.subscribe(listener), [form]),
                useCallback(() => form.getSnapshot(), [form]),
            );
            const [edits, setEdits] = useState({});
            const [saving, setSaving] = useState(false);
            const [failure, setFailure] = useState(null);
            const [saved, setSaved] = useState(false);

            // A new Host revision means someone else wrote; drop stale local edits.
            const revision = snapshot.revision;
            const lastRevision = useRef(revision);
            useEffect(() => {
                if (lastRevision.current === revision) return;
                lastRevision.current = revision;
                setEdits({});
            }, [revision]);

            const value = snapshot.value ?? {};
            const field = useCallback((key) => (key in edits ? edits[key] : value[key]), [edits, value]);
            const dirty = useMemo(
                () => Object.keys(edits).some((key) => !sameValue(edits[key], value[key])),
                [edits, value],
            );

            const edit = useCallback((key, next) => {
                setSaved(false);
                setFailure(null);
                setEdits((current) => ({ ...current, [key]: next }));
            }, []);

            const discard = useCallback(() => {
                setEdits({});
                setFailure(null);
                setSaved(false);
            }, []);

            const save = useCallback(async () => {
                const changed = Object.keys(edits).filter((key) => !sameValue(edits[key], value[key]));
                if (changed.length === 0) return;
                setSaving(true);
                setFailure(null);
                setSaved(false);
                try {
                    for (const key of changed) {
                        const next = edits[key];
                        // An emptied text field means "fall back to the schema default".
                        const accepted =
                            next === '' || next === null || next === undefined
                                ? await form.unset(key)
                                : await form.set(key, next);
                        if (accepted !== true) {
                            setFailure(t('saveFailed'));
                            return;
                        }
                    }
                    setEdits({});
                    setSaved(true);
                } catch {
                    setFailure(t('saveFailed'));
                } finally {
                    setSaving(false);
                }
            }, [edits, form, t, value]);

            return { value, revision, field, dirty, saving, failure, saved, edit, discard, save };
        }

        /** Poll the Host half for the live listener state. */
        function useStatus() {
            const [state, setState] = useState({ phase: 'loading', document: null });
            useEffect(() => {
                const controller = new AbortController();
                const load = async () => {
                    try {
                        const response = await fetch(api(STATUS_ROUTE), { signal: controller.signal, cache: 'no-store' });
                        const payload = await readJson(response);
                        // Require the fields this page dereferences, so a partial
                        // or foreign answer degrades to "unavailable" instead of
                        // breaking the render.
                        if (
                            payload === null
                            || payload.ok !== true
                            || typeof payload.bind !== 'object'
                            || payload.bind === null
                            || typeof payload.bind.port !== 'number'
                        ) {
                            setState({ phase: 'failed', document: null });
                            return;
                        }
                        setState({ phase: 'ready', document: payload });
                    } catch {
                        if (controller.signal.aborted) return;
                        setState({ phase: 'failed', document: null });
                    }
                };
                void load();
                const timer = setInterval(() => void load(), 5000);
                return () => {
                    controller.abort();
                    clearInterval(timer);
                };
            }, []);
            return state;
        }

        /** One labelled row of read-only live state. */
        function Row({ label, children }) {
            return h(
                'div',
                { className: 'dsh-ep-row' },
                h('div', { className: 'dsh-ep-row-label' }, label),
                h('div', { className: 'dsh-ep-value' }, children),
            );
        }

        /** The base URL, with a copy button. */
        function BaseUrl({ url, t }) {
            const [copied, setCopied] = useState(false);
            useEffect(() => {
                if (!copied) return undefined;
                const timer = setTimeout(() => setCopied(false), 1500);
                return () => clearTimeout(timer);
            }, [copied]);
            return h(
                'div',
                { className: 'dsh-ep-value' },
                h('code', { className: 'dsh-ep-mono' }, url),
                h(
                    'button',
                    {
                        type: 'button',
                        className: 'dsh-ep-ghost',
                        onClick: () => {
                            void navigator.clipboard?.writeText(url);
                            setCopied(true);
                        },
                    },
                    t(copied ? 'copied' : 'copy'),
                ),
            );
        }

        /** The endpoint's settings page. */
        function EndpointSettingsSection({ configForms, t }) {
            const form = useMemo(() => configForms.get(CONFIG_NS), [configForms]);
            const state = useConfigForm(form, t);
            const status = useStatus();

            // The models card. Base rows come from the status route's models
            // list (which carries the live exposure flags) plus the saved
            // aliases from the form value; unsaved changes live in overrides
            // keyed by route, so the status poll refreshing the document never
            // rewrites a field under the user's hands. Overrides clear when the
            // config round-trips — a new Host revision — or on discard.
            const liveDocument = status.phase === 'ready' ? status.document : null;
            const liveModels = liveDocument !== null && typeof liveDocument === 'object' ? liveDocument : null;
            const [overrides, setOverrides] = useState({});
            const rows = useMemo(
                () => modelRows(liveModels, state.value, overrides),
                [liveModels, state.value, overrides],
            );
            const fold = modelConfig(rows, state.value);

            const lastRevision = useRef(state.revision);
            useEffect(() => {
                if (lastRevision.current === state.revision) return;
                lastRevision.current = state.revision;
                setOverrides({});
            }, [state.revision]);

            const editRow = useCallback(
                (route, patch) => {
                    const nextOverrides = { ...overrides, [route]: { ...(overrides[route] ?? {}), ...patch } };
                    const nextRows = modelRows(liveModels, state.value, nextOverrides);
                    const nextFold = modelConfig(nextRows, state.value);
                    setOverrides(nextOverrides);
                    for (const [key, next] of Object.entries(editedFields(patch, nextFold))) {
                        state.edit(key, next);
                    }
                },
                [liveModels, overrides, state],
            );

            if (form === undefined) {
                return h('div', { className: 'dsh-ep' }, h('p', { className: 'dsh-ep-note' }, t('unavailable')));
            }

            const live = status.phase === 'ready' ? status.document : null;
            const disabled = state.saving;
            // Nothing checked cannot be expressed as an exposure list — the
            // empty one means "publish everything" — so it must not be saved.
            const touchedModels = Object.keys(overrides).length > 0;
            const issues = modelIdIssues(rows);
            const saveBlocked = touchedModels && (fold.emptySelection || issues.size > 0);
            const baseUrl = live === null ? null : `http://${live.bind.host}:${live.bind.port}/v1`;
            const warnings = live === null ? [] : (live.warnings ?? []);

            return h(
                'div',
                { className: 'dsh-ep' },
                h(
                    'div',
                    { className: 'dsh-ep-head' },
                    h('h3', { className: 'dsh-ep-title' }, t('title')),
                    h('p', { className: 'dsh-ep-intro' }, t('intro')),
                ),

                h(
                    'div',
                    { className: 'dsh-ep-card' },
                    h(
                        Row,
                        { label: t('statusLabel') },
                        h(
                            'span',
                            { className: 'dsh-ep-pill', 'data-live': live !== null && live.listening === true },
                            h('span', { className: 'dsh-ep-dot' }),
                            t(
                                status.phase === 'loading'
                                    ? 'loading'
                                    : live === null
                                        ? 'statusUnknown'
                                        : live.listening === true
                                            ? 'statusRunning'
                                            : 'statusStopped',
                            ),
                        ),
                    ),
                    baseUrl === null ? null : h(Row, { label: t('baseUrlLabel') }, h(BaseUrl, { url: baseUrl, t })),
                    warnings.length === 0
                        ? null
                        : h('div', { className: 'dsh-ep-field' }, warnings.map((warning) => h('p', { key: warning, className: 'dsh-ep-warn' }, warning))),
                    live === null ? h('p', { className: 'dsh-ep-note' }, t('unavailable')) : null,
                ),

                h(
                    'div',
                    { className: 'dsh-ep-card' },
                    h(
                        'div',
                        { className: 'dsh-ep-field' },
                        h(
                            'label',
                            { className: 'dsh-ep-check' },
                            h('input', {
                                type: 'checkbox',
                                checked: state.field('enabled') === true,
                                disabled,
                                onChange: (event) => state.edit('enabled', event.target.checked),
                            }),
                            h('span', { className: 'dsh-ep-field-label' }, t('enabledLabel')),
                        ),
                        h('p', { className: 'dsh-ep-note' }, t('enabledHint')),
                    ),
                    h(
                        'div',
                        { className: 'dsh-ep-field' },
                        h('span', { className: 'dsh-ep-field-label' }, t('hostLabel')),
                        h('input', {
                            className: 'dsh-ep-input',
                            type: 'text',
                            value: state.field('host') ?? '',
                            placeholder: t('hostPlaceholder'),
                            disabled,
                            onChange: (event) => state.edit('host', event.target.value),
                        }),
                        h('p', { className: 'dsh-ep-note' }, t('hostHint')),
                    ),
                    h(
                        'div',
                        { className: 'dsh-ep-field' },
                        h('span', { className: 'dsh-ep-field-label' }, t('portLabel')),
                        h('input', {
                            className: 'dsh-ep-number',
                            type: 'number',
                            min: 1,
                            max: 65535,
                            value: state.field('port') ?? '',
                            disabled,
                            onChange: (event) => {
                                const next = Number(event.target.value);
                                state.edit('port', Number.isFinite(next) && next > 0 ? next : '');
                            },
                        }),
                        h('p', { className: 'dsh-ep-note' }, t('portHint')),
                    ),
                    h(
                        'div',
                        { className: 'dsh-ep-field' },
                        h('span', { className: 'dsh-ep-field-label' }, t('apiKeyLabel')),
                        h(
                            'div',
                            { className: 'dsh-ep-inline' },
                            h('input', {
                                className: 'dsh-ep-input',
                                type: 'text',
                                value: state.field('apiKey') ?? '',
                                placeholder: t('apiKeyPlaceholder'),
                                disabled,
                                onChange: (event) => state.edit('apiKey', event.target.value),
                            }),
                            h(
                                'button',
                                {
                                    type: 'button',
                                    className: 'dsh-ep-ghost',
                                    disabled,
                                    onClick: () => state.edit('apiKey', randomKey()),
                                },
                                t('generate'),
                            ),
                        ),
                        h('p', { className: 'dsh-ep-note' }, t('apiKeyHint')),
                        h('p', { className: 'dsh-ep-note' }, t('generateHint')),
                    ),
                ),

                h(
                    'div',
                    { className: 'dsh-ep-card' },
                    h(
                        'div',
                        { className: 'dsh-ep-field' },
                        h('span', { className: 'dsh-ep-field-label' }, t('modelsLabel')),
                        h('p', { className: 'dsh-ep-note' }, t('modelsHint')),
                    ),
                    rows.length === 0
                        ? h('p', { className: 'dsh-ep-note' }, liveModels === null ? t('unavailable') : t('modelsEmpty'))
                        : h(
                            'div',
                            { className: 'dsh-ep-model-table' },
                            rows.map((row) =>
                                h(
                                    'div',
                                    { className: 'dsh-ep-model-row', key: row.route, 'data-checked': row.checked },
                                    h(
                                        'div',
                                        { className: 'dsh-ep-model-id' },
                                        h(
                                            'label',
                                            { className: 'dsh-ep-check' },
                                            h('input', {
                                                type: 'checkbox',
                                                'aria-label': t('modelExposedLabel') + ' — ' + row.route,
                                                checked: row.checked,
                                                disabled,
                                                onChange: (event) => editRow(row.route, { checked: event.target.checked }),
                                            }),
                                            h('code', { className: 'dsh-ep-mono' }, row.route),
                                        ),
                                        row.name === row.route
                                            ? null
                                            : h('span', { className: 'dsh-ep-model-name' }, row.name),
                                    ),
                                    h('input', {
                                        className: 'dsh-ep-input dsh-ep-model-input',
                                        type: 'text',
                                        'aria-label': t('modelCustomIdLabel'),
                                        'aria-invalid': issues.has(row.route),
                                        value: row.customId,
                                        placeholder: row.route,
                                        disabled,
                                        onChange: (event) => editRow(row.route, { customId: event.target.value }),
                                    }),
                                    issues.has(row.route)
                                        ? h(
                                            'p',
                                            { className: 'dsh-ep-note', 'data-tone': 'error' },
                                            t(issues.get(row.route)),
                                        )
                                        : null,
                                ),
                            ),
                        ),
                    fold.emptySelection
                        ? h('p', { className: 'dsh-ep-note', 'data-tone': 'error' }, t('modelsExposureEmpty'))
                        : null,
                ),

                h(
                    'div',
                    { className: 'dsh-ep-footer' },
                    h(
                        'button',
                        {
                            type: 'button',
                            className: 'dsh-ep-primary',
                            disabled: disabled || !state.dirty || saveBlocked,
                            onClick: () => void state.save(),
                        },
                        t(state.saving ? 'saving' : 'save'),
                    ),
                    h(
                        'button',
                        {
                            type: 'button',
                            className: 'dsh-ep-ghost',
                            disabled: disabled || !state.dirty,
                            onClick: () => {
                                setOverrides({});
                                state.discard();
                            },
                        },
                        t('discard'),
                    ),
                    state.failure !== null
                        ? h('span', { className: 'dsh-ep-note', 'data-tone': 'error' }, state.failure)
                        : state.saved
                            ? h('span', { className: 'dsh-ep-note', 'data-tone': 'success' }, t('saved'))
                            : null,
                ),
            );
        }

        const inject = ['slots', 'locale', 'configForms'];

        function apply(ctx) {
            ctx.effect(() => ctx.locale.register(LOCALE_NS, { en, zh }));

            // One settings page; the endpoint needs no composer seat.
            ctx.slots.inject('settings.section', () =>
                ctx.slots.register(
                    {
                        name: 'settings.section',
                        id: 'dsh-endpoint',
                        order: 63,
                        label: () => ctx.locale.bind(LOCALE_NS)('nav'),
                        locale: LOCALE_NS,
                        inject: () => {
                            const bound = ctx.locale.bind(LOCALE_NS);
                            return { configForms: ctx.configForms, t: (key) => bound(key) };
                        },
                    },
                    EndpointSettingsSection,
                ),
            );
        }

        exports.apply = apply;
        exports.inject = inject;
        // Pure helpers, exported for tests.
        exports.modelRows = modelRows;
        exports.modelConfig = modelConfig;
        exports.modelIdIssues = modelIdIssues;
        exports.editedFields = editedFields;
        return module.exports;
    },
});
