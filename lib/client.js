/**
 * dsh-codex-session — Web client half.
 *
 * Uses only shipped DSH browser surfaces:
 *
 *   conversation.input.dock   the seat directly above the composer, which the shell
 *                             renders for hero (blank) and started sessions alike. On a
 *                             blank session it is the "DSH 默认 / Codex" chooser; on a
 *                             started Codex session it is the passive backend badge.
 *   settings.plugins.tab      a page listing the preset roster, the Codex preset, and the
 *                             control that makes Codex the new-session default.
 *
 * The choice is an Agent-preset switch, exactly like DSH's own new-session picker
 * (`conversation.hero.agentPreset`), which this bundle feeds by declaring the `codex`
 * preset. Nothing shipped is shadowed or modified.
 */
window.__ModuleLoader__.load({
  id: 'dsh-codex-session',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

    const react = require('react');

    /** Locale namespace of this plugin's copy. */
    const NS = 'codexSession';
    /** Agent-preset id this bundle declares for Codex sessions. */
    const CODEX_PRESET = 'codex';
    /** Preset the chooser falls back to for a DSH-default session. */
    const DSH_PRESET = 'standard';
    /** Settings namespace storing the new-session default preset (the registry entry id). */
    const AGENT_PRESET_SETTINGS_NS = 'agent-preset-registry';

    const zh = {
      chooserLabel: '会话类型',
      chooserDsh: 'DSH 默认',
      chooserCodex: 'Codex',
      chooserHint: '新建会话由哪个后端提供服务。Codex 会话仍由 DSH 负责会话日志、工具和界面。',
      badgeTitle: '本会话由本机 Codex App Server 提供服务。',
      busy: '切换中…',
      failed: '切换失败：',
      nav: 'Codex 会话',
      intro:
        '「Codex 会话」是普通的 DSH 会话：会话日志、工具循环和界面都由 DSH 负责，只有模型请求走本机已登录的 Codex App Server。新建会话时在输入框上方选择即可，也可以在 Agent 预设里选「Codex」。',
      route: '模型路由',
      routeValue: 'codex-local → 本机 Codex App Server',
      rosterTitle: 'Agent 预设',
      rosterLoading: '正在读取…',
      rosterFailed: '读取失败：',
      rosterDefault: '新会话默认',
      rosterCodex: 'Codex',
      makeDefault: '设为新建会话默认',
      makingDefault: '正在保存…',
      madeDefault: '已设为默认',
    };

    const en = {
      chooserLabel: 'Session backend',
      chooserDsh: 'DSH default',
      chooserCodex: 'Codex',
      chooserHint:
        'Which backend serves this new session. A Codex session is still a DSH session for its log, tools and UI.',
      badgeTitle: 'This session is served by the local Codex App Server.',
      busy: 'Switching…',
      failed: 'Could not switch: ',
      nav: 'Codex sessions',
      intro:
        'A “Codex session” is an ordinary DSH session: DSH owns the session log, the tool loop and the UI, while model requests go to the locally authenticated Codex App Server. Choose it above the composer of a new session, or pick “Codex” in the Agent preset picker.',
      route: 'Model route',
      routeValue: 'codex-local → local Codex App Server',
      rosterTitle: 'Agent presets',
      rosterLoading: 'Loading…',
      rosterFailed: 'Could not load: ',
      rosterDefault: 'default for new sessions',
      rosterCodex: 'Codex',
      makeDefault: 'Make default for new sessions',
      makingDefault: 'Saving…',
      madeDefault: 'Saved as default',
    };

    function presetRows(roster) {
      return roster === undefined || roster.presets === undefined ? [] : roster.presets;
    }

    function defaultPresetId(roster) {
      const marked = presetRows(roster).find((row) => row.isDefault === true);
      return marked === undefined ? DSH_PRESET : marked.id;
    }

    function rowName(row) {
      return typeof row.name === 'string' && row.name.length > 0 ? row.name : row.id;
    }

    function rowDescription(row, t) {
      if (row.id === CODEX_PRESET) return t('intro');
      return typeof row.description === 'string' ? row.description : undefined;
    }

    //#region backend chooser / badge (conversation.input.dock)

    /**
     * `useProjection('agentPreset')` is the projection the shipped session-header label
     * reads, so this control and the header never disagree.
     */
    function CodexSessionDock(props) {
      const { locked, t, session, switchPreset, useProjection } = props;
      const projected = typeof useProjection === 'function' ? useProjection('agentPreset') : undefined;
      const isCodex = projected === CODEX_PRESET;
      const blank = session !== undefined && session.blank === true;
      const [busy, setBusy] = react.useState(false);
      const [failure, setFailure] = react.useState(null);

      // Hooks first, then the bail-outs. A locked session accepts no edits at all, so it gets no
      // switch and no badge — the Host would refuse the selection anyway.
      if (locked === true) return null;

      // A started DSH-default session needs no decoration; only Codex sessions are marked.
      if (!blank && !isCodex) return null;

      const select = (id) => {
        if (busy || id === projected) return;
        setBusy(true);
        setFailure(null);
        Promise.resolve(switchPreset(id)).then(
          (refusal) => {
            setBusy(false);
            if (typeof refusal === 'string') setFailure(refusal);
          },
          (error) => {
            setBusy(false);
            setFailure(error instanceof Error ? error.message : String(error));
          },
        );
      };

      if (!blank) {
        return react.createElement(
          'div',
          {
            title: t('badgeTitle'),
            style: {
              display: 'inline-flex',
              alignItems: 'center',
              gap: '6px',
              alignSelf: 'flex-start',
              margin: '0 0 6px 2px',
              padding: '1px 8px',
              borderRadius: '999px',
              border: '1px solid var(--dsw-alias-border-secondary, rgba(128,128,128,.28))',
              color: 'var(--dsw-alias-brand-text, #4d6bfe)',
              fontSize: '11px',
              lineHeight: '18px',
            },
          },
          react.createElement('span', {
            style: {
              width: '6px',
              height: '6px',
              borderRadius: '50%',
              background: 'var(--dsw-alias-brand-text, #4d6bfe)',
            },
          }),
          'Codex',
        );
      }

      const optionStyle = (active) => ({
        padding: '0 10px',
        height: '24px',
        borderRadius: '6px',
        border: '1px solid var(--dsw-alias-border-secondary, rgba(128,128,128,.28))',
        background: active ? 'var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,.14))' : 'transparent',
        color: active
          ? 'var(--dsw-alias-brand-text, #4d6bfe)'
          : 'var(--dsw-alias-label-secondary, #6b6b6b)',
        fontSize: '12px',
        lineHeight: '1',
        cursor: busy ? 'default' : 'pointer',
        opacity: busy ? 0.6 : 1,
        whiteSpace: 'nowrap',
      });

      return react.createElement(
        'div',
        {
          style: {
            display: 'flex',
            alignItems: 'center',
            gap: '8px',
            flexWrap: 'wrap',
            margin: '0 0 6px 2px',
          },
        },
        react.createElement(
          'span',
          {
            style: {
              fontSize: '11px',
              color: 'var(--dsw-alias-label-caption, #9a9a9a)',
              whiteSpace: 'nowrap',
            },
          },
          t('chooserLabel'),
        ),
        react.createElement(
          'div',
          { role: 'radiogroup', 'aria-label': t('chooserLabel'), style: { display: 'inline-flex', gap: '4px' } },
          react.createElement(
            'button',
            {
              type: 'button',
              role: 'radio',
              'aria-checked': !isCodex,
              onClick: () => select(DSH_PRESET),
              disabled: busy,
              style: optionStyle(!isCodex),
            },
            t('chooserDsh'),
          ),
          react.createElement(
            'button',
            {
              type: 'button',
              role: 'radio',
              'aria-checked': isCodex,
              onClick: () => select(CODEX_PRESET),
              disabled: busy,
              style: optionStyle(isCodex),
            },
            t('chooserCodex'),
          ),
        ),
        busy
          ? react.createElement(
              'span',
              { style: { fontSize: '11px', color: 'var(--dsw-alias-label-caption, #9a9a9a)' } },
              t('busy'),
            )
          : null,
        failure === null
          ? react.createElement(
              'span',
              {
                style: {
                  fontSize: '11px',
                  color: 'var(--dsw-alias-label-tertiary, #8a8a8a)',
                  minWidth: 0,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                },
              },
              t('chooserHint'),
            )
          : react.createElement(
              'span',
              { style: { fontSize: '11px', color: 'var(--dsw-alias-label-error, #d4380d)' } },
              `${t('failed')}${failure}`,
            ),
      );
    }

    //#endregion

    //#region settings page (settings.plugins.tab)

    function CodexSessionSettings(props) {
      const { t, loadRoster, makeDefault } = props;
      const [state, setState] = react.useState({ status: 'loading', roster: undefined, error: null });
      const [saving, setSaving] = react.useState(false);
      const [saved, setSaved] = react.useState(false);

      react.useEffect(() => {
        let alive = true;
        Promise.resolve(loadRoster()).then(
          (result) => {
            if (!alive) return;
            if (result.ok) setState({ status: 'ready', roster: result.value, error: null });
            else setState({ status: 'error', roster: undefined, error: result.error });
          },
          (error) => {
            if (!alive) return;
            setState({
              status: 'error',
              roster: undefined,
              error: error instanceof Error ? error.message : String(error),
            });
          },
        );
        return () => {
          alive = false;
        };
      }, [loadRoster]);

      const rows = presetRows(state.roster);
      const current = defaultPresetId(state.roster);

      const onMakeDefault = () => {
        if (saving) return;
        setSaving(true);
        setSaved(false);
        Promise.resolve(makeDefault(CODEX_PRESET)).then(
          (refusal) => {
            setSaving(false);
            if (typeof refusal === 'string') setState((prev) => ({ ...prev, error: refusal }));
            else setSaved(true);
          },
          (error) => {
            setSaving(false);
            setState((prev) => ({
              ...prev,
              error: error instanceof Error ? error.message : String(error),
            }));
          },
        );
      };

      const rowStyle = {
        display: 'grid',
        gap: '2px',
        padding: '8px 10px',
        border: '1px solid var(--dsw-alias-border-secondary, rgba(128,128,128,.28))',
        borderRadius: '8px',
      };
      const tagStyle = {
        fontSize: '11px',
        padding: '1px 6px',
        borderRadius: '999px',
        background: 'var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,.14))',
        color: 'var(--dsw-alias-brand-text, #4d6bfe)',
      };

      return react.createElement(
        'div',
        { style: { display: 'grid', gap: '10px' } },
        react.createElement(
          'p',
          { style: { margin: 0, color: 'var(--dsw-alias-label-secondary, #6b6b6b)' } },
          t('intro'),
        ),
        react.createElement(
          'p',
          { style: { margin: 0 } },
          react.createElement('strong', null, `${t('route')}: `),
          react.createElement('code', null, t('routeValue')),
        ),
        react.createElement('h4', { style: { margin: '6px 0 0' } }, t('rosterTitle')),
        state.status === 'loading'
          ? react.createElement('p', { style: { margin: 0 } }, t('rosterLoading'))
          : null,
        state.error !== null && state.error !== undefined
          ? react.createElement(
              'p',
              { style: { margin: 0, color: 'var(--dsw-alias-label-error, #d4380d)' } },
              `${t('rosterFailed')}${String(state.error)}`,
            )
          : null,
        react.createElement(
          'ul',
          { style: { margin: '2px 0 0', padding: 0, listStyle: 'none', display: 'grid', gap: '6px' } },
          rows.map((row) => {
            const description = rowDescription(row, t);
            return react.createElement(
              'li',
              { key: row.id, style: rowStyle },
              react.createElement(
                'span',
                { style: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' } },
                react.createElement('strong', null, rowName(row)),
                row.id === CODEX_PRESET ? react.createElement('span', { style: tagStyle }, t('rosterCodex')) : null,
                row.id === current
                  ? react.createElement(
                      'span',
                      { style: { fontSize: '11px', color: 'var(--dsw-alias-label-caption, #9a9a9a)' } },
                      t('rosterDefault'),
                    )
                  : null,
              ),
              description === undefined
                ? null
                : react.createElement(
                    'span',
                    { style: { fontSize: '12px', color: 'var(--dsw-alias-label-tertiary, #8a8a8a)' } },
                    description,
                  ),
            );
          }),
        ),
        react.createElement(
          'div',
          { style: { display: 'flex', alignItems: 'center', gap: '10px' } },
          react.createElement(
            'button',
            {
              type: 'button',
              onClick: onMakeDefault,
              disabled: saving,
              style: {
                padding: '4px 10px',
                borderRadius: '6px',
                border: '1px solid var(--dsw-alias-border-secondary, rgba(128,128,128,.28))',
                background: 'transparent',
                color: 'var(--dsw-alias-label-primary, inherit)',
                cursor: saving ? 'default' : 'pointer',
                opacity: saving ? 0.6 : 1,
              },
            },
            saving ? t('makingDefault') : t('makeDefault'),
          ),
          saved ? react.createElement('span', { style: { fontSize: '12px' } }, t('madeDefault')) : null,
        ),
      );
    }

    //#endregion

    /** Browser services required for slot composition and localized presentation. */
    const inject = ['slots', 'locale', 'remote', 'remote.agentPresets', 'remote.settings'];

    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-codex-session: dictionaries');

      /** Switch one session's Agent preset; resolves to the Host refusal text, or undefined. */
      const switchPreset = async (sessionId, id) => {
        try {
          const result = await ctx.remote.agentPresets.select(sessionId, id);
          if (result.ok) return undefined;
          if (result.error.code === 'gateway/invocation-unavailable') return undefined;
          return result.error.message;
        } catch (error) {
          return error instanceof Error ? error.message : String(error);
        }
      };

      const loadRoster = async () => {
        try {
          const result = await ctx.remote.agentPresets.list();
          return result.ok ? { ok: true, value: result.value } : { ok: false, error: result.error.message };
        } catch (error) {
          return { ok: false, error: error instanceof Error ? error.message : String(error) };
        }
      };

      /** Persist the new-session default preset through the registry's settings namespace. */
      const makeDefault = async (id) => {
        try {
          const result = await ctx.remote.settings.update(
            AGENT_PRESET_SETTINGS_NS,
            { selectedDefault: id },
            undefined,
          );
          return result.ok ? undefined : result.error.message;
        } catch (error) {
          return error instanceof Error ? error.message : String(error);
        }
      };

      ctx.slots.inject('conversation.input.dock', () =>
        ctx.slots.register(
          {
            name: 'conversation.input.dock',
            id: 'codex-session',
            order: 10,
            locale: NS,
            inject: (sessionId) => ({
              switchPreset: (id) => switchPreset(sessionId, id),
            }),
          },
          CodexSessionDock,
        ),
      );

      ctx.slots.inject('settings.plugins.tab', () =>
        ctx.slots.register(
          {
            name: 'settings.plugins.tab',
            id: 'codex-session',
            order: 60,
            label: () => ctx.locale.bind(NS)('nav'),
            locale: NS,
            inject: () => ({ loadRoster, makeDefault }),
          },
          CodexSessionSettings,
        ),
      );
    }

    exports.CODEX_PRESET = CODEX_PRESET;
    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});
