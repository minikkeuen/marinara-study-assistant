((marinara) => {
  'use strict';

  if (!marinara?.extension?.id || !marinara?.storage || typeof marinara.onCleanup !== 'function') {
    throw new Error('English Study Simple은 Marinara Engine 2.4.0 확장 API가 필요합니다.');
  }

  const storage = marinara.storage;
  const activeRequests = new Set();
  const activeTimers = new Set();

  const setTimeout = (callback, delay, ...args) => {
    const timerId = marinara.setTimeout(() => {
      activeTimers.delete(timerId);
      callback(...args);
    }, delay);
    activeTimers.add(timerId);
    return timerId;
  };

  const clearTimeout = timerId => {
    if (timerId == null) return;
    marinara.clearTimeout(timerId);
    activeTimers.delete(timerId);
  };

  const addStyle = css => {
    const style = document.createElement('style');
    style.dataset.marinaraExtension = marinara.extension.id;
    style.textContent = css;
    document.head.append(style);
    marinara.onCleanup(() => style.remove());
    return style;
  };

  const addElement = (parent, tagName, attributes = {}) => {
    const element = document.createElement(tagName);
    for (const [name, value] of Object.entries(attributes)) {
      if (name === 'textContent') element.textContent = value;
      else if (value != null) element.setAttribute(name, String(value));
    }
    parent.append(element);
    marinara.onCleanup(() => element.remove());
    return element;
  };

  const on = (target, eventName, listener, options) => {
    target?.addEventListener(eventName, listener, options);
    marinara.onCleanup(() => target?.removeEventListener(eventName, listener, options));
  };

  marinara.onCleanup(() => {
    for (const timerId of activeTimers) marinara.clearTimeout(timerId);
    activeTimers.clear();
    for (const controller of activeRequests) controller.abort();
    activeRequests.clear();
  });

  const ROOT = 'mari-english-study';
  const TOGGLE = 'mari-english-study-toggle';
  const POPUP = 'mari-english-study-popup';
  const SELECTION_ACTION = 'mari-english-study-simple-selection-action';
  const TOGGLE_POS_KEY = 'mari-english-study-toggle-pos';
  const LONG_PRESS_MS = 550;
  if (document.getElementById(ROOT) || document.getElementById(TOGGLE)) return;

  const defaults = {
    mode: 'auto',
    clickScope: 'sentence',
    mobileAction: 'menu',
    enabled: true,
    connectionId: '',
    connections: [],
    vocabulary: [],
    analysisHistory: [],
    activeAnalysisId: '',
    promptCommon: 'Output format rules:\n- Use only simple, readable Markdown.\n- At most one heading is allowed, and it must use a single # heading level.\n- Section labels enclosed in square brackets, such as [Translation] or [Grammar], are allowed.\n- Bullet lists and numbered lists are allowed only at one level, with no indentation or nested items.\n- Use plain text for all sentence content.\n- Do not use bold, italics, strikethrough, inline code, links, tables, blockquotes, code fences, horizontal rules, task lists, HTML, or any other inline Markdown formatting.\n- Use simple paragraphs and line breaks for the rest of the response.\n- Do not wrap the entire answer in quotation marks.\n- Keep the structure compact and easy to scan.\n- Follow the requested language and format exactly.\n- Do not add meta-commentary, disclaimers, or notes unless explicitly requested.',
    prompts: {
      translate: 'You are a professional English-to-Korean translator for fiction, dialogue, and roleplay. Translate the provided English text into natural Korean while preserving the original meaning, tone, nuance, dialogue structure, formatting, and line breaks. Output only the Korean translation. Do not include the original text, titles, headings, explanations, labels, quotation marks, notes, or any additional text.',
      grammar: 'You are an English grammar tutor for a Korean learner. Analyze the selected English text in Korean. Explain the sentence structure, clauses, tense, voice, important grammar patterns, and the grammatical role of key words or phrases. Quote only the necessary English fragments. Keep the explanation practical, accurate, and easy to scan.',
      nuance: 'You are an English usage and nuance tutor for a Korean learner. Explain the selected English text in Korean. Focus on the intended meaning, emotional tone, level of formality, implied attitude, contextual subtext, and how a native speaker would perceive it. Distinguish literal meaning from natural contextual meaning when useful. Keep the explanation practical and easy to scan.',
      similar: 'You are an English expression tutor for a Korean learner. Give natural English alternatives at both sentence level and key-expression level. Preserve the original meaning. For each alternative, provide a concise Korean meaning and a short note about tone, formality, or nuance.',
      difficulty: 'You are an English proficiency assessor for a Korean learner. Estimate the selected English text at a CEFR level from A1 to C2. Answer in Korean. Include the estimated level, difficult vocabulary or expressions, grammar features, why it fits that level, and a simpler English rewrite one level below. Acknowledge uncertainty when the sample is too short.'
    },
    togglePosition: null,
    panelPosition: null,
    popupPosition: null
  };
  let cfg = { ...defaults };
  let selectedText = '';
  let selectedKind = 'sentence';
  let activeTask = 'combined';
  let pressTimer = null;
  let pressStart = null;
  let pendingSelection = null;
  let selectionTimer = null;
  let selectionReconcileTimer = null;
  let vocabularyFilter = 'all';
  let vocabularySelectionMode = false;
  const selectedVocabularyIds = new Set();
  let activeMenuCardId = '';
  let activePopupEditId = '';
  let popupEditBaseline = '';
  let popupReturnToRoot = false;
  let storageReady = false;
  let storageLoadPromise = null;

  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
  }[c]));

  const normalizeSelectionText = value => {
    let text = String(value || '')
      .replace(/\u00a0/g, ' ')
      .replace(/[ \t]+/g, ' ')
      .replace(/\s*\n\s*/g, '\n')
      .trim();

    // Treat surrounding quotation marks and brackets as selection noise.
    // Internal apostrophes/quotes are preserved.
    const wrappers = [
      ['"', '"'], ["'", "'"],
      ['“', '”'], ['‘', '’'],
      ['「', '」'], ['『', '』'],
      ['《', '》'], ['〈', '〉'],
      ['(', ')'], ['[', ']'], ['{', '}']
    ];

    let changed = true;
    while (changed && text.length > 1) {
      changed = false;

      for (const [open, close] of wrappers) {
        if (text.startsWith(open) && text.endsWith(close)) {
          text = text.slice(open.length, -close.length).trim();
          changed = true;
          break;
        }
      }

      // Also remove a single stray quote captured at only one edge.
      const before = text;
      text = text
        .replace(/^[\u0022\u0027“”‘’]+(?=\S)/, '')
        .replace(/(?<=\S)[\u0022\u0027“”‘’]+$/, '')
        .trim();
      if (text !== before) changed = true;
    }

    return text;
  };

  const analysisKey = (text, kind) =>
    `${kind || 'sentence'}::${normalizeSelectionText(text).toLocaleLowerCase()}`;

  const isCoarse = () => window.matchMedia('(pointer: coarse)').matches;
  const effectiveMode = () => {
    if (cfg.mode === 'auto' || cfg.mode === 'auto-longpress') {
      return isCoarse() ? 'longpress' : 'selection';
    }
    if (cfg.mode === 'auto-click') {
      return isCoarse() ? 'doubleclick' : 'selection';
    }
    return cfg.mode;
  };

  addStyle(`
#${TOGGLE}{position:fixed;right:18px;bottom:88px;z-index:9996;display:grid;width:44px;height:44px;place-items:center;border:1px solid var(--border,#444);border-radius:9999px;background:var(--card,var(--background,#171717));color:var(--card-foreground,var(--foreground,#eee));box-shadow:0 4px 14px #0005;cursor:grab;touch-action:none;user-select:none;font:inherit;font-size:20px}
#${TOGGLE}:active{cursor:grabbing}
#${TOGGLE}[data-dragging="true"]{cursor:grabbing;opacity:.85}
#${ROOT}[hidden],#${POPUP}[hidden],#${SELECTION_ACTION}[hidden]{display:none}
#${SELECTION_ACTION}{position:fixed;z-index:2147483000;display:flex;align-items:center;justify-content:center;min-width:70px;min-height:44px;padding:9px 16px;border:0;border-radius:999px;background:var(--primary,#7c9cff);color:var(--primary-foreground,#101010);box-shadow:0 4px 14px #0005;cursor:pointer;touch-action:manipulation;user-select:none;font:700 13px/1 system-ui,sans-serif}
#${SELECTION_ACTION}:hover{opacity:.86}
#${SELECTION_ACTION}:focus-visible{outline:2px solid currentColor;outline-offset:2px}
#${SELECTION_ACTION}[data-combined="true"]{border-radius:0 999px 999px 0;box-shadow:inset 1px 0 color-mix(in srgb,currentColor 28%,transparent),0 4px 14px #0005}
[data-mes-selection-partner="true"]{min-height:44px!important;border-radius:0!important}
[data-mes-selection-partner-position="first"]{border-radius:999px 0 0 999px!important}
[data-mes-selection-partner-position="middle"]{box-shadow:inset 1px 0 color-mix(in srgb,currentColor 28%,transparent)!important}
#${ROOT}{position:fixed;right:16px;bottom:140px;z-index:9998;width:min(340px,calc(100vw - 24px));max-height:72vh;overflow:auto;border:1px solid var(--border,#444);border-radius:14px;background:var(--card,var(--background,#171717));color:var(--card-foreground,var(--foreground,#eee));box-shadow:0 14px 42px #0008;font:12px/1.45 system-ui,sans-serif}
#${ROOT} * ,#${POPUP} *{box-sizing:border-box}
#${ROOT} .mes-head,#${POPUP} .mes-head{display:flex;align-items:center;justify-content:space-between;gap:8px;min-height:38px;padding:4px 8px 4px 10px;border-bottom:1px solid var(--border,#444);font-weight:800;font-size:13px}
#${POPUP} .mes-head{position:sticky;top:0;z-index:5;background:var(--card,var(--background,#171717))}
#${POPUP} .mes-head{cursor:grab;touch-action:none;user-select:none}
#${POPUP} .mes-head:active{cursor:grabbing}
#${POPUP} .mes-popup-head-actions{display:flex;align-items:center;gap:2px}
#${POPUP} .mes-popup-head-actions button{width:28px;height:28px;padding:0;display:grid;place-items:center;border-radius:7px;font-size:15px}
#${ROOT} .mes-head{cursor:grab;touch-action:none;user-select:none}
#${ROOT} .mes-head:active{cursor:grabbing}
#${ROOT} .mes-head button{cursor:pointer}
#${ROOT} .mes-head span,#${POPUP} .mes-head span{margin-right:auto}
#${ROOT} button,#${POPUP} button{border:1px solid var(--border,#555);background:var(--secondary,#292929);color:inherit;border-radius:8px;padding:6px 9px;cursor:pointer;font:inherit}
#${TOGGLE}:focus-visible,#${ROOT} button:focus-visible,#${ROOT} input:focus-visible,#${ROOT} select:focus-visible,#${ROOT} textarea:focus-visible,#${POPUP} button:focus-visible,#${POPUP} select:focus-visible{outline:2px solid var(--primary,#7c9cff);outline-offset:2px}
#${POPUP} .mes-history-toggle{display:flex;align-items:center;gap:3px;min-width:28px;padding:2px 3px;border:0;background:transparent;border-radius:5px;font-size:11px;line-height:1.2;opacity:.58}
#${POPUP} .mes-history-toggle:hover,#${POPUP} .mes-history-toggle:focus-visible{background:var(--secondary,#292929);opacity:1}
#${POPUP} .mes-history-panel{display:flex;gap:6px;padding:8px 10px;border-bottom:1px solid var(--border,#444)}
#${POPUP} .mes-history-panel[hidden]{display:none}
#${POPUP} .mes-history-panel select{min-width:0;flex:1;border:1px solid var(--border,#555);background:var(--background,#181818);color:inherit;border-radius:7px;padding:6px}
#${POPUP} .mes-history-panel [data-act="delete-history"]{border:0;background:transparent;opacity:.58}
#${POPUP} .mes-history-panel [data-act="delete-history"]:hover,#${POPUP} .mes-history-panel [data-act="delete-history"]:focus-visible{background:var(--secondary,#292929);opacity:1}
#${POPUP} .mes-tabs-row{display:flex;align-items:center;min-height:40px;overflow:hidden;border-bottom:1px solid color-mix(in srgb,var(--border,#444) 72%,transparent)}
#${POPUP} .mes-tabs{display:flex;align-items:center;gap:17px;min-width:0;flex:1;overflow-x:auto;overflow-y:hidden;padding:0 10px;border-bottom:0;scrollbar-width:none;-ms-overflow-style:none}
#${POPUP} .mes-tabs::-webkit-scrollbar{display:none}
#${POPUP} .mes-tabs button{position:relative;white-space:nowrap;min-height:40px;padding:0 0 2px;display:flex;align-items:center;border:0;border-radius:0;background:transparent;opacity:.55}
#${POPUP} .mes-tabs button::after{content:"";position:absolute;left:0;right:0;bottom:-1px;height:1px;background:transparent;transform:scaleX(.35);transition:transform .14s ease,background .14s ease}
#${POPUP} .mes-tabs button:hover,#${POPUP} .mes-tabs button:focus-visible{opacity:.86}
#${POPUP} .mes-tabs button[data-active="true"]{background:transparent;color:inherit;font-weight:700;opacity:1}
#${POPUP} .mes-tabs button[data-active="true"]::after{background:currentColor;transform:scaleX(1)}
#${POPUP} .mes-regenerate{flex:0 0 auto;width:36px;height:40px;margin:0 6px 0 0;padding:0;display:grid;place-items:center;border:0;background:transparent;border-radius:6px;font-size:15px;line-height:1;opacity:.55}
#${POPUP} .mes-regenerate:hover,#${POPUP} .mes-regenerate:focus-visible{background:var(--secondary,#292929);opacity:1}
#${POPUP} .mes-result{white-space:pre-wrap}
#${POPUP} .mes-combined{display:grid;gap:0;padding:0 12px 12px}
#${POPUP} .mes-combined-section{padding:13px 0 14px;border:0;border-bottom:1px solid color-mix(in srgb,var(--border,#444) 65%,transparent);border-radius:0}
#${POPUP} .mes-combined-section:last-child{border-bottom:0}
#${POPUP} .mes-combined-title{padding:0 0 7px;border:0;background:transparent;font-size:13px;font-weight:750}
#${POPUP} .mes-combined-title::after{content:"";display:block;width:22px;height:1px;margin-top:6px;background:currentColor;opacity:.28}
#${POPUP} .mes-combined-body{padding:0;white-space:pre-wrap;line-height:1.62}
#${POPUP} .mes-combined-empty{opacity:.48}


#${ROOT} .mes-body{display:grid;gap:10px;padding:12px}
#${ROOT} label{display:grid;gap:4px;font-weight:600}
#${ROOT} select,#${ROOT} input{width:100%;padding:7px;border:1px solid var(--border,#555);border-radius:8px;background:var(--background,#181818);color:inherit}
#${ROOT} .mes-muted,#${POPUP} .mes-muted{opacity:.68}
#${ROOT} .mes-list{display:grid;gap:6px}
#${ROOT} .mes-vocab-tools{display:grid;gap:7px}
#${ROOT}:has([data-root-view="vocabulary"]:not([hidden])){width:340px;min-width:340px;max-width:340px}
#${ROOT} .mes-vocab-filter-row{display:flex;align-items:flex-end;justify-content:space-between;gap:12px;border-bottom:1px solid color-mix(in srgb,var(--border,#444) 72%,transparent)}
#${ROOT} .mes-vocab-filters{display:flex;align-items:center;gap:18px;padding:0 2px;border-bottom:0}
#${ROOT} .mes-vocab-count{flex:0 0 auto;padding:0 2px 8px;font-size:11px;line-height:1;opacity:.52}
#${ROOT} .mes-vocab-filters button{position:relative;min-height:30px;padding:2px 0 7px;border:0;border-radius:0;background:transparent;color:inherit;font-size:12px;opacity:.55}
#${ROOT} .mes-vocab-filters button::after{content:"";position:absolute;left:0;right:0;bottom:-1px;height:1px;background:transparent;transform:scaleX(.35);transition:transform .14s ease,background .14s ease}
#${ROOT} .mes-vocab-filters button:hover,#${ROOT} .mes-vocab-filters button:focus-visible{opacity:.86}
#${ROOT} .mes-vocab-filters button[data-active="true"]{opacity:1;font-weight:700}
#${ROOT} .mes-vocab-filters button[data-active="true"]::after{background:currentColor;transform:scaleX(1)}
#${ROOT} .mes-vocab-actions{display:grid;grid-template-columns:1fr 1fr;gap:7px}
#${ROOT} .mes-vocab-actions [data-act="clear"]{grid-column:1/-1}
#${ROOT} .mes-card{position:relative;padding:8px 9px 7px;border:1px solid var(--border,#444);border-radius:9px;background:color-mix(in srgb,var(--background,#171717) 82%,transparent)}
#${ROOT} .mes-card-text{padding-right:2px;white-space:pre-wrap;word-break:break-word;font-weight:700;line-height:1.42;cursor:pointer}
#${ROOT} .mes-card-preview{margin-top:4px;padding-right:2px;white-space:pre-wrap;word-break:break-word;line-height:1.42;opacity:.78}
#${ROOT} .mes-card-buttons{display:flex;justify-content:flex-end;gap:2px;margin-top:4px}
#${ROOT} .mes-card-buttons button{width:26px;height:26px;min-width:26px;padding:0;display:grid;place-items:center;border:0;border-radius:6px;background:transparent;color:inherit;font-size:14px;line-height:1;opacity:.62}
#${ROOT} .mes-card-buttons button:hover,#${ROOT} .mes-card-buttons button:focus-visible{background:var(--secondary,#292929);opacity:1}
#${ROOT} .mes-card-buttons button[data-favorite-vocab][data-active="true"]{opacity:1}
#${POPUP}{position:fixed;z-index:9999;width:min(390px,calc(100vw - 20px));max-height:min(70vh,560px);overflow:auto;scrollbar-width:none;-ms-overflow-style:none;border:1px solid var(--border,#444);border-radius:14px;background:var(--card,var(--background,#171717));color:var(--card-foreground,var(--foreground,#eee));box-shadow:0 16px 48px #0009;font:13px/1.5 system-ui,sans-serif}
#${POPUP}::-webkit-scrollbar{display:none}
#${POPUP} .mes-selected-row{display:flex;align-items:center;gap:10px;padding:8px 10px 8px 12px;border-bottom:1px solid var(--border,#444)}
#${POPUP} .mes-selected{min-width:0;flex:1;padding:0;white-space:pre-wrap;word-break:break-word;border:0;font-size:14px;line-height:1.45;font-weight:650}
#${POPUP} .mes-selected-actions{display:flex;align-items:center;gap:2px;flex:0 0 auto}
#${POPUP} .mes-selected-actions>button{width:28px;height:28px;padding:0;display:inline-flex;align-items:center;justify-content:center;gap:2px;white-space:nowrap;border:0;background:transparent;border-radius:6px;font-size:14px;line-height:1;opacity:.56}
#${POPUP} .mes-selected-actions>button:hover,#${POPUP} .mes-selected-actions>button:focus-visible{background:var(--secondary,#292929);opacity:1}
#${POPUP} .mes-selected-actions>[data-act="save"][data-saved="true"]{opacity:1}
#${POPUP} .mes-history-toggle{display:inline-flex!important;align-items:center;justify-content:center;gap:2px;white-space:nowrap}
#${POPUP} .mes-history-toggle>span{display:inline;line-height:1}
#${POPUP} .mes-result{min-height:64px;padding:12px;border-top:0;white-space:pre-wrap;line-height:1.62}
#${ROOT}{overflow:hidden}
#${ROOT} .mes-root-head{position:sticky;top:0;z-index:5;display:flex;align-items:center;justify-content:space-between;gap:8px;min-height:38px;padding:4px 8px 4px 10px;border-bottom:1px solid var(--border,#444);background:var(--card,var(--background,#171717));font-weight:800;font-size:13px;cursor:grab;touch-action:none;user-select:none}
#${ROOT} .mes-root-head-actions{display:flex;align-items:center;gap:2px}
#${ROOT} .mes-root-head button{width:28px;height:28px;padding:0;display:grid;place-items:center;border-radius:7px;font-size:15px}
#${ROOT} .mes-root-view{display:grid;gap:7px;padding:8px;max-height:calc(72vh - 39px);overflow:auto}
#${ROOT} .mes-root-view[hidden]{display:none!important}
#${ROOT} .mes-settings-section{display:grid;gap:9px;padding-top:10px;border-top:1px solid var(--border,#444)}
#${ROOT} details.mes-settings-section{display:block}
#${ROOT} .mes-prompt-settings>summary{display:flex;align-items:center;justify-content:space-between;min-height:34px;cursor:pointer;list-style:none;font-weight:700}
#${ROOT} .mes-prompt-settings>summary::-webkit-details-marker{display:none}
#${ROOT} .mes-summary-chevron{opacity:.55;transition:transform .14s ease}
#${ROOT} .mes-prompt-settings[open] .mes-summary-chevron{transform:rotate(180deg)}
#${ROOT} .mes-prompt-settings-body{display:grid;gap:9px;padding-top:8px}
#${ROOT} .mes-settings-title-row{display:flex;align-items:center;justify-content:space-between;gap:8px}
#${ROOT} .mes-settings-title-row button{flex:0 0 auto;padding:4px 7px;border:0;background:transparent;opacity:.62}
#${ROOT} .mes-settings-title-row button:hover{background:var(--secondary,#292929);opacity:1}
#${ROOT} .mes-prompt-settings label{display:grid;gap:5px}
#${ROOT} .mes-prompt-settings textarea{width:100%;min-height:92px;resize:vertical;padding:8px;border:1px solid var(--border,#555);border-radius:8px;background:var(--background,#171717);color:inherit;font:11px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace}

#${ROOT} .mes-storage-error{margin:8px 8px 0;padding:8px 10px;border:1px solid color-mix(in srgb,#e5484d 48%,var(--border,#444));border-radius:8px;background:color-mix(in srgb,#e5484d 10%,var(--background,#171717));color:#e86a6f;font-size:11px;line-height:1.45}
#${ROOT} .mes-storage-error[hidden]{display:none}
#${ROOT} .mes-vocab-count-actions{display:flex;align-items:center;gap:6px;padding-bottom:5px}
#${ROOT} .mes-vocab-count-actions .mes-vocab-count{padding:0}
#${ROOT} .mes-vocab-count-actions button{min-height:26px;padding:3px 7px;border:0;background:transparent;opacity:.65}
#${ROOT} .mes-vocab-bulk{display:grid;gap:6px;padding:8px;border:1px solid color-mix(in srgb,var(--border,#444) 78%,transparent);border-radius:9px;background:color-mix(in srgb,var(--secondary,#292929) 58%,transparent)}
#${ROOT} .mes-vocab-bulk[hidden]{display:none}
#${ROOT} .mes-vocab-bulk-head{display:flex;align-items:center;justify-content:space-between;gap:8px}
#${ROOT} .mes-vocab-select-all{display:flex;grid-template:none;align-items:center;gap:6px;font-weight:650}
#${ROOT} .mes-vocab-select-all input,#${ROOT} .mes-card-select input{width:16px;height:16px;margin:0;accent-color:var(--primary,#7c9cff)}
#${ROOT} .mes-vocab-selected-count{font-size:11px;opacity:.68}
#${ROOT} .mes-vocab-bulk-actions{display:grid;grid-template-columns:1fr 1fr;gap:5px}
#${ROOT} .mes-vocab-bulk-actions button{min-height:34px;padding:6px 7px}
#${ROOT} .mes-vocab-bulk-actions button:disabled{cursor:not-allowed;opacity:.42}
#${ROOT} .mes-vocab-bulk-actions [data-bulk-vocab="delete"]{color:#e86a6f}
#${ROOT} .mes-card[data-selection-mode="true"]{padding-left:36px;cursor:pointer}
#${ROOT} .mes-card[data-selected="true"]{border-color:color-mix(in srgb,var(--primary,#7c9cff) 68%,var(--border,#444));background:color-mix(in srgb,var(--primary,#7c9cff) 9%,var(--background,#171717))}
#${ROOT} .mes-card-select{position:absolute;left:10px;top:11px;display:flex;grid-template:none;align-items:center}
#${ROOT} .mes-card[data-selection-mode="true"] .mes-card-buttons{display:none}
#${ROOT} .mes-card-footer{display:flex;align-items:center;justify-content:flex-end;gap:8px;margin-top:6px;min-height:26px}
#${ROOT} .mes-card-menu{position:fixed;inset:auto;right:auto;bottom:auto;z-index:100;width:150px;height:auto!important;min-height:0;max-height:min(180px,calc(100vh - 16px));margin:0;padding:4px;overflow-y:auto;overflow-x:hidden;border:1px solid var(--border,#555);border-radius:10px;background:var(--card,var(--background,#171717));color:var(--card-foreground,var(--foreground,#eee));box-shadow:0 10px 28px #0007}
#${ROOT} .mes-card-menu:not(:popover-open){display:none}
#${ROOT} .mes-card-menu:popover-open{display:grid;grid-auto-rows:max-content;align-content:start;gap:2px}
#${ROOT} .mes-card-menu button{display:flex;align-items:center;justify-content:flex-start;min-height:34px;width:100%;padding:7px 9px;border:0;background:transparent;text-align:left}
#${ROOT} .mes-card-menu button:hover,#${ROOT} .mes-card-menu button:focus-visible{background:var(--secondary,#292929)}
#${ROOT} .mes-card-menu [data-menu-card-action="remove"]{margin-top:3px;border-top:1px solid var(--border,#444);border-radius:0 0 7px 7px;color:#e86a6f}
#${POPUP} .mes-tabs-actions{display:flex;align-items:center;flex:0 0 auto;margin-right:6px}
#${POPUP} .mes-tabs-actions button{width:36px;height:40px;padding:0;display:grid;place-items:center;border:0;background:transparent;border-radius:6px;font-size:15px;line-height:1;opacity:.55}
#${POPUP} .mes-popup-panel{padding:12px}
#${POPUP} .mes-popup-panel[hidden]{display:none}
#${POPUP} .mes-popup-panel-head{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:12px;padding-bottom:9px;border-bottom:1px solid color-mix(in srgb,var(--border,#444) 72%,transparent)}
#${POPUP} .mes-popup-panel-head button{min-height:30px;padding:5px 9px;border:0;background:transparent;opacity:.68}
#${POPUP} .mes-popup-edit-form{display:grid;gap:10px}
#${POPUP} .mes-popup-edit-form label{display:grid;gap:4px;font-weight:650}
#${POPUP} .mes-popup-edit-form select,#${POPUP} .mes-popup-edit-form textarea{width:100%;padding:8px;border:1px solid var(--border,#555);border-radius:8px;background:var(--background,#171717);color:inherit;font:inherit;line-height:1.5}
#${POPUP} .mes-popup-edit-form textarea{min-height:72px;resize:vertical}
#${POPUP} .mes-popup-edit-form [name="popup-edit-text"]{min-height:88px}
#${POPUP} .mes-popup-edit-analysis{border-top:1px solid var(--border,#444);padding-top:4px}
#${POPUP} .mes-popup-edit-analysis summary{min-height:38px;display:flex;align-items:center;cursor:pointer;list-style:none;font-weight:700}
#${POPUP} .mes-popup-edit-analysis summary::-webkit-details-marker{display:none}
#${POPUP} .mes-popup-edit-analysis-body{display:grid;gap:10px;padding-top:6px}
#${POPUP} .mes-popup-edit-error{min-height:17px;color:#e86a6f;font-size:11px}
#${POPUP} .mes-popup-edit-actions{display:grid;grid-template-columns:1fr 1.4fr;gap:8px;padding-top:4px}
#${POPUP} .mes-popup-edit-actions button{min-height:40px}
#${POPUP} .mes-popup-edit-actions [type="submit"]{background:var(--primary,#7c9cff);color:var(--primary-foreground,#101010);font-weight:750}
#${ROOT}{display:flex;flex-direction:column;overflow:hidden}
#${ROOT} .mes-root-view{min-height:0;flex:1 1 auto;padding-bottom:14px;max-height:none}

@media (max-width:640px){
#${ROOT},#${ROOT}:has([data-root-view="vocabulary"]:not([hidden])){left:6px;right:6px;top:calc(12px + env(safe-area-inset-top));bottom:auto;width:auto;min-width:0;max-width:none;max-height:74vh;max-height:min(74dvh,calc(100dvh - 36px - env(safe-area-inset-top) - env(safe-area-inset-bottom)));font-size:13px}
#${ROOT} .mes-root-view{max-height:none;padding:10px 10px max(16px,env(safe-area-inset-bottom))}
#${POPUP}{width:min(360px,calc(100vw - 28px));max-height:min(58vh,460px);max-height:min(58dvh,460px);font-size:12px}
#${POPUP}[data-root-linked="true"]{left:6px!important;right:6px!important;top:calc(12px + env(safe-area-inset-top))!important;bottom:auto!important;width:auto;max-width:none}
#${ROOT} [data-vocab-search]{font-size:12px;padding:7px 8px}
#${ROOT} [data-root-view="settings"]{font-size:11px}
#${ROOT} [data-root-view="settings"] select,
#${ROOT} [data-root-view="settings"] input{font-size:12px;padding:6px}
#${ROOT} .mes-prompt-settings textarea{font-size:10.5px;line-height:1.42;padding:7px;max-width:100%}
#${ROOT} .mes-root-head,#${POPUP} .mes-head{height:44px;min-height:44px;padding:4px 8px}
#${POPUP} .mes-selected-row{padding:6px 8px 6px 10px}
#${POPUP} .mes-selected{font-size:13px;line-height:1.4}
#${POPUP} .mes-selected-actions>button{min-width:34px;min-height:34px}
#${POPUP} .mes-regenerate{min-width:34px;min-height:34px}
#${ROOT} .mes-root-head button,#${POPUP} .mes-popup-head-actions button{width:34px;height:34px;min-width:34px;min-height:34px}
#${ROOT} .mes-vocab-filters{gap:22px}
#${ROOT} .mes-vocab-filters button{min-height:38px;padding-bottom:9px;font-size:13px}
#${ROOT} .mes-vocab-count{padding-bottom:10px;font-size:11px}
#${ROOT} .mes-list{height:auto;max-height:none;overflow:visible;align-content:start}
#${ROOT} .mes-card{padding:9px 10px 3px}
#${ROOT} .mes-card-buttons{gap:4px;margin-top:2px}
#${ROOT} .mes-card-buttons button{width:44px;height:44px;min-width:44px;font-size:18px}
#${ROOT} .mes-vocab-bulk-actions button{min-height:44px}
#${ROOT} .mes-card-menu button{min-height:44px;font-size:14px}
#${POPUP} .mes-popup-edit-form select,#${POPUP} .mes-popup-edit-form textarea{font-size:16px}
#${POPUP} .mes-popup-edit-actions button{min-height:48px}
}
  `);

  const toggle = addElement(document.body, 'button', {
    id: TOGGLE, type:'button', title:'English Study', 'aria-label':'English Study', textContent:'📚'
  });
  const selectionAction = addElement(document.body, 'button', {
    id: SELECTION_ACTION, type:'button', hidden:'', title:'선택한 텍스트 분석',
    'aria-label':'선택한 텍스트 분석', 'data-marinara-selection-action':'english-study-simple', textContent:'분석'
  });
  const root = addElement(document.body, 'section', {
    id: ROOT, hidden:'', role:'dialog', 'aria-label':'English Study 설정'
  });
  const popup = addElement(document.body, 'section', {
    id: POPUP, hidden:'', role:'dialog', 'aria-label':'문장 보기 학습'
  });

  root.innerHTML = `
    <div class="mes-root-head">
      <span data-root-title>단어장</span>
      <div class="mes-root-head-actions">
        <button data-act="toggle-settings" title="설정" aria-label="설정">⚙</button>
        <button data-act="close">×</button>
      </div>
    </div>

    <div class="mes-storage-error" data-storage-error role="alert" hidden></div>

    <div class="mes-root-view" data-root-view="vocabulary">
      <div class="mes-vocab-tools">
        <input type="search" data-vocab-search placeholder="단어·문장·번역 검색">
        <div class="mes-vocab-filter-row">
          <div class="mes-vocab-filters" role="tablist" aria-label="단어장 필터">
            <button type="button" data-vocab-filter="all" data-active="true" role="tab">전체</button>
            <button type="button" data-vocab-filter="word" role="tab">단어</button>
            <button type="button" data-vocab-filter="sentence" role="tab">문장</button>
            <button type="button" data-vocab-filter="favorite" role="tab" aria-label="즐겨찾기">★</button>
          </div>
          <div class="mes-vocab-count-actions">
            <span class="mes-vocab-count" data-count></span>
            <button type="button" data-act="toggle-vocab-selection" aria-pressed="false">선택</button>
          </div>
        </div>
        <div class="mes-vocab-bulk" data-vocab-bulk hidden>
          <div class="mes-vocab-bulk-head">
            <label class="mes-vocab-select-all"><input type="checkbox" data-vocab-select-all>현재 목록 전체</label>
            <span class="mes-vocab-selected-count" data-vocab-selected-count>0개 선택</span>
          </div>
          <div class="mes-vocab-bulk-actions">
            <button type="button" data-bulk-vocab="favorite">즐겨찾기</button>
            <button type="button" data-bulk-vocab="delete">삭제</button>
          </div>
        </div>
      </div>
      <div class="mes-list" data-list></div>
    </div>

    <div class="mes-root-view" data-root-view="settings" hidden>
      <label>텍스트 선택 방식
        <select name="mode">
          <option value="auto">PC 드래그 / 모바일 길게</option>
          <option value="auto-click">PC 드래그 / 모바일 더블클릭</option>
          <option value="selection">드래그</option>
          <option value="click">클릭</option>
          <option value="doubleclick">두 번 클릭</option>
        </select>
      </label>
      <label>클릭 분석 범위
        <select name="clickScope">
          <option value="word">단어</option>
          <option value="sentence">문장</option>
          <option value="paragraph">단락</option>
        </select>
      </label>
      <label>AI 연결
        <select name="connectionId">
          <option value="">연결을 불러오는 중…</option>
        </select>
      </label>
      <button type="button" data-act="refresh-connections">연결 목록 새로고침</button>
      <div data-connection-status class="mes-muted" style="display:none;white-space:pre-wrap;margin-top:8px"></div>

      <details class="mes-settings-section mes-prompt-settings">
        <summary>
          <span>AI 프롬프트</span>
          <span class="mes-summary-chevron">⌄</span>
        </summary>
        <div class="mes-prompt-settings-body">
          <div class="mes-settings-title-row">
            <div class="mes-muted">공통 규칙은 모든 분석 프롬프트 앞에 자동으로 적용됩니다.</div>
            <button type="button" data-act="reset-prompts">기본값 복원</button>
          </div>
          <label>공통 출력 규칙
            <textarea name="prompt-common" rows="6"></textarea>
          </label>
          <label>번역
            <textarea name="prompt-translate" rows="5"></textarea>
          </label>
          <label>문법
            <textarea name="prompt-grammar" rows="5"></textarea>
          </label>
          <label>뉘앙스
            <textarea name="prompt-nuance" rows="5"></textarea>
          </label>
          <label>유사 표현
            <textarea name="prompt-similar" rows="5"></textarea>
          </label>
          <label>난이도
            <textarea name="prompt-difficulty" rows="5"></textarea>
          </label>
        </div>
      </details>

      <div class="mes-settings-section">
        <b>데이터 관리</b>
        <div class="mes-vocab-actions">
          <button data-act="export-data">전체 백업</button>
          <button data-act="import-data">백업 복원</button>
          <button data-act="clear">단어장 전체 삭제</button>
        </div>
        <div class="mes-muted">설정과 단어장을 JSON으로 백업합니다. 최근 분석 기록은 임시 데이터이므로 포함하지 않습니다.</div>
      </div>
      <input type="file" data-import-file accept="application/json,.json" hidden>
    </div>`;

  popup.innerHTML = `
    <div class="mes-head">
      <span data-title>문장 보기</span>
      <div class="mes-popup-head-actions">
        <button data-act="back-to-root" title="단어장으로 돌아가기" aria-label="단어장으로 돌아가기" hidden>←</button>
        <button data-act="open-settings" title="설정 열기" aria-label="설정 열기">⚙</button>
        <button data-act="center-popup" title="분석창 중앙 배치" aria-label="분석창 중앙 배치">◎</button>
        <button data-act="close">×</button>
      </div>
    </div>
    <div class="mes-selected-row" data-analysis-part>
      <div class="mes-selected" data-selected></div>
      <div class="mes-selected-actions">
        <button data-act="copy" title="원문 복사" aria-label="원문 복사">⧉</button>
        <button data-act="save" title="단어장에 저장" aria-label="단어장에 저장">☆</button>
        <button class="mes-history-toggle" data-act="toggle-history" aria-expanded="false" title="분석 기록" aria-label="분석 기록">
          <span data-history-label>0</span><span data-history-chevron>⌄</span>
        </button>
      </div>
    </div>
    <div class="mes-history-panel" data-history-panel data-analysis-part hidden>
      <select data-history aria-label="최근 분석"></select>
      <button data-act="delete-history" title="현재 기록 삭제" aria-label="현재 기록 삭제">삭제</button>
    </div>
    <div class="mes-tabs-row" data-analysis-part>
      <div class="mes-tabs">
        <button data-task="combined">AI 해설</button>
        <button data-task="translate">번역</button>
        <button data-task="grammar">문법</button>
        <button data-task="nuance">뉘앙스</button>
        <button data-task="similar">유사 표현</button>
        <button data-task="difficulty">난이도</button>
      </div>
      <div class="mes-tabs-actions">
        <button data-act="edit-saved-card" title="카드 편집" aria-label="카드 편집">✎</button>
        <button class="mes-regenerate" data-act="regenerate" title="다시 생성" aria-label="다시 생성">↻</button>
      </div>
    </div>
    <div class="mes-result mes-muted" data-result data-analysis-part>기능을 선택하세요.</div>
    <div class="mes-combined" data-combined data-analysis-part hidden></div>
    <div class="mes-popup-panel" data-popup-card-edit hidden>
      <div class="mes-popup-panel-head"><b>카드 편집</b><button type="button" data-act="cancel-popup-card-edit">분석으로 돌아가기</button></div>
      <form class="mes-popup-edit-form" data-popup-card-edit-form>
        <label>카드 유형
          <select name="popup-edit-kind"><option value="word">단어</option><option value="sentence">문장</option></select>
        </label>
        <label>영어 원문<textarea name="popup-edit-text" required></textarea></label>
        <label>번역<textarea name="popup-edit-translate"></textarea></label>
        <details class="mes-popup-edit-analysis">
          <summary>AI 분석 내용</summary>
          <div class="mes-popup-edit-analysis-body">
            <label>문법<textarea name="popup-edit-grammar"></textarea></label>
            <label>뉘앙스<textarea name="popup-edit-nuance"></textarea></label>
            <label>유사 표현<textarea name="popup-edit-similar"></textarea></label>
            <label>난이도<textarea name="popup-edit-difficulty"></textarea></label>
          </div>
        </details>
        <div class="mes-popup-edit-error" data-popup-edit-error role="alert"></div>
        <div class="mes-popup-edit-actions">
          <button type="button" data-act="cancel-popup-card-edit">취소</button>
          <button type="submit">저장</button>
        </div>
      </form>
    </div>`;

  root.insertAdjacentHTML('beforeend', `
    <div class="mes-card-menu" data-card-menu popover="auto" role="menu" aria-label="카드 더보기">
      <button type="button" role="menuitem" data-menu-card-action="edit">편집</button>
      <button type="button" role="menuitem" data-menu-card-action="remove">삭제</button>
    </div>`);

  const clampPosition = (left, top, width, height) => ({
    left: Math.max(6, Math.min(left, window.innerWidth - width - 6)),
    top: Math.max(6, Math.min(top, window.innerHeight - height - 6))
  });

  const linkedPopupPositionKey = () => popupReturnToRoot ? 'panelPosition' : 'popupPosition';

  const syncPopupReturnControl = () => {
    const button = popup.querySelector('[data-act="back-to-root"]');
    if (button) button.hidden = !popupReturnToRoot;
    popup.dataset.rootLinked = popupReturnToRoot ? 'true' : 'false';
  };

  const applyStoredPositions = () => {
    const compactLayout = window.innerWidth <= 640;
    if (cfg.togglePosition && Number.isFinite(cfg.togglePosition.left) && Number.isFinite(cfg.togglePosition.top)) {
      const pos = clampPosition(cfg.togglePosition.left, cfg.togglePosition.top, toggle.offsetWidth || 44, toggle.offsetHeight || 44);
      toggle.style.left = `${pos.left}px`;
      toggle.style.top = `${pos.top}px`;
      toggle.style.right = 'auto';
      toggle.style.bottom = 'auto';
    }
    if (compactLayout) {
      root.style.left = '';
      root.style.top = '';
      root.style.right = '';
      root.style.bottom = '';
      popup.style.left = '';
      popup.style.top = '';
      popup.style.right = '';
      popup.style.bottom = '';
    } else if (cfg.panelPosition && Number.isFinite(cfg.panelPosition.left) && Number.isFinite(cfg.panelPosition.top)) {
      const pos = clampPosition(cfg.panelPosition.left, cfg.panelPosition.top, root.offsetWidth || 340, root.offsetHeight || 300);
      root.style.left = `${pos.left}px`;
      root.style.top = `${pos.top}px`;
      root.style.right = 'auto';
      root.style.bottom = 'auto';
    }
    const popupPosition = cfg[linkedPopupPositionKey()];
    if (!compactLayout && popupPosition && Number.isFinite(popupPosition.left) && Number.isFinite(popupPosition.top)) {
      const pos = clampPosition(
        popupPosition.left,
        popupPosition.top,
        popup.offsetWidth || Math.min(390, innerWidth - 20),
        popup.offsetHeight || Math.min(560, innerHeight - 20)
      );
      popup.style.left = `${pos.left}px`;
      popup.style.top = `${pos.top}px`;
      popup.style.right = 'auto';
      popup.style.bottom = 'auto';
    }
  };

  const setStorageError = message => {
    const node = root.querySelector('[data-storage-error]');
    if (!node) return;
    node.textContent = String(message || '');
    node.hidden = !message;
  };

  const saveCfg = async () => {
    if (!storageReady) {
      setStorageError('서버 학습 데이터를 불러오지 못해 변경사항을 저장하지 않았습니다. 연결을 확인한 뒤 화면을 다시 열어 주세요.');
      return false;
    }
    try {
      await storage.patch({ config: cfg });
      setStorageError('');
      return true;
    } catch (error) {
      setStorageError(`서버 저장 실패: ${error?.message || error}. 기존 서버 데이터는 변경하지 않았습니다.`);
      return false;
    }
  };

  const makeDraggable = (element, handle, configKey, { suppressClick = false } = {}) => {
    let drag = null;
    let moved = false;

    handle.addEventListener('pointerdown', event => {
      if (window.innerWidth <= 640 || isCoarse()) return;
      if (event.button !== undefined && event.button !== 0) return;
      if (event.target.closest?.('button,select,input,textarea,a')) return;
      const rect = element.getBoundingClientRect();
      drag = {
        pointerId: event.pointerId,
        offsetX: event.clientX - rect.left,
        offsetY: event.clientY - rect.top,
        startX: event.clientX,
        startY: event.clientY
      };
      moved = false;
      handle.setPointerCapture?.(event.pointerId);
      event.preventDefault();
    });

    handle.addEventListener('pointermove', event => {
      if (!drag || event.pointerId !== drag.pointerId) return;
      if (Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) > 4) moved = true;
      const next = clampPosition(
        event.clientX - drag.offsetX,
        event.clientY - drag.offsetY,
        element.offsetWidth,
        element.offsetHeight
      );
      element.style.left = `${next.left}px`;
      element.style.top = `${next.top}px`;
      element.style.right = 'auto';
      element.style.bottom = 'auto';
      event.preventDefault();
    });

    const finish = async event => {
      if (!drag || event.pointerId !== drag.pointerId) return;
      handle.releasePointerCapture?.(event.pointerId);
      drag = null;
      if (!moved) return;
      const rect = element.getBoundingClientRect();
      const resolvedConfigKey = typeof configKey === 'function' ? configKey() : configKey;
      cfg[resolvedConfigKey] = { left: Math.round(rect.left), top: Math.round(rect.top) };
      await saveCfg();
      if (suppressClick) element.dataset.dragged = '1';
    };

    handle.addEventListener('pointerup', finish);
    handle.addEventListener('pointercancel', finish);
  };

  let rootView = 'vocabulary';
  let historyOpen = false;

  const renderHistoryPanel = () => {
    const panel = popup.querySelector('[data-history-panel]');
    const toggleButton = popup.querySelector('[data-act="toggle-history"]');
    const chevron = popup.querySelector('[data-history-chevron]');
    const label = popup.querySelector('[data-history-label]');
    if (!panel || !toggleButton) return;
    panel.hidden = !historyOpen;
    toggleButton.setAttribute('aria-expanded', historyOpen ? 'true' : 'false');
    if (chevron) chevron.textContent = historyOpen ? '⌃' : '⌄';
    if (label) {
      const count = Array.isArray(cfg.analysisHistory) ? cfg.analysisHistory.length : 0;
      label.textContent = String(count);
    }
  };

  const renderRootView = () => {
    const vocabularyView = root.querySelector('[data-root-view="vocabulary"]');
    const settingsView = root.querySelector('[data-root-view="settings"]');
    const title = root.querySelector('[data-root-title]');
    const button = root.querySelector('[data-act="toggle-settings"]');
    const inSettings = rootView === 'settings';

    vocabularyView.hidden = inSettings;
    settingsView.hidden = !inSettings;
    title.textContent = inSettings ? '설정' : '단어장';
    button.textContent = inSettings ? '←' : '⚙';
    button.title = inSettings ? '단어장으로 돌아가기' : '설정';
    button.setAttribute('aria-label', button.title);
  };

  const vocabularyKey = item =>
    `${item?.kind || 'word'}::${normalizeSelectionText(item?.text).toLocaleLowerCase()}`;

  const normalizeVocabulary = items => {
    const merged = [];
    for (const raw of Array.isArray(items) ? items : []) {
      const text = normalizeSelectionText(raw?.text);
      if (!text) continue;
      const item = {
        id: raw.id || `vocab-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        text,
        kind: raw.kind || 'word',
        savedAt: raw.savedAt || raw.createdAt || new Date().toISOString(),
        favorite: Boolean(raw.favorite),
        results: raw.results && typeof raw.results === 'object' ? raw.results : {}
      };
      const existing = merged.find(entry => vocabularyKey(entry) === vocabularyKey(item));
      if (!existing) merged.push(item);
      else {
        existing.results = { ...(existing.results || {}), ...(item.results || {}) };
        existing.favorite = existing.favorite || item.favorite;
        existing.savedAt = existing.savedAt || item.savedAt;
      }
    }
    return merged;
  };

  const filteredVocabulary = () => {
    const query = String(root.querySelector('[data-vocab-search]')?.value || '')
      .trim().toLocaleLowerCase();
    const filter = vocabularyFilter || 'all';

    return cfg.vocabulary.filter(item => {
      if (filter === 'favorite' && !item.favorite) return false;
      if (!['all', 'favorite'].includes(filter) && item.kind !== filter) return false;
      if (!query) return true;
      const haystack = [
        item.text,
        item.results?.translate,
        item.results?.grammar,
        item.results?.nuance,
        item.results?.similar,
        item.results?.difficulty
      ].filter(Boolean).join('\n').toLocaleLowerCase();
      return haystack.includes(query);
    });
  };

  const closeCardMenu = () => {
    const menu = root.querySelector('[data-card-menu]');
    if (menu?.matches?.(':popover-open')) menu.hidePopover();
    activeMenuCardId = '';
  };

  const openCardMenu = (trigger, item) => {
    const menu = root.querySelector('[data-card-menu]');
    if (!menu || !trigger || !item) return;
    if (activeMenuCardId === item.id && menu.matches?.(':popover-open')) {
      closeCardMenu();
      return;
    }
    closeCardMenu();
    activeMenuCardId = item.id;
    const rect = trigger.getBoundingClientRect();
    const menuWidth = 150;
    menu.style.visibility = 'hidden';
    menu.showPopover();
    const measuredHeight = Math.min(menu.scrollHeight || 92, window.innerHeight - 16);
    const left = Math.max(8, Math.min(rect.right - menuWidth, window.innerWidth - menuWidth - 8));
    const top = rect.bottom + measuredHeight <= window.innerHeight - 8
      ? rect.bottom + 4
      : Math.max(8, rect.top - measuredHeight - 4);
    menu.style.left = `${Math.round(left)}px`;
    menu.style.top = `${Math.round(top)}px`;
    menu.style.right = 'auto';
    menu.style.bottom = 'auto';
    menu.style.height = 'auto';
    menu.style.visibility = '';
    menu.querySelector('button')?.focus();
  };

  const renderVocabularySelectionState = visibleItems => {
    const validIds = new Set(cfg.vocabulary.map(item => item.id));
    for (const id of selectedVocabularyIds) {
      if (!validIds.has(id)) selectedVocabularyIds.delete(id);
    }
    const selectedItems = cfg.vocabulary.filter(item => selectedVocabularyIds.has(item.id));
    const visibleIds = visibleItems.map(item => item.id);
    const selectedVisibleCount = visibleIds.filter(id => selectedVocabularyIds.has(id)).length;
    const toggleButton = root.querySelector('[data-act="toggle-vocab-selection"]');
    const bulk = root.querySelector('[data-vocab-bulk]');
    const selectAll = root.querySelector('[data-vocab-select-all]');
    toggleButton.textContent = vocabularySelectionMode ? '선택 종료' : '선택';
    toggleButton.setAttribute('aria-pressed', vocabularySelectionMode ? 'true' : 'false');
    bulk.hidden = !vocabularySelectionMode;
    root.querySelector('[data-vocab-selected-count]').textContent = `${selectedItems.length}개 선택`;
    selectAll.checked = Boolean(visibleIds.length && selectedVisibleCount === visibleIds.length);
    selectAll.indeterminate = Boolean(selectedVisibleCount && selectedVisibleCount < visibleIds.length);
    root.querySelectorAll('[data-bulk-vocab]').forEach(button => {
      button.disabled = selectedItems.length === 0;
    });
    const favoriteButton = root.querySelector('[data-bulk-vocab="favorite"]');
    favoriteButton.textContent = selectedItems.length && selectedItems.every(item => item.favorite)
      ? '즐겨찾기 해제'
      : '즐겨찾기';
  };

  const renderList = () => {
    const list = root.querySelector('[data-list]');
    const count = root.querySelector('[data-count]');
    const items = filteredVocabulary().slice().reverse();
    count.textContent = String(items.length);

    root.querySelectorAll('[data-vocab-filter]').forEach(button => {
      const active = button.dataset.vocabFilter === vocabularyFilter;
      button.dataset.active = active ? 'true' : 'false';
      button.setAttribute('aria-selected', active ? 'true' : 'false');
    });

    renderVocabularySelectionState(items);

    list.innerHTML = items.length
      ? items.map(item => {
          const translation = item.results?.translate || '';
          const selected = selectedVocabularyIds.has(item.id);
          const itemAction = vocabularySelectionMode
            ? `data-toggle-vocab-selection="${esc(item.id)}"`
            : `data-open-vocab="${esc(item.id)}"`;
          return `<div class="mes-card" data-vocab-id="${esc(item.id)}" data-selection-mode="${vocabularySelectionMode ? 'true' : 'false'}" data-selected="${selected ? 'true' : 'false'}">
            ${vocabularySelectionMode ? `<label class="mes-card-select" aria-label="${esc(item.text)} 선택"><input type="checkbox" data-select-vocab="${esc(item.id)}"${selected ? ' checked' : ''}></label>` : ''}
            <div class="mes-card-text" ${itemAction}>${esc(item.text)}</div>
            ${translation ? `<div class="mes-card-preview">${esc(translation)}</div>` : ''}
            <div class="mes-card-footer">
              <div class="mes-card-buttons" aria-label="항목 작업">
                <button data-open-vocab="${esc(item.id)}" title="${item.kind === 'word' ? '단어 보기' : '문장 보기'}" aria-label="${item.kind === 'word' ? '단어 보기' : '문장 보기'}">ⓘ</button>
                <button data-favorite-vocab="${esc(item.id)}" data-active="${item.favorite ? 'true' : 'false'}" title="${item.favorite ? '즐겨찾기 해제' : '즐겨찾기'}" aria-label="${item.favorite ? '즐겨찾기 해제' : '즐겨찾기'}">${item.favorite ? '★' : '☆'}</button>
                <button data-copy-vocab="${esc(item.id)}" title="복사" aria-label="복사">⧉</button>
                <button data-more-vocab="${esc(item.id)}" title="더보기" aria-label="카드 작업 더보기" aria-haspopup="menu">⋯</button>
              </div>
            </div>
          </div>`;
        }).join('')
      : '<div class="mes-muted">조건에 맞는 저장 항목이 없습니다.</div>';
  };

  const toggleVocabularySelection = id => {
    if (!id) return;
    if (selectedVocabularyIds.has(id)) selectedVocabularyIds.delete(id);
    else selectedVocabularyIds.add(id);
    renderList();
  };

  const completeBulkVocabularyAction = async () => {
    await saveCfg();
    renderList();
    renderSaveState();
  };

  const historyLabel = item => {
    const text = String(item?.text || '').replace(/\s+/g, ' ').trim();
    return text.length > 54 ? `${text.slice(0, 54)}…` : text;
  };

  const getActiveAnalysis = () =>
    cfg.analysisHistory.find(item => item.id === cfg.activeAnalysisId) || null;

  const getVocabularyForAnalysis = () => {
    const analysis = getActiveAnalysis();
    if (!analysis) return null;
    return cfg.vocabulary.find(item => vocabularyKey(item) === vocabularyKey(analysis)) || null;
  };

  const renderHistorySelect = () => {
    const select = popup.querySelector('[data-history]');
    const items = Array.isArray(cfg.analysisHistory) ? cfg.analysisHistory : [];
    select.innerHTML = items.length
      ? items.map(item => `<option value="${esc(item.id)}"${item.id === cfg.activeAnalysisId ? ' selected' : ''}>${esc(historyLabel(item))}</option>`).join('')
      : '<option value="">최근 분석 없음</option>';
  };

  const renderSaveState = () => {
    const button = popup.querySelector('[data-act="save"]');
    const editButton = popup.querySelector('[data-act="edit-saved-card"]');
    const item = getActiveAnalysis();
    if (!button) return;
    const saved = Boolean(item && normalizeVocabulary(cfg.vocabulary)
      .some(entry => vocabularyKey(entry) === vocabularyKey(item)));
    button.textContent = saved ? '★' : '☆';
    button.dataset.saved = saved ? 'true' : 'false';
    button.title = saved ? '단어장에 저장됨' : '단어장에 저장';
    button.setAttribute('aria-label', button.title);
    if (editButton) editButton.hidden = !saved;
  };

  const showPopupAnalysisContent = () => {
    popup.querySelectorAll('[data-analysis-part]').forEach(node => {
      if (node.matches('[data-history-panel]')) return;
      node.hidden = false;
    });
    popup.querySelector('[data-popup-card-edit]').hidden = true;
    activePopupEditId = '';
    popupEditBaseline = '';
  };

  const popupEditSnapshot = () => {
    const form = popup.querySelector('[data-popup-card-edit-form]');
    if (!form) return '';
    return JSON.stringify({
      kind: form.elements['popup-edit-kind'].value,
      text: form.elements['popup-edit-text'].value,
      translate: form.elements['popup-edit-translate'].value,
      grammar: form.elements['popup-edit-grammar'].value,
      nuance: form.elements['popup-edit-nuance'].value,
      similar: form.elements['popup-edit-similar'].value,
      difficulty: form.elements['popup-edit-difficulty'].value
    });
  };

  const closePopupCardEdit = (force = false) => {
    const panel = popup.querySelector('[data-popup-card-edit]');
    if (!panel || panel.hidden) return true;
    if (!force && popupEditBaseline && popupEditSnapshot() !== popupEditBaseline) {
      if (!confirm('저장하지 않은 변경사항을 버릴까요?')) return false;
    }
    showPopupAnalysisContent();
    renderAnalysis();
    return true;
  };

  const renderPopupCardEdit = item => {
    if (!item) return;
    activePopupEditId = item.id;
    const form = popup.querySelector('[data-popup-card-edit-form]');
    form.elements['popup-edit-kind'].value = item.kind === 'word' ? 'word' : 'sentence';
    form.elements['popup-edit-text'].value = item.text || '';
    form.elements['popup-edit-translate'].value = item.results?.translate || '';
    form.elements['popup-edit-grammar'].value = item.results?.grammar || '';
    form.elements['popup-edit-nuance'].value = item.results?.nuance || '';
    form.elements['popup-edit-similar'].value = item.results?.similar || '';
    form.elements['popup-edit-difficulty'].value = item.results?.difficulty || '';
    popup.querySelector('[data-popup-edit-error]').textContent = '';
    popup.querySelectorAll('[data-analysis-part]').forEach(node => { node.hidden = true; });
    popup.querySelector('[data-popup-card-edit]').hidden = false;
    popupEditBaseline = popupEditSnapshot();
    setTimeout(() => form.elements['popup-edit-text'].focus(), 0);
  };

  const renderAnalysis = () => {
    const item = getActiveAnalysis();
    const result = popup.querySelector('[data-result]');
    const combined = popup.querySelector('[data-combined]');
    const selected = popup.querySelector('[data-selected]');
    const title = popup.querySelector('[data-title]');

    renderHistorySelect();
    renderHistoryPanel();
    renderSaveState();
    popup.querySelectorAll('[data-task]').forEach(button => {
      button.dataset.active = button.dataset.task === activeTask ? 'true' : 'false';
    });

    if (!item) {
      selectedText = '';
      selected.textContent = '';
      title.textContent = '문장 보기';
      result.hidden = false;
      combined.hidden = true;
      result.textContent = '분석할 문장을 선택하세요.';
      result.classList.add('mes-muted');
      return;
    }

    selectedText = item.text;
    selectedKind = item.kind || 'sentence';
    title.textContent = selectedKind === 'word' ? '단어 보기' : '문장 보기';
    selected.textContent = selectedText;

    if (activeTask === 'combined') {
      const sections = [
        ['translate', '번역'],
        ['grammar', '문법'],
        ['nuance', '뉘앙스'],
        ['similar', '유사 표현'],
        ['difficulty', '난이도']
      ];

      combined.innerHTML = sections.map(([key, label]) => {
        const value = item.results?.[key];
        return `<section class="mes-combined-section">
          <div class="mes-combined-title">${esc(label)}</div>
          <div class="mes-combined-body${value ? '' : ' mes-combined-empty'}">${esc(value || '아직 생성하지 않았습니다.')}</div>
        </section>`;
      }).join('');

      result.hidden = true;
      combined.hidden = false;
      return;
    }

    combined.hidden = true;
    result.hidden = false;
    const value = item.results?.[activeTask];
    result.textContent = value || '이 기능은 아직 실행하지 않았습니다.';
    result.classList.toggle('mes-muted', !value);
  };
  const activateAnalysis = id => {
    if (!cfg.analysisHistory.some(item => item.id === id)) return;
    cfg.activeAnalysisId = id;
    renderAnalysis();
  };

  const createOrActivateAnalysis = (text, kind) => {
    const normalized = normalizeSelectionText(text);
    const key = analysisKey(normalized, kind);
    let item = cfg.analysisHistory.find(entry =>
      analysisKey(entry.text, entry.kind) === key
    );

    if (!item) {
      item = {
        id: `analysis-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        text: normalized,
        kind,
        analysisKey: key,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        results: {}
      };
      cfg.analysisHistory.unshift(item);
      cfg.analysisHistory = cfg.analysisHistory.slice(0, 10);
    } else {
      item.text = normalized;
      item.kind = kind;
      item.analysisKey = key;
      item.updatedAt = new Date().toISOString();
      cfg.analysisHistory = [item, ...cfg.analysisHistory.filter(entry => entry.id !== item.id)].slice(0, 10);
    }

    cfg.activeAnalysisId = item.id;
    saveCfg();
    return item;
  };

  const centerPopup = async (persist = true) => {
    if (isCoarse()) return;
    const width = popup.offsetWidth || Math.min(390, innerWidth - 20);
    const height = popup.offsetHeight || Math.min(560, innerHeight - 20);
    const pos = clampPosition(
      Math.round((innerWidth - width) / 2),
      Math.round((innerHeight - height) / 2),
      width,
      height
    );
    popup.style.left = `${pos.left}px`;
    popup.style.top = `${pos.top}px`;
    popup.style.right = 'auto';
    popup.style.bottom = 'auto';
    if (persist) {
      cfg[linkedPopupPositionKey()] = pos;
      await saveCfg();
    }
  };

  const placePopup = (x, y, { forceNearSelection = false } = {}) => {
    const storedPosition = cfg[linkedPopupPositionKey()];
    if (!forceNearSelection && storedPosition &&
        Number.isFinite(storedPosition.left) &&
        Number.isFinite(storedPosition.top)) {
      const width = popup.offsetWidth || Math.min(390, innerWidth - 20);
      const height = popup.offsetHeight || Math.min(560, innerHeight - 20);
      const pos = clampPosition(storedPosition.left, storedPosition.top, width, height);
      popup.style.left = `${pos.left}px`;
      popup.style.top = `${pos.top}px`;
      popup.style.right = 'auto';
      popup.style.bottom = 'auto';
      return;
    }

    const mobile = isCoarse();
    const width = popup.offsetWidth || Math.min(mobile ? 360 : 390, innerWidth - (mobile ? 28 : 20));
    const height = popup.offsetHeight || Math.min(mobile ? 500 : 560, innerHeight - 20);
    const initialX = mobile ? (innerWidth - width) / 2 : x;
    const initialY = mobile ? Math.max(12, innerHeight * 0.16) : y + 10;
    const pos = clampPosition(initialX, initialY, width, height);
    popup.style.left = `${pos.left}px`;
    popup.style.top = `${pos.top}px`;
    popup.style.right = 'auto';
    popup.style.bottom = 'auto';
  };

  const openPopup = (text, kind='sentence', x=innerWidth/2-180, y=innerHeight/3) => {
    text = normalizeSelectionText(text);
    if (!text) return;
    popupReturnToRoot = false;
    syncPopupReturnControl();
    createOrActivateAnalysis(text, kind);
    showPopupAnalysisContent();
    renderAnalysis();
    placePopup(x, y);
    popup.hidden = false;
  };

  const returnToRootPanel = () => {
    if (!popupReturnToRoot) return false;
    if (!closePopupCardEdit(false)) return true;
    popup.hidden = true;
    popupReturnToRoot = false;
    syncPopupReturnControl();
    root.hidden = false;
    rootView = 'vocabulary';
    renderRootView();
    renderList();
    applyStoredPositions();
    return true;
  };

  const closePopup = () => {
    if (returnToRootPanel()) return;
    if (!closePopupCardEdit(false)) return;
    popup.hidden = true;
  };

  let selectionPartners = [];
  const selectionPartnerStyles = new Map();

  const clearSelectionAction = () => {
    clearTimeout(selectionTimer);
    clearTimeout(selectionReconcileTimer);
    pendingSelection = null;
    selectionAction.hidden = true;
    selectionAction.dataset.combined = 'false';
    selectionAction.style.height = '';
    for (const partner of selectionPartners) {
      const original = selectionPartnerStyles.get(partner);
      partner.removeAttribute('data-mes-selection-partner');
      partner.removeAttribute('data-mes-selection-partner-position');
      if (original) {
        partner.style.left = original.left;
        partner.style.top = original.top;
      }
    }
    selectionPartners = [];
    selectionPartnerStyles.clear();
  };

  const visibleSelectionPartners = () => {
    const candidates = document.querySelectorAll(
      '.mqc-selection-button, [data-marinara-selection-action]:not([data-marinara-selection-action="english-study-simple"]), [class*="selection-action"], [class*="selection-button"]'
    );
    return [...new Set(candidates)].filter(element => {
      if (element === selectionAction || !element.matches?.('button,[role="button"],a')) return false;
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      const nearSelection = !pendingSelection || (
        Math.abs((rect.left + rect.width / 2) - pendingSelection.x) < 320 &&
        Math.abs((rect.top + rect.height / 2) - pendingSelection.y) < 180
      );
      return ['fixed', 'absolute'].includes(style.position) &&
        style.display !== 'none' && style.visibility !== 'hidden' &&
        rect.width > 0 && rect.width < 320 && rect.height > 0 && rect.height <= 80 && nearSelection;
    }).sort((a, b) => {
      const ar = a.getBoundingClientRect();
      const br = b.getBoundingClientRect();
      return Math.abs((ar.left + ar.width / 2) - pendingSelection.x) -
        Math.abs((br.left + br.width / 2) - pendingSelection.x);
    });
  };

  const positionSelectionAction = () => {
    if (!pendingSelection?.text) {
      clearSelectionAction();
      return;
    }
    for (const partner of selectionPartners) {
      partner.removeAttribute('data-mes-selection-partner');
      partner.removeAttribute('data-mes-selection-partner-position');
    }
    selectionPartners = visibleSelectionPartners();
    selectionAction.hidden = false;
    const ownWidth = selectionAction.offsetWidth || 70;
    const ownHeight = selectionAction.offsetHeight || 44;

    if (selectionPartners.length) {
      selectionPartners.forEach((partner, index) => {
        if (!selectionPartnerStyles.has(partner)) {
          selectionPartnerStyles.set(partner, { left: partner.style.left, top: partner.style.top });
        }
        partner.setAttribute('data-mes-selection-partner', 'true');
        partner.setAttribute('data-mes-selection-partner-position', index === 0 ? 'first' : 'middle');
      });
      const rects = selectionPartners.map(partner => partner.getBoundingClientRect());
      const groupHeight = Math.max(ownHeight, ...rects.map(rect => rect.height));
      const groupWidth = rects.reduce((sum, rect) => sum + rect.width, ownWidth) - selectionPartners.length;
      const anchor = rects[0];
      const groupLeft = Math.max(8, Math.min(anchor.left, innerWidth - groupWidth - 8));
      const groupTop = Math.max(8, Math.min(anchor.top, innerHeight - groupHeight - 8));
      let cursor = groupLeft;
      selectionPartners.forEach((partner, index) => {
        const rect = rects[index];
        partner.style.left = `${Math.round(cursor)}px`;
        partner.style.top = `${Math.round(groupTop + (groupHeight - rect.height) / 2)}px`;
        cursor += rect.width - 1;
      });
      selectionAction.dataset.combined = 'true';
      selectionAction.style.left = `${Math.round(cursor)}px`;
      selectionAction.style.top = `${Math.round(groupTop)}px`;
      selectionAction.style.height = `${Math.round(groupHeight)}px`;
      return;
    }

    selectionAction.dataset.combined = 'false';
    selectionAction.style.height = '';
    selectionAction.style.left = `${Math.max(8, Math.min((pendingSelection.x || innerWidth / 2) - ownWidth / 2, innerWidth - ownWidth - 8))}px`;
    selectionAction.style.top = `${Math.max(8, Math.min((pendingSelection.y || innerHeight / 3) + 8, innerHeight - ownHeight - 8))}px`;
  };

  const showSelectionAction = (picked, x, y, delay = 0) => {
    const text = normalizeSelectionText(picked?.text);
    if (!text) {
      clearSelectionAction();
      return;
    }
    pendingSelection = {
      text,
      kind: picked?.kind === 'word' ? 'word' : 'sentence',
      x: Number.isFinite(x) ? x : innerWidth / 2,
      y: Number.isFinite(y) ? y : innerHeight / 3
    };
    clearTimeout(selectionTimer);
    selectionTimer = setTimeout(() => {
      positionSelectionAction();
      selectionReconcileTimer = setTimeout(positionSelectionAction, 260);
    }, delay);
  };

  marinara.onCleanup(clearSelectionAction);

  function textAtPoint(x, y, scope) {
    let range = null;
    if (document.caretRangeFromPoint) range = document.caretRangeFromPoint(x, y);
    else if (document.caretPositionFromPoint) {
      const pos = document.caretPositionFromPoint(x, y);
      if (pos) { range = document.createRange(); range.setStart(pos.offsetNode, pos.offset); }
    }
    const node = range?.startContainer;
    if (!node || node.nodeType !== Node.TEXT_NODE) return null;
    const text = node.textContent || '';
    const offset = Math.min(range.startOffset || 0, text.length);
    if (scope === 'paragraph') return { text: node.parentElement?.innerText || text, kind:'sentence' };
    if (scope === 'word') {
      const re = /[A-Za-z][A-Za-z'’-]*/g;
      let m; while ((m = re.exec(text))) if (m.index <= offset && offset <= m.index + m[0].length) return { text:m[0], kind:'word' };
      return null;
    }
    const boundaries = /[^.!?…]+(?:[.!?…]+|$)/g;
    let m; while ((m = boundaries.exec(text))) if (m.index <= offset && offset <= m.index + m[0].length) return { text:m[0].trim(), kind:'sentence' };
    return { text:text.trim(), kind:'sentence' };
  }

  const captureSelection = () => {
    if (!cfg.enabled || effectiveMode() !== 'selection') return;
    const sel = window.getSelection();
    const text = normalizeSelectionText(sel?.toString());
    if (!text || sel.rangeCount < 1) {
      clearSelectionAction();
      return;
    }
    const range = sel.getRangeAt(0);
    const container = range.commonAncestorContainer.nodeType === Node.ELEMENT_NODE
      ? range.commonAncestorContainer
      : range.commonAncestorContainer.parentElement;
    if (!container || popup.contains(container) || root.contains(container)) return;
    const rect = range.getBoundingClientRect();
    pendingSelection = {
      text,
      kind: /\s/.test(text) ? 'sentence' : 'word',
      x: rect.left + Math.min(rect.width / 2, 180),
      y: rect.bottom
    };
  };

  const handleSelectionEnd = event => {
    if (!cfg.enabled || effectiveMode() !== 'selection') return;
    if (popup.contains(event.target) || root.contains(event.target) || toggle.contains(event.target) || selectionAction.contains(event.target)) return;
    clearTimeout(selectionTimer);
    captureSelection();
    selectionTimer = setTimeout(() => {
      captureSelection();
      if (!pendingSelection) return;
      showSelectionAction(
        pendingSelection,
        pendingSelection.x || event.clientX || innerWidth / 2,
        pendingSelection.y || event.clientY || innerHeight / 3,
        260
      );
    }, 30);
  };

  const handleClick = event => {
    if (!cfg.enabled || effectiveMode() !== 'click') return;
    if (popup.contains(event.target) || root.contains(event.target) || toggle.contains(event.target) || selectionAction.contains(event.target)) return;
    const picked = textAtPoint(event.clientX, event.clientY, cfg.clickScope);
    if (picked) showSelectionAction(picked, event.clientX, event.clientY);
  };

  const handleDoubleClick = event => {
    if (!cfg.enabled || effectiveMode() !== 'doubleclick') return;
    if (popup.contains(event.target) || root.contains(event.target) || toggle.contains(event.target) || selectionAction.contains(event.target)) return;
    const picked = textAtPoint(event.clientX, event.clientY, cfg.clickScope);
    if (picked) showSelectionAction(picked, event.clientX, event.clientY, 260);
  };

  const startLongPress = event => {
    if (!cfg.enabled || effectiveMode() !== 'longpress') return;
    if (popup.contains(event.target) || root.contains(event.target) || toggle.contains(event.target) || selectionAction.contains(event.target)) return;
    pressStart = { x:event.clientX, y:event.clientY };
    clearTimeout(pressTimer);
    pressTimer = setTimeout(() => {
      const picked = textAtPoint(pressStart.x, pressStart.y, cfg.clickScope === 'word' ? 'word' : 'sentence');
      if (picked) showSelectionAction(picked, pressStart.x, pressStart.y, 260);
    }, LONG_PRESS_MS);
  };
  const moveLongPress = event => {
    if (!pressStart) return;
    if (Math.hypot(event.clientX - pressStart.x, event.clientY - pressStart.y) > 10) {
      clearTimeout(pressTimer); pressStart = null;
    }
  };
  const endLongPress = () => { clearTimeout(pressTimer); pressStart = null; };

  const openSettingsPanel = () => {
    root.hidden = false;
    rootView = 'vocabulary';
    renderRootView();
    renderList();
    applyStoredPositions();
  };

  const closeSettingsPanel = () => {
    closeCardMenu();
    root.hidden = true;
  };

  const applyTogglePosition = () => {
    try {
      const saved = JSON.parse(localStorage.getItem(TOGGLE_POS_KEY) || 'null');
      if (!saved) return;
      const maxX = Math.max(0, innerWidth - toggle.offsetWidth);
      const maxY = Math.max(0, innerHeight - toggle.offsetHeight);
      toggle.style.left = Math.min(maxX, Math.max(0, (saved.x / 100) * innerWidth)) + 'px';
      toggle.style.top = Math.min(maxY, Math.max(0, (saved.y / 100) * innerHeight)) + 'px';
      toggle.style.right = 'auto';
      toggle.style.bottom = 'auto';
    } catch {}
  };

  let toggleDrag = null;

  on(toggle, 'pointerdown', event => {
    if (event.button !== 0 && event.pointerType === 'mouse') return;
    const rect = toggle.getBoundingClientRect();
    toggleDrag = {
      id: event.pointerId,
      sx: event.clientX,
      sy: event.clientY,
      ox: event.clientX - rect.left,
      oy: event.clientY - rect.top,
      moved: false
    };
    try { toggle.setPointerCapture(event.pointerId); } catch {}
  });

  on(toggle, 'pointermove', event => {
    if (!toggleDrag || event.pointerId !== toggleDrag.id) return;

    if (!toggleDrag.moved) {
      if (Math.hypot(event.clientX - toggleDrag.sx, event.clientY - toggleDrag.sy) < 6) return;
      toggleDrag.moved = true;
      toggle.dataset.dragging = 'true';
    }

    const maxX = Math.max(0, innerWidth - toggle.offsetWidth);
    const maxY = Math.max(0, innerHeight - toggle.offsetHeight);
    toggle.style.left = Math.min(maxX, Math.max(0, event.clientX - toggleDrag.ox)) + 'px';
    toggle.style.top = Math.min(maxY, Math.max(0, event.clientY - toggleDrag.oy)) + 'px';
    toggle.style.right = 'auto';
    toggle.style.bottom = 'auto';
  });

  const endToggleDrag = event => {
    if (!toggleDrag || event.pointerId !== toggleDrag.id) return;

    const completed = toggleDrag;
    toggleDrag = null;
    delete toggle.dataset.dragging;
    try { toggle.releasePointerCapture(event.pointerId); } catch {}

    if (!completed.moved) {
      root.hidden ? openSettingsPanel() : closeSettingsPanel();
      return;
    }

    const rect = toggle.getBoundingClientRect();
    try {
      localStorage.setItem(TOGGLE_POS_KEY, JSON.stringify({
        x: innerWidth ? (rect.left / innerWidth) * 100 : 0,
        y: innerHeight ? (rect.top / innerHeight) * 100 : 0
      }));
    } catch {}
  };

  on(toggle, 'pointerup', endToggleDrag);
  on(toggle, 'pointercancel', endToggleDrag);
  on(root.querySelector('[data-act="close"]'), 'click', closeSettingsPanel);
  on(popup.querySelector('[data-act="close"]'), 'click', closePopup);
  on(popup.querySelector('[data-act="back-to-root"]'), 'click', returnToRootPanel);
  on(selectionAction, 'pointerdown', event => {
    event.preventDefault();
  });
  on(selectionAction, 'click', event => {
    event.preventDefault();
    event.stopPropagation();
    const picked = pendingSelection ? { ...pendingSelection } : null;
    if (!picked?.text) return;
    pendingSelection = null;
    clearSelectionAction();
    openPopup(picked.text, picked.kind, picked.x, picked.y);
  });
  on(document, 'pointerdown', event => {
    if (selectionAction.contains(event.target)) return;
    clearSelectionAction();
  }, true);
  on(document, 'scroll', clearSelectionAction, true);
  on(window, 'blur', clearSelectionAction);
  on(document, 'visibilitychange', () => {
    if (document.hidden) clearSelectionAction();
  });
  on(document, 'selectionchange', captureSelection);
  on(document, 'pointerup', handleSelectionEnd);
  on(document, 'keyup', event => {
    if (event.key === 'Escape' && !selectionAction.hidden) {
      clearSelectionAction();
      return;
    }
    if (event.key === 'Escape' && !popup.hidden && !popup.querySelector('[data-popup-card-edit]').hidden) {
      closePopupCardEdit(false);
      return;
    }
    if (event.key === 'Shift' || event.key.startsWith('Arrow')) handleSelectionEnd(event);
  });
  on(document, 'click', handleClick);
  on(document, 'dblclick', handleDoubleClick);
  on(document, 'pointerdown', startLongPress);
  on(document, 'pointermove', moveLongPress);
  on(document, 'pointerup', endLongPress);
  on(document, 'pointercancel', endLongPress);

  root.querySelector('[name="mode"]').addEventListener('change', async e => { cfg.mode = e.target.value; await saveCfg(); });
  root.querySelector('[name="clickScope"]').addEventListener('change', async e => { cfg.clickScope = e.target.value; await saveCfg(); });

  const promptKeys = ['translate', 'grammar', 'nuance', 'similar', 'difficulty'];
  const fillPromptEditors = () => {
    const commonField = root.querySelector('[name="prompt-common"]');
    if (commonField) commonField.value = cfg.promptCommon || defaults.promptCommon;
    promptKeys.forEach(key => {
      const field = root.querySelector(`[name="prompt-${key}"]`);
      if (field) field.value = cfg.prompts?.[key] || defaults.prompts[key];
    });
  };
  root.querySelector('[name="prompt-common"]')?.addEventListener('change', async event => {
    cfg.promptCommon = event.target.value.trim() || defaults.promptCommon;
    event.target.value = cfg.promptCommon;
    await saveCfg();
  });
  promptKeys.forEach(key => {
    root.querySelector(`[name="prompt-${key}"]`)?.addEventListener('change', async event => {
      cfg.prompts = { ...defaults.prompts, ...(cfg.prompts || {}), [key]: event.target.value.trim() || defaults.prompts[key] };
      event.target.value = cfg.prompts[key];
      await saveCfg();
    });
  });
  root.querySelector('[data-act="reset-prompts"]').addEventListener('click', async () => {
    cfg.promptCommon = defaults.promptCommon;
    cfg.prompts = { ...defaults.prompts };
    fillPromptEditors();
    await saveCfg();
  });

  const connectionSelect = root.querySelector('[name="connectionId"]');
  const connectionStatus = root.querySelector('[data-connection-status]');
  const setConnectionStatus = message => {
    if (!connectionStatus) return;
    const text = String(message ?? '').trim();
    connectionStatus.textContent = text;
    connectionStatus.style.display = text ? 'block' : 'none';
  };

  const connectionLabel = connection => {
    const name = connection?.name || connection?.model || connection?.id || '이름 없는 연결';
    const provider = connection?.provider ? ` · ${connection.provider}` : '';
    return `${name}${provider}`;
  };

  const renderConnections = () => {
    const list = Array.isArray(cfg.connections) ? cfg.connections : [];
    connectionSelect.innerHTML = [
      '<option value="">연결을 선택하세요</option>',
      ...list.map(connection =>
        `<option value="${esc(connection.id)}">${esc(connectionLabel(connection))}</option>`
      )
    ].join('');
    connectionSelect.value = cfg.connectionId || '';
  };

  const fetchJsonWithFallback = async (paths, options = {}) => {
    if (typeof window.fetch !== 'function') {
      throw new Error('이 확장 런타임에서 window.fetch를 사용할 수 없습니다.');
    }
    const failures = [];
    for (const path of paths) {
      const method = String(options.method || 'GET').toUpperCase();
      const headers = new Headers(options.headers || {});
      if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) {
        headers.set('x-marinara-csrf', '1');
      }

      const controller = new AbortController();
      const callerSignal = options.signal;
      const forwardAbort = () => controller.abort(callerSignal?.reason);
      if (callerSignal?.aborted) forwardAbort();
      else callerSignal?.addEventListener('abort', forwardAbort, { once: true });
      activeRequests.add(controller);

      try {
        const response = await window.fetch(path, {
          ...options,
          method,
          headers,
          credentials: 'same-origin',
          cache: 'no-store',
          signal: controller.signal
        });
        const raw = await response.text();
        let payload = raw;
        try { payload = raw ? JSON.parse(raw) : null; } catch {}

        if (!response.ok) {
          const detail = typeof payload === 'object'
            ? (payload?.error?.message || payload?.message || JSON.stringify(payload))
            : String(payload || '');
          failures.push(`${path} → HTTP ${response.status}${detail ? `: ${detail}` : ''}`);
          continue;
        }
        return { payload, path, status: response.status };
      } catch (error) {
        if (error?.name === 'AbortError') throw error;
        failures.push(`${path} → ${error?.message || error}`);
      } finally {
        activeRequests.delete(controller);
        callerSignal?.removeEventListener('abort', forwardAbort);
      }
    }
    throw new Error(failures.join('\n'));
  };

  const loadConnections = async (preferredId = cfg.connectionId) => {
    const button = root.querySelector('[data-act="refresh-connections"]');
    const previousText = button.textContent;
    button.textContent = '불러오는 중…';

    try {
      const { payload, path } = await fetchJsonWithFallback([
        '/api/connections'
      ], { method: 'GET' });

      const list = Array.isArray(payload)
        ? payload
        : Array.isArray(payload?.connections)
          ? payload.connections
          : Array.isArray(payload?.data)
            ? payload.data
            : [];

      if (!Array.isArray(list) || list.length === 0) {
        throw new Error(`연결 목록 응답은 받았지만 항목이 없습니다.\n사용 주소: ${path}\n응답: ${typeof payload === 'string' ? payload : JSON.stringify(payload)}`);
      }

      cfg.connections = list.filter(item => item?.id);
      if (cfg.connections.length === 0) {
        throw new Error(`응답에 id가 있는 연결이 없습니다.\n응답: ${JSON.stringify(payload)}`);
      }

      const desiredId = preferredId || cfg.connectionId || '';
      cfg.connectionId = cfg.connections.some(item => String(item.id) === String(desiredId))
        ? String(desiredId)
        : '';

      renderConnections();
      connectionSelect.value = cfg.connectionId;

      setConnectionStatus('');
    } catch (error) {
      connectionSelect.innerHTML = `<option value="">연결 불러오기 실패</option>`;
      setConnectionStatus(`연결 목록 불러오기 실패\n${error?.message || error}`);
    } finally {
      button.textContent = previousText;
    }
  };

  const extractGeneratedText = payload => {
    if (payload == null) return '';
    if (typeof payload === 'string') {
      const text = payload.trim();
      if (!text) return '';
      if (text.includes('data:')) {
        const chunks = [];
        for (const line of text.split(/\r?\n/)) {
          if (!line.startsWith('data:')) continue;
          const body = line.slice(5).trim();
          if (!body || body === '[DONE]') continue;
          try {
            const parsed = JSON.parse(body);
            const piece = parsed?.choices?.[0]?.delta?.content ?? parsed?.choices?.[0]?.message?.content ?? parsed?.delta?.content ?? parsed?.content ?? parsed?.text ?? parsed?.response ?? '';
            if (piece) chunks.push(String(piece));
          } catch { chunks.push(body); }
        }
        if (chunks.length) return chunks.join('');
      }
      return text;
    }
    const direct = payload?.text ?? payload?.content ?? payload?.output_text ?? payload?.output ?? payload?.response ?? payload?.result ?? payload?.data?.text ?? payload?.data?.content ?? payload?.data?.output ?? payload?.data?.response ?? payload?.message?.content ?? payload?.choices?.[0]?.message?.content ?? payload?.choices?.[0]?.delta?.content ?? payload?.choices?.[0]?.text;
    if (typeof direct === 'string') return direct;
    if (Array.isArray(direct)) return direct.map(item => typeof item === 'string' ? item : (item?.text || item?.content || '')).join('');
    if (Array.isArray(payload?.output)) return payload.output.flatMap(item => item?.content || []).map(item => item?.text || item?.content || '').join('');
    return '';
  };

  const TASKS = {
    translate: {
      loading: '번역 중…',
      system: 'You are a professional English-to-Korean translator for fiction, dialogue, and roleplay. Translate the provided English text into natural Korean while preserving the original meaning, tone, nuance, dialogue structure, formatting, and line breaks. Output only the Korean translation. Do not include the original text, titles, headings, explanations, labels, quotation marks, notes, or any additional text.'
    },
    grammar: {
      loading: '문법을 분석하는 중…',
      system: 'You are an English grammar tutor for a Korean learner. Analyze the selected English text in Korean. Explain the sentence structure, clauses, tense, voice, important grammar patterns, and the grammatical role of key words or phrases. Quote only the necessary English fragments. Keep the explanation practical, accurate, and easy to scan.'
    },
    nuance: {
      loading: '뉘앙스를 분석하는 중…',
      system: 'You are an English usage and nuance tutor for a Korean learner. Explain the selected English text in Korean. Focus on the intended meaning, emotional tone, level of formality, implied attitude, contextual subtext, and how a native speaker would perceive it. Distinguish literal meaning from natural contextual meaning when useful. Keep the explanation practical and easy to scan.'
    },
    paraphrase: {
      loading: '자연스럽게 바꿔 쓰는 중…',
      system: 'You are an English writing tutor. Paraphrase the selected English text into three natural English alternatives: neutral and natural, simpler, and more expressive or literary. Preserve the meaning. After each alternative, add one brief Korean note explaining its tone.'
    },
    similar: {
      loading: '유사 표현을 찾는 중…',
      system: 'You are an English expression tutor for a Korean learner. Give five natural English expressions similar to the selected text or its key expression. For each, provide a concise Korean meaning and one short note about tone, formality, or nuance.'
    },
    difficulty: {
      loading: '난이도를 분석하는 중…',
      system: 'You are an English proficiency assessor for a Korean learner. Estimate the selected English text at a CEFR level from A1 to C2. Answer in Korean. Include the estimated level, difficult vocabulary or expressions, grammar features, why it fits that level, and a simpler English rewrite one level below. Acknowledge uncertainty when the sample is too short.'
    }
  };

  const requestTaskResult = async (item, taskName) => {
    const task = TASKS[taskName];
    if (!task) throw new Error(`알 수 없는 분석 기능: ${taskName}`);

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 120000);

    try {
      const requestBody = {
        connectionId: cfg.connectionId,
        messages: [
          {
            role: 'system',
            content: [
              String(cfg.promptCommon || defaults.promptCommon).trim(),
              String(cfg.prompts?.[taskName] || task.system).trim()
            ].filter(Boolean).join('\n\n')
          },
          { role: 'user', content: item.text }
        ]
      };

      const { payload, path } = await fetchJsonWithFallback([
        '/api/generate/raw'
      ], {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestBody),
        signal: controller.signal
      });

      const generated = String(extractGeneratedText(payload) || '').trim();
      if (!generated) {
        const preview = typeof payload === 'string'
          ? payload.slice(0, 500)
          : JSON.stringify(payload).slice(0, 500);
        throw new Error(`응답 결과를 찾지 못했습니다.\n사용 주소: ${path}\n응답 일부: ${preview || '(빈 응답)'}`);
      }

      return generated;
    } finally {
      clearTimeout(timeoutId);
    }
  };

  const runAllAI = async (force = false) => {
    const result = popup.querySelector('[data-result]');
    const item = getActiveAnalysis();

    if (!item) {
      result.classList.remove('mes-muted');
      result.textContent = '분석할 텍스트가 없습니다.';
      return;
    }

    if (!cfg.connectionId) {
      result.classList.remove('mes-muted');
      result.textContent = '📚 설정에서 사용할 AI 연결을 먼저 선택하세요.';
      return;
    }

    const tasks = ['translate', 'grammar', 'nuance', 'similar', 'difficulty'];
    const labels = {
      translate: '번역',
      grammar: '문법',
      nuance: '뉘앙스',
      similar: '유사 표현',
      difficulty: '난이도'
    };

    const targets = force
      ? tasks
      : tasks.filter(taskName => !item.results?.[taskName]);

    if (!targets.length) {
      activeTask = 'combined';
      renderAnalysis();
      return;
    }

    result.classList.remove('mes-muted');

    for (let index = 0; index < targets.length; index += 1) {
      const taskName = targets[index];
      result.textContent = `한 번에 분석 중… ${index + 1}/${targets.length}\n현재: ${labels[taskName]}`;

      try {
        const generated = await requestTaskResult(item, taskName);
        item.results = { ...(item.results || {}), [taskName]: generated };
        item.updatedAt = new Date().toISOString();
        await saveCfg();
      } catch (error) {
        result.textContent = error?.name === 'AbortError'
          ? `${labels[taskName]} 요청 시간이 초과되었습니다.`
          : `${labels[taskName]} 생성 실패: ${error?.message || error}`;
        return;
      }
    }

    activeTask = 'combined';
    renderAnalysis();
  };

  const runAI = async (taskName, force = false) => {
    const result = popup.querySelector('[data-result]');
    const task = TASKS[taskName];
    const item = getActiveAnalysis();

    if (!task || !item) {
      result.classList.remove('mes-muted');
      result.textContent = '분석할 텍스트가 없습니다.';
      return;
    }

    activeTask = taskName;
    renderAnalysis();

    if (!force && item.results?.[taskName]) return;

    if (!cfg.connectionId) {
      result.classList.remove('mes-muted');
      result.textContent = '📚 설정에서 사용할 AI 연결을 먼저 선택하세요.';
      return;
    }

    result.classList.remove('mes-muted');
    result.textContent = task.loading;

    try {
      const generated = await requestTaskResult(item, taskName);
      item.results = { ...(item.results || {}), [taskName]: generated };
      item.updatedAt = new Date().toISOString();
      await saveCfg();
      renderAnalysis();
    } catch (error) {
      result.textContent = error?.name === 'AbortError'
        ? 'AI 요청 시간이 초과되었습니다.'
        : `AI 요청 실패: ${error?.message || error}`;
    }
  };

  makeDraggable(root, root.querySelector('.mes-root-head'), 'panelPosition');
  makeDraggable(popup, popup.querySelector('.mes-head'), linkedPopupPositionKey);

  popup.querySelector('[data-act="center-popup"]').addEventListener('click', () => {
    centerPopup(true);
  });

  root.querySelector('[data-act="refresh-connections"]').addEventListener('click', loadConnections);
  connectionSelect.addEventListener('change', async event => {
    cfg.connectionId = event.target.value;
    await saveCfg();
    setConnectionStatus('');
  });

  popup.querySelectorAll('[data-task]').forEach(button => {
    button.addEventListener('click', () => {
      const taskName = button.dataset.task;
      if (taskName === 'combined') {
        activeTask = 'combined';
        const item = getActiveAnalysis();
        const hasAnyResult = item && ['translate', 'grammar', 'nuance', 'similar', 'difficulty']
          .some(name => item.results?.[name]);
        if (item && !hasAnyResult) runAllAI(false);
        else renderAnalysis();
        return;
      }
      runAI(taskName);
    });
  });

  popup.querySelector('[data-act="toggle-history"]').addEventListener('click', () => {
    historyOpen = !historyOpen;
    renderHistoryPanel();
  });

  popup.querySelector('[data-act="regenerate"]').addEventListener('click', () => {
    if (!getActiveAnalysis()) return;
    if (activeTask === 'combined') runAllAI(true);
    else runAI(activeTask, true);
  });

  popup.querySelector('[data-act="edit-saved-card"]').addEventListener('click', () => {
    const item = getVocabularyForAnalysis();
    if (item) renderPopupCardEdit(item);
  });

  popup.querySelectorAll('[data-act="cancel-popup-card-edit"]').forEach(button => {
    button.addEventListener('click', () => closePopupCardEdit(false));
  });

  popup.querySelector('[data-popup-card-edit-form]').addEventListener('submit', async event => {
    event.preventDefault();
    const item = cfg.vocabulary.find(entry => entry.id === activePopupEditId);
    if (!item) {
      closePopupCardEdit(true);
      return;
    }
    const form = event.currentTarget;
    const nextText = normalizeSelectionText(form.elements['popup-edit-text'].value);
    const nextKind = form.elements['popup-edit-kind'].value === 'word' ? 'word' : 'sentence';
    const error = popup.querySelector('[data-popup-edit-error]');
    if (!nextText) {
      error.textContent = '영어 원문을 입력해 주세요.';
      form.elements['popup-edit-text'].focus();
      return;
    }
    const duplicate = cfg.vocabulary.find(entry =>
      entry.id !== item.id && analysisKey(entry.text, entry.kind) === analysisKey(nextText, nextKind)
    );
    if (duplicate) {
      error.textContent = '같은 유형과 영어 원문을 가진 카드가 이미 있습니다.';
      form.elements['popup-edit-text'].focus();
      return;
    }
    error.textContent = '';
    const linkedAnalysis = cfg.analysisHistory.find(entry => vocabularyKey(entry) === vocabularyKey(item));
    item.text = nextText;
    item.kind = nextKind;
    item.results = {
      ...(item.results || {}),
      translate: String(form.elements['popup-edit-translate'].value || '').trim(),
      grammar: String(form.elements['popup-edit-grammar'].value || '').trim(),
      nuance: String(form.elements['popup-edit-nuance'].value || '').trim(),
      similar: String(form.elements['popup-edit-similar'].value || '').trim(),
      difficulty: String(form.elements['popup-edit-difficulty'].value || '').trim()
    };
    item.updatedAt = new Date().toISOString();
    if (linkedAnalysis) {
      linkedAnalysis.text = item.text;
      linkedAnalysis.kind = item.kind;
      linkedAnalysis.analysisKey = analysisKey(item.text, item.kind);
      linkedAnalysis.results = { ...(item.results || {}) };
      linkedAnalysis.updatedAt = item.updatedAt;
      cfg.activeAnalysisId = linkedAnalysis.id;
    }
    await saveCfg();
    showPopupAnalysisContent();
    renderList();
    renderAnalysis();
  });

  popup.querySelector('[data-history]').addEventListener('change', event => {
    activateAnalysis(event.target.value);
  });

  popup.querySelector('[data-act="delete-history"]').addEventListener('click', async () => {
    const current = getActiveAnalysis();
    if (!current) return;
    cfg.analysisHistory = cfg.analysisHistory.filter(item => item.id !== current.id);
    cfg.activeAnalysisId = cfg.analysisHistory[0]?.id || '';
    await saveCfg();
    renderAnalysis();
  });

  popup.querySelector('[data-act="copy"]').addEventListener('click', async () => {
    await navigator.clipboard.writeText(selectedText).catch(() => {});
    const result = popup.querySelector('[data-result]');
    result.textContent = '원문을 복사했습니다.';
    result.classList.remove('mes-muted');
  });

  popup.querySelector('[data-act="save"]').addEventListener('click', async () => {
    const item = getActiveAnalysis();
    if (!item) return;

    cfg.vocabulary = normalizeVocabulary(cfg.vocabulary);
    const existing = cfg.vocabulary.find(entry => vocabularyKey(entry) === vocabularyKey(item));

    if (existing) {
      existing.results = { ...(existing.results || {}), ...(item.results || {}) };
      existing.savedAt = new Date().toISOString();
    } else {
      cfg.vocabulary.push({
        id: `vocab-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        text: item.text,
        kind: item.kind || 'word',
        savedAt: new Date().toISOString(),
        favorite: false,
        results: { ...(item.results || {}) }
      });
    }

    await saveCfg();
    renderList();
    renderSaveState();
    const result = popup.querySelector('[data-result]');
    result.hidden = false;
    result.textContent = existing ? '단어장 내용을 업데이트했습니다.' : '단어장에 저장했습니다.';
    result.classList.remove('mes-muted');
  });

  const openVocabularyItem = async (item, { openEditor = false } = {}) => {
    if (!item) return;
    popupReturnToRoot = true;
    syncPopupReturnControl();
    let analysis = cfg.analysisHistory.find(entry =>
      analysisKey(entry.text, entry.kind) === analysisKey(item.text, item.kind)
    );

    if (!analysis) {
      analysis = {
        id: `analysis-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        text: item.text,
        kind: item.kind,
        analysisKey: analysisKey(item.text, item.kind),
        createdAt: item.savedAt || new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        results: { ...(item.results || {}) }
      };
      cfg.analysisHistory.unshift(analysis);
    } else {
      analysis.results = { ...(item.results || {}), ...(analysis.results || {}) };
    }

    cfg.analysisHistory = cfg.analysisHistory.slice(0, 10);
    cfg.activeAnalysisId = analysis.id;
    activeTask = 'combined';
    showPopupAnalysisContent();
    renderAnalysis();
    if (openEditor) renderPopupCardEdit(item);
    popup.hidden = false;
    placePopup(innerWidth / 2 - 180, innerHeight / 3);
    root.hidden = true;
    await saveCfg();
  };

  root.querySelector('[data-act="toggle-settings"]').addEventListener('click', () => {
    rootView = rootView === 'settings' ? 'vocabulary' : 'settings';
    renderRootView();
  });

  popup.querySelector('[data-act="open-settings"]').addEventListener('click', () => {
    if (!closePopupCardEdit(false)) return;
    popup.hidden = true;
    popupReturnToRoot = false;
    syncPopupReturnControl();
    root.hidden = false;
    rootView = 'settings';
    renderRootView();
    fillPromptEditors();
    applyStoredPositions();
  });

  root.addEventListener('click', async event => {
    const selectionId = event.target?.getAttribute?.('data-toggle-vocab-selection') ||
      event.target?.getAttribute?.('data-select-vocab');
    if (selectionId && vocabularySelectionMode) {
      toggleVocabularySelection(selectionId);
      return;
    }
    const openId = event.target?.getAttribute?.('data-open-vocab');
    if (openId) {
      await openVocabularyItem(cfg.vocabulary.find(item => item.id === openId));
      return;
    }

    const moreId = event.target?.getAttribute?.('data-more-vocab');
    if (moreId) {
      const item = cfg.vocabulary.find(entry => entry.id === moreId);
      if (item) openCardMenu(event.target, item);
      return;
    }

    const menuAction = event.target?.getAttribute?.('data-menu-card-action');
    if (menuAction && activeMenuCardId) {
      const item = cfg.vocabulary.find(entry => entry.id === activeMenuCardId);
      closeCardMenu();
      if (!item) return;
      if (menuAction === 'edit') {
        await openVocabularyItem(item, { openEditor: true });
        return;
      }
      if (menuAction === 'remove') {
        if (!confirm(`"${item.text}" 카드를 삭제할까요? 이 작업은 되돌릴 수 없습니다.`)) return;
        cfg.vocabulary = cfg.vocabulary.filter(entry => entry.id !== item.id);
        await saveCfg();
        renderList();
        renderSaveState();
      }
      return;
    }

    const favoriteId = event.target?.getAttribute?.('data-favorite-vocab');
    if (favoriteId) {
      const item = cfg.vocabulary.find(entry => entry.id === favoriteId);
      if (item) {
        item.favorite = !item.favorite;
        await saveCfg();
        renderList();
      }
      return;
    }

    const copyId = event.target?.getAttribute?.('data-copy-vocab');
    if (copyId) {
      const item = cfg.vocabulary.find(entry => entry.id === copyId);
      if (item?.text) {
        await navigator.clipboard.writeText(item.text).catch(() => {});
      }
      return;
    }

  });

  root.querySelector('[data-vocab-search]').addEventListener('input', renderList);
  root.querySelector('.mes-vocab-filters').addEventListener('click', event => {
    const button = event.target.closest('[data-vocab-filter]');
    if (!button) return;
    vocabularyFilter = button.dataset.vocabFilter || 'all';
    renderList();
  });

  root.querySelector('[data-act="toggle-vocab-selection"]').addEventListener('click', () => {
    vocabularySelectionMode = !vocabularySelectionMode;
    if (!vocabularySelectionMode) selectedVocabularyIds.clear();
    closeCardMenu();
    renderList();
  });

  root.querySelector('[data-vocab-select-all]').addEventListener('change', event => {
    const visibleIds = filteredVocabulary().map(item => item.id);
    if (event.target.checked) visibleIds.forEach(id => selectedVocabularyIds.add(id));
    else visibleIds.forEach(id => selectedVocabularyIds.delete(id));
    renderList();
  });

  root.querySelector('[data-vocab-bulk]').addEventListener('click', async event => {
    const action = event.target?.getAttribute?.('data-bulk-vocab');
    if (!action) return;
    const selectedItems = cfg.vocabulary.filter(item => selectedVocabularyIds.has(item.id));
    if (!selectedItems.length) return;
    if (action === 'favorite') {
      const nextFavorite = !selectedItems.every(item => item.favorite);
      selectedItems.forEach(item => { item.favorite = nextFavorite; });
      await completeBulkVocabularyAction();
      return;
    }
    if (action === 'delete') {
      if (!confirm(`선택한 ${selectedItems.length}개 카드를 삭제할까요? 이 작업은 되돌릴 수 없습니다.`)) return;
      cfg.vocabulary = cfg.vocabulary.filter(item => !selectedVocabularyIds.has(item.id));
      selectedVocabularyIds.clear();
      vocabularySelectionMode = false;
      await completeBulkVocabularyAction();
    }
  });

  root.querySelector('[data-card-menu]').addEventListener('toggle', event => {
    if (event.newState === 'closed' && !event.currentTarget.matches(':popover-open')) activeMenuCardId = '';
  });

  root.querySelector('[data-act="clear"]').addEventListener('click', async () => {
    cfg.vocabulary = [];
    await saveCfg();
    renderList();
  });

  const downloadJson = (filename, value) => {
    const blob = new Blob([JSON.stringify(value, null, 2)], { type: 'application/json;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  root.querySelector('[data-act="export-data"]').addEventListener('click', () => {
    const { analysisHistory, activeAnalysisId, ...persistentConfig } = cfg;
    downloadJson(
      `english-study-simple-backup-${new Date().toISOString().slice(0, 10)}.json`,
      {
        format: 'marinara-english-study-backup',
        version: 2,
        extension: 'English Study Simple',
        exportedAt: new Date().toISOString(),
        config: persistentConfig
      }
    );
  });

  root.querySelector('[data-act="import-data"]').addEventListener('click', () => {
    root.querySelector('[data-import-file]').click();
  });

  root.querySelector('[data-import-file]').addEventListener('change', async event => {
    const file = event.target.files?.[0];
    if (!file) return;

    try {
      const parsed = JSON.parse(await file.text());
      const incoming = parsed?.config || parsed;
      if (!incoming || typeof incoming !== 'object') throw new Error('올바른 백업 파일이 아닙니다.');

      cfg = {
        ...defaults,
        ...cfg,
        ...incoming,
        vocabulary: normalizeVocabulary([
          ...(incoming.vocabulary || []),
          ...(cfg.vocabulary || [])
        ]),
        // 분석 기록과 현재 선택은 임시 데이터이므로 백업에서 가져오지 않습니다.
        analysisHistory: Array.isArray(cfg.analysisHistory) ? cfg.analysisHistory.slice(0, 10) : [],
        activeAnalysisId: cfg.activeAnalysisId || ''
      };

      cfg.promptCommon = String(cfg.promptCommon || defaults.promptCommon);
      cfg.prompts = { ...defaults.prompts, ...(cfg.prompts || {}) };
      const restoredConnectionId = cfg.connectionId || '';
      await saveCfg();
      root.querySelector('[name="mode"]').value = cfg.mode;
      root.querySelector('[name="clickScope"]').value = cfg.clickScope;
      renderList();
      renderConnections();
      renderAnalysis();
      applyStoredPositions();
      await loadConnections(restoredConnectionId);
      connectionSelect.value = cfg.connectionId || '';
    } catch (error) {
      alert(`백업 복원 실패: ${error?.message || error}`);
    } finally {
      event.target.value = '';
    }
  });

  const normalizeStoredConfig = savedState => {
    const next = { ...defaults, ...(savedState?.config || {}) };
    next.promptCommon = String(next.promptCommon || defaults.promptCommon);
    next.prompts = { ...defaults.prompts, ...(next.prompts || {}) };
    if (!Array.isArray(next.vocabulary)) next.vocabulary = [];
    next.vocabulary = normalizeVocabulary(next.vocabulary);
    if (!Array.isArray(next.analysisHistory)) next.analysisHistory = [];
    next.analysisHistory = next.analysisHistory.map(item => ({
      ...item,
      text: normalizeSelectionText(item?.text),
      analysisKey: analysisKey(item?.text, item?.kind),
      results: item?.results && typeof item.results === 'object' ? item.results : {}
    })).filter(item => item.text);

    const mergedHistory = [];
    for (const item of next.analysisHistory) {
      const existing = mergedHistory.find(entry => entry.analysisKey === item.analysisKey);
      if (!existing) {
        mergedHistory.push(item);
      } else {
        existing.results = { ...(item.results || {}), ...(existing.results || {}) };
        existing.updatedAt = existing.updatedAt || item.updatedAt;
      }
    }
    next.analysisHistory = mergedHistory.slice(0, 10);
    if (!next.analysisHistory.some(item => item.id === next.activeAnalysisId)) {
      next.activeAnalysisId = next.analysisHistory[0]?.id || '';
    }
    return next;
  };

  const renderStoredConfig = () => {
    root.querySelector('[name="mode"]').value = cfg.mode;
    root.querySelector('[name="clickScope"]').value = cfg.clickScope;
    fillPromptEditors();
    renderList();
    renderRootView();
    renderConnections();
    renderAnalysis();
    applyStoredPositions();
    applyTogglePosition();
  };

  const refreshStoredConfig = ({ reloadConnections = false } = {}) => {
    if (storageLoadPromise) return storageLoadPromise;
    storageLoadPromise = (async () => {
      storageReady = false;
      try {
        const response = await storage.get();
        const savedState = response?.value && typeof response.value === 'object' ? response.value : response;
        cfg = normalizeStoredConfig(savedState || {});
        storageReady = true;
        setStorageError('');
        renderStoredConfig();
        if (reloadConnections) await loadConnections();
        return true;
      } catch (error) {
        storageReady = false;
        setStorageError(`서버 학습 데이터 불러오기 실패: ${error?.message || error}. 빈 데이터로 덮어쓰지 않았습니다.`);
        renderStoredConfig();
        if (reloadConnections) await loadConnections();
        return false;
      } finally {
        storageLoadPromise = null;
      }
    })();
    return storageLoadPromise;
  };

  refreshStoredConfig({ reloadConnections: true });

  on(window, 'focus', () => refreshStoredConfig());
  on(document, 'visibilitychange', () => {
    if (document.visibilityState === 'visible') refreshStoredConfig();
  });

  on(window, 'resize', () => {
    clearSelectionAction();
    applyTogglePosition();
    applyStoredPositions();
    if (!popup.hidden && !isCoarse()) {
      const rect = popup.getBoundingClientRect();
      const pos = clampPosition(rect.left, rect.top, rect.width, rect.height);
      popup.style.left = `${pos.left}px`;
      popup.style.top = `${pos.top}px`;
      cfg[linkedPopupPositionKey()] = pos;
      saveCfg();
    }
  });
})(marinara);
