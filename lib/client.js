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
    id: 'dsh-endpoint',
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
            reachLabel: 'Reachable from',
            reachLoopback: 'This machine',
            reachLan: 'Local network',
            reachPublic: 'Public internet',
            reachNo: 'not exposed on this bind address',
            reachPublicYes: 'this port, through your router or NAT forward',
            authLabel: 'Authentication',
            authNone: 'none — anyone who can reach the port can spend this profile\'s quota',
            authBearer: 'bearer token',
            tlsLabel: 'TLS',
            tlsNone: 'not served here — put a reverse proxy in front before exposing this',
            enabledLabel: 'Run the endpoint',
            enabledHint: 'Stop the listener without uninstalling the plugin.',
            hostLabel: 'Bind address',
            hostHint: '127.0.0.1 keeps it on this machine. 0.0.0.0 accepts every interface. Leave the API key empty only for loopback binds.',
            hostPlaceholder: '127.0.0.1',
            portLabel: 'Port',
            portHint: 'The TCP port clients connect to.',
            apiKeyLabel: 'API key',
            apiKeyHint: 'When set, clients send it as Authorization: Bearer <key>.',
            apiKeyPlaceholder: 'no authentication',
            generate: 'Generate',
            generateHint: 'Fills the field with a fresh random key. Copy it into your client before saving; this field is the only place it is stored.',
            modelsLabel: 'Models behind this endpoint',
            modelsHint: 'Read from the profile. Details — context window, output ceiling, modalities, reasoning efforts — are on /v1/models.',
            loading: 'Reading live state…',
            save: 'Save',
            saving: 'Saving…',
            saved: 'Saved. The listener rebinds on its own.',
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
            reachLabel: '可从这里访问',
            reachLoopback: '本机',
            reachLan: '局域网',
            reachPublic: '公网',
            reachNo: '当前绑定地址未暴露',
            reachPublicYes: '经路由器 / NAT 端口转发访问此端口',
            authLabel: '鉴权',
            authNone: '无 —— 任何能连上这个端口的人都能消耗本 profile 的额度',
            authBearer: 'Bearer 令牌',
            tlsLabel: 'TLS',
            tlsNone: '此处不提供 —— 对外暴露前请在前面放反向代理',
            enabledLabel: '启用端点',
            enabledHint: '关掉监听，但不用卸载插件。',
            hostLabel: '绑定地址',
            hostHint: '127.0.0.1 只在本机；0.0.0.0 接受所有网卡。只有绑定回环地址时才建议留空 API key。',
            hostPlaceholder: '127.0.0.1',
            portLabel: '端口',
            portHint: '客户端连接的 TCP 端口。',
            apiKeyLabel: 'API key',
            apiKeyHint: '设置后，客户端需要以 Authorization: Bearer <key> 发送。',
            apiKeyPlaceholder: '不鉴权',
            generate: '生成',
            generateHint: '填入一个新的随机 key。保存前先复制到客户端 —— 这个字段是它唯一的存放处。',
            modelsLabel: '端点背后的模型',
            modelsHint: '来自 profile。上下文长度、输出上限、模态、思考档位等细节在 /v1/models。',
            loading: '正在读取实时状态…',
            save: '保存',
            saving: '保存中…',
            saved: '已保存，监听会自行重建。',
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

            return { value, field, dirty, saving, failure, saved, edit, discard, save };
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

            if (form === undefined) {
                return h('div', { className: 'dsh-ep' }, h('p', { className: 'dsh-ep-note' }, t('unavailable')));
            }

            const live = status.phase === 'ready' ? status.document : null;
            const disabled = state.saving;
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
                    h(
                        Row,
                        { label: t('reachLabel') },
                        h(
                            'div',
                            { className: 'dsh-ep-list' },
                            h('span', { className: 'dsh-ep-tag' }, `${t('reachLoopback')}: ${live?.reachability?.loopback === true ? '✓' : '—'}`),
                            h('span', { className: 'dsh-ep-tag' }, `${t('reachLan')}: ${live?.reachability?.lan === true ? '✓' : t('reachNo')}`),
                            h('span', { className: 'dsh-ep-tag' }, `${t('reachPublic')}: ${live?.reachability?.public === true ? t('reachPublicYes') : t('reachNo')}`),
                        ),
                    ),
                    h(Row, { label: t('authLabel') }, t(live?.auth === 'bearer' ? 'authBearer' : 'authNone')),
                    h(Row, { label: t('tlsLabel') }, t('tlsNone')),
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
                    { className: 'dsh-ep-footer' },
                    h(
                        'button',
                        {
                            type: 'button',
                            className: 'dsh-ep-primary',
                            disabled: disabled || !state.dirty,
                            onClick: () => void state.save(),
                        },
                        t(state.saving ? 'saving' : 'save'),
                    ),
                    h('button', { type: 'button', className: 'dsh-ep-ghost', disabled: disabled || !state.dirty, onClick: state.discard }, t('discard')),
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
        return module.exports;
    },
});
