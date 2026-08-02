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
  let vocabularyFilter = 'all';

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
#${ROOT}[hidden],#${POPUP}[hidden]{display:none}
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

@media (max-width:640px){
#${ROOT}{left:6px;right:6px;bottom:calc(72px + env(safe-area-inset-bottom));width:auto;max-height:82vh;font-size:11px}
#${ROOT}:has([data-root-view="vocabulary"]:not([hidden])){left:auto;right:6px;width:min(340px,calc(100vw - 24px));min-width:min(300px,calc(100vw - 24px));max-width:340px}
#${ROOT} .mes-root-view{max-height:calc(82vh - 39px)}
#${POPUP}{width:min(360px,calc(100vw - 28px));max-height:min(64vh,500px);font-size:12px}
#${ROOT} [data-vocab-search]{font-size:12px;padding:7px 8px}
#${ROOT} [data-root-view="settings"]{font-size:11px}
#${ROOT} [data-root-view="settings"] select,
#${ROOT} [data-root-view="settings"] input{font-size:12px;padding:6px}
#${ROOT} .mes-prompt-settings textarea{font-size:10.5px;line-height:1.42;padding:7px;max-width:100%}
#${POPUP} .mes-head{min-height:36px}
#${POPUP} .mes-selected-row{padding:6px 8px 6px 10px}
#${POPUP} .mes-selected{font-size:13px;line-height:1.4}
#${POPUP} .mes-selected-actions>button{min-width:34px;min-height:34px}
#${POPUP} .mes-regenerate{min-width:34px;min-height:34px}
#${ROOT} .mes-root-head button{width:34px;height:34px}
#${ROOT} .mes-vocab-filters{gap:22px}
#${ROOT} .mes-vocab-filters button{min-height:38px;padding-bottom:9px;font-size:13px}
#${ROOT} .mes-vocab-count{padding-bottom:10px;font-size:11px}
#${ROOT} .mes-list{height:270px;max-height:270px;overflow-y:auto;overflow-x:hidden;align-content:start}
#${ROOT} .mes-card{padding:9px 10px 3px}
#${ROOT} .mes-card-buttons{gap:4px;margin-top:2px}
#${ROOT} .mes-card-buttons button{width:38px;height:38px;min-width:38px;font-size:17px}
}
  `);

  const toggle = addElement(document.body, 'button', {
    id: TOGGLE, type:'button', title:'English Study', 'aria-label':'English Study', textContent:'📚'
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
          <span class="mes-vocab-count" data-count></span>
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
        <div class="mes-muted">설정, 최근 분석 기록, 단어장을 JSON으로 백업할 수 있습니다.</div>
      </div>
      <input type="file" data-import-file accept="application/json,.json" hidden>
    </div>`;

  popup.innerHTML = `
    <div class="mes-head">
      <span data-title>문장 보기</span>
      <div class="mes-popup-head-actions">
        <button data-act="open-settings" title="설정 열기" aria-label="설정 열기">⚙</button>
        <button data-act="center-popup" title="분석창 중앙 배치" aria-label="분석창 중앙 배치">◎</button>
        <button data-act="close">×</button>
      </div>
    </div>
    <div class="mes-selected-row">
      <div class="mes-selected" data-selected></div>
      <div class="mes-selected-actions">
        <button data-act="copy" title="원문 복사" aria-label="원문 복사">⧉</button>
        <button data-act="save" title="단어장에 저장" aria-label="단어장에 저장">☆</button>
        <button class="mes-history-toggle" data-act="toggle-history" aria-expanded="false" title="분석 기록" aria-label="분석 기록">
          <span data-history-label>0</span><span data-history-chevron>⌄</span>
        </button>
      </div>
    </div>
    <div class="mes-history-panel" data-history-panel hidden>
      <select data-history aria-label="최근 분석"></select>
      <button data-act="delete-history" title="현재 기록 삭제" aria-label="현재 기록 삭제">삭제</button>
    </div>
    <div class="mes-tabs-row">
      <div class="mes-tabs">
        <button data-task="combined">AI 해설</button>
        <button data-task="translate">번역</button>
        <button data-task="grammar">문법</button>
        <button data-task="nuance">뉘앙스</button>
        <button data-task="similar">유사 표현</button>
        <button data-task="difficulty">난이도</button>
      </div>
      <button class="mes-regenerate" data-act="regenerate" title="다시 생성" aria-label="다시 생성">↻</button>
    </div>
    <div class="mes-result mes-muted" data-result>기능을 선택하세요.</div>
    <div class="mes-combined" data-combined hidden></div>`;

  const clampPosition = (left, top, width, height) => ({
    left: Math.max(6, Math.min(left, window.innerWidth - width - 6)),
    top: Math.max(6, Math.min(top, window.innerHeight - height - 6))
  });

  const applyStoredPositions = () => {
    if (cfg.togglePosition && Number.isFinite(cfg.togglePosition.left) && Number.isFinite(cfg.togglePosition.top)) {
      const pos = clampPosition(cfg.togglePosition.left, cfg.togglePosition.top, toggle.offsetWidth || 44, toggle.offsetHeight || 44);
      toggle.style.left = `${pos.left}px`;
      toggle.style.top = `${pos.top}px`;
      toggle.style.right = 'auto';
      toggle.style.bottom = 'auto';
    }
    if (cfg.panelPosition && Number.isFinite(cfg.panelPosition.left) && Number.isFinite(cfg.panelPosition.top)) {
      const pos = clampPosition(cfg.panelPosition.left, cfg.panelPosition.top, root.offsetWidth || 340, root.offsetHeight || 300);
      root.style.left = `${pos.left}px`;
      root.style.top = `${pos.top}px`;
      root.style.right = 'auto';
      root.style.bottom = 'auto';
    }
    if (cfg.popupPosition && Number.isFinite(cfg.popupPosition.left) && Number.isFinite(cfg.popupPosition.top)) {
      const pos = clampPosition(
        cfg.popupPosition.left,
        cfg.popupPosition.top,
        popup.offsetWidth || Math.min(390, innerWidth - 20),
        popup.offsetHeight || Math.min(560, innerHeight - 20)
      );
      popup.style.left = `${pos.left}px`;
      popup.style.top = `${pos.top}px`;
      popup.style.right = 'auto';
      popup.style.bottom = 'auto';
    }
  };

  const saveCfg = async () => storage.patch({ config: cfg }).catch(() => {});

  const makeDraggable = (element, handle, configKey, { suppressClick = false } = {}) => {
    let drag = null;
    let moved = false;

    handle.addEventListener('pointerdown', event => {
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
      cfg[configKey] = { left: Math.round(rect.left), top: Math.round(rect.top) };
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

    list.innerHTML = items.length
      ? items.map(item => {
          const translation = item.results?.translate || '';
          return `<div class="mes-card" data-vocab-id="${esc(item.id)}">
            <div class="mes-card-text" data-open-vocab="${esc(item.id)}">${esc(item.text)}</div>
            ${translation ? `<div class="mes-card-preview">${esc(translation)}</div>` : ''}
            <div class="mes-card-buttons" aria-label="항목 작업">
              <button data-open-vocab="${esc(item.id)}" title="분석 열기" aria-label="분석 열기">↗</button>
              <button data-favorite-vocab="${esc(item.id)}" data-active="${item.favorite ? 'true' : 'false'}" title="${item.favorite ? '즐겨찾기 해제' : '즐겨찾기'}" aria-label="${item.favorite ? '즐겨찾기 해제' : '즐겨찾기'}">${item.favorite ? '★' : '☆'}</button>
              <button data-copy-vocab="${esc(item.id)}" title="복사" aria-label="복사">⧉</button>
              <button data-remove-vocab="${esc(item.id)}" title="삭제" aria-label="삭제">×</button>
            </div>
          </div>`;
        }).join('')
      : '<div class="mes-muted">조건에 맞는 저장 항목이 없습니다.</div>';
  };

  const historyLabel = item => {
    const text = String(item?.text || '').replace(/\s+/g, ' ').trim();
    return text.length > 54 ? `${text.slice(0, 54)}…` : text;
  };

  const getActiveAnalysis = () =>
    cfg.analysisHistory.find(item => item.id === cfg.activeAnalysisId) || null;

  const renderHistorySelect = () => {
    const select = popup.querySelector('[data-history]');
    const items = Array.isArray(cfg.analysisHistory) ? cfg.analysisHistory : [];
    select.innerHTML = items.length
      ? items.map(item => `<option value="${esc(item.id)}"${item.id === cfg.activeAnalysisId ? ' selected' : ''}>${esc(historyLabel(item))}</option>`).join('')
      : '<option value="">최근 분석 없음</option>';
  };

  const renderSaveState = () => {
    const button = popup.querySelector('[data-act="save"]');
    const item = getActiveAnalysis();
    if (!button) return;
    const saved = Boolean(item && normalizeVocabulary(cfg.vocabulary)
      .some(entry => vocabularyKey(entry) === vocabularyKey(item)));
    button.textContent = saved ? '★' : '☆';
    button.dataset.saved = saved ? 'true' : 'false';
    button.title = saved ? '단어장에 저장됨' : '단어장에 저장';
    button.setAttribute('aria-label', button.title);
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
      cfg.popupPosition = pos;
      await saveCfg();
    }
  };

  const placePopup = (x, y, { forceNearSelection = false } = {}) => {
    if (!forceNearSelection && cfg.popupPosition &&
        Number.isFinite(cfg.popupPosition.left) &&
        Number.isFinite(cfg.popupPosition.top)) {
      const width = popup.offsetWidth || Math.min(390, innerWidth - 20);
      const height = popup.offsetHeight || Math.min(560, innerHeight - 20);
      const pos = clampPosition(cfg.popupPosition.left, cfg.popupPosition.top, width, height);
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
    createOrActivateAnalysis(text, kind);
    renderAnalysis();
    placePopup(x, y);
    popup.hidden = false;
  };

  const closePopup = () => { popup.hidden = true; };
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
      pendingSelection = null;
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
    if (popup.contains(event.target) || root.contains(event.target) || toggle.contains(event.target)) return;
    clearTimeout(selectionTimer);
    captureSelection();
    selectionTimer = setTimeout(() => {
      captureSelection();
      if (!pendingSelection) return;
      openPopup(
        pendingSelection.text,
        pendingSelection.kind,
        pendingSelection.x || event.clientX || innerWidth / 2,
        pendingSelection.y || event.clientY || innerHeight / 3
      );
    }, 30);
  };

  const handleClick = event => {
    if (!cfg.enabled || effectiveMode() !== 'click') return;
    if (popup.contains(event.target) || root.contains(event.target) || toggle.contains(event.target)) return;
    const picked = textAtPoint(event.clientX, event.clientY, cfg.clickScope);
    if (picked) openPopup(picked.text, picked.kind, event.clientX, event.clientY);
  };

  const handleDoubleClick = event => {
    if (!cfg.enabled || effectiveMode() !== 'doubleclick') return;
    if (popup.contains(event.target) || root.contains(event.target) || toggle.contains(event.target)) return;
    const picked = textAtPoint(event.clientX, event.clientY, cfg.clickScope);
    if (picked) openPopup(picked.text, picked.kind, event.clientX, event.clientY);
  };

  const startLongPress = event => {
    if (!cfg.enabled || effectiveMode() !== 'longpress') return;
    if (popup.contains(event.target) || root.contains(event.target) || toggle.contains(event.target)) return;
    pressStart = { x:event.clientX, y:event.clientY };
    clearTimeout(pressTimer);
    pressTimer = setTimeout(() => {
      const picked = textAtPoint(pressStart.x, pressStart.y, cfg.clickScope === 'word' ? 'word' : 'sentence');
      if (picked) openPopup(picked.text, picked.kind, pressStart.x, pressStart.y);
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
  on(document, 'selectionchange', captureSelection);
  on(document, 'pointerup', handleSelectionEnd);
  on(document, 'keyup', event => {
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
      await saveCfg();

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
  makeDraggable(popup, popup.querySelector('.mes-head'), 'popupPosition');

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

  const openVocabularyItem = async item => {
    if (!item) return;
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
    await saveCfg();
    renderAnalysis();
    popup.hidden = false;
    placePopup(innerWidth / 2 - 180, innerHeight / 3);
  };

  root.querySelector('[data-act="toggle-settings"]').addEventListener('click', () => {
    rootView = rootView === 'settings' ? 'vocabulary' : 'settings';
    renderRootView();
  });

  popup.querySelector('[data-act="open-settings"]').addEventListener('click', () => {
    popup.hidden = true;
    root.hidden = false;
    rootView = 'settings';
    renderRootView();
    fillPromptEditors();
    applyStoredPositions();
  });

  root.addEventListener('click', async event => {
    const openId = event.target?.getAttribute?.('data-open-vocab');
    if (openId) {
      await openVocabularyItem(cfg.vocabulary.find(item => item.id === openId));
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

    const removeId = event.target?.getAttribute?.('data-remove-vocab');
    if (removeId) {
      cfg.vocabulary = cfg.vocabulary.filter(item => item.id !== removeId);
      await saveCfg();
      renderList();
      renderSaveState();
    }
  });

  root.querySelector('[data-vocab-search]').addEventListener('input', renderList);
  root.querySelector('.mes-vocab-filters').addEventListener('click', event => {
    const button = event.target.closest('[data-vocab-filter]');
    if (!button) return;
    vocabularyFilter = button.dataset.vocabFilter || 'all';
    renderList();
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
    downloadJson(
      `english-study-backup-${new Date().toISOString().slice(0, 10)}.json`,
      {
        format: 'marinara-english-study-backup',
        version: 1,
        exportedAt: new Date().toISOString(),
        config: cfg
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
          ...(cfg.vocabulary || []),
          ...(incoming.vocabulary || [])
        ]),
        analysisHistory: [
          ...(incoming.analysisHistory || []),
          ...(cfg.analysisHistory || [])
        ]
      };

      const history = [];
      for (const raw of cfg.analysisHistory) {
        const text = normalizeSelectionText(raw?.text);
        if (!text) continue;
        const key = analysisKey(text, raw?.kind);
        const existing = history.find(item => item.analysisKey === key);
        const normalized = {
          ...raw,
          id: raw.id || `analysis-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          text,
          kind: raw.kind || 'sentence',
          analysisKey: key,
          results: raw.results && typeof raw.results === 'object' ? raw.results : {}
        };
        if (!existing) history.push(normalized);
        else existing.results = { ...(normalized.results || {}), ...(existing.results || {}) };
      }
      cfg.analysisHistory = history.slice(0, 10);

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

  storage.get().then(r => {
    const savedState = r?.value && typeof r.value === 'object' ? r.value : r;
    cfg = { ...defaults, ...(savedState?.config || {}) };
    cfg.promptCommon = String(cfg.promptCommon || defaults.promptCommon);
    cfg.prompts = { ...defaults.prompts, ...(cfg.prompts || {}) };
    if (!Array.isArray(cfg.vocabulary)) cfg.vocabulary = [];
    cfg.vocabulary = normalizeVocabulary(cfg.vocabulary);
    if (!Array.isArray(cfg.analysisHistory)) cfg.analysisHistory = [];
    cfg.analysisHistory = cfg.analysisHistory.map(item => ({
      ...item,
      text: normalizeSelectionText(item?.text),
      analysisKey: analysisKey(item?.text, item?.kind),
      results: item?.results && typeof item.results === 'object' ? item.results : {}
    })).filter(item => item.text);

    const mergedHistory = [];
    for (const item of cfg.analysisHistory) {
      const existing = mergedHistory.find(entry => entry.analysisKey === item.analysisKey);
      if (!existing) {
        mergedHistory.push(item);
      } else {
        existing.results = { ...(item.results || {}), ...(existing.results || {}) };
        existing.updatedAt = existing.updatedAt || item.updatedAt;
      }
    }
    cfg.analysisHistory = mergedHistory.slice(0, 10);
    if (!cfg.analysisHistory.some(item => item.id === cfg.activeAnalysisId)) {
      cfg.activeAnalysisId = cfg.analysisHistory[0]?.id || '';
    }
    root.querySelector('[name="mode"]').value = cfg.mode;
    root.querySelector('[name="clickScope"]').value = cfg.clickScope;
    fillPromptEditors();
    renderList();
    renderRootView();
    renderConnections();
    renderAnalysis();
    applyStoredPositions();
    applyTogglePosition();
    loadConnections();
  }).catch(() => {
    renderList();
    renderRootView();
    renderConnections();
    renderAnalysis();
    applyStoredPositions();
    applyTogglePosition();
    loadConnections();
  });

  on(window, 'resize', () => {
    applyTogglePosition();
    applyStoredPositions();
    if (!popup.hidden && !isCoarse()) {
      const rect = popup.getBoundingClientRect();
      const pos = clampPosition(rect.left, rect.top, rect.width, rect.height);
      popup.style.left = `${pos.left}px`;
      popup.style.top = `${pos.top}px`;
      cfg.popupPosition = pos;
      saveCfg();
    }
  });
})(marinara);
