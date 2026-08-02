(function () {
  'use strict';

  let currentCard = null;

  function el(tag, attrs, ...children) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (k === 'class') node.className = v;
      else if (k === 'style') Object.assign(node.style, v);
      else if (k.startsWith('on') && typeof v === 'function') {
        node.addEventListener(k.slice(2).toLowerCase(), v);
      } else if (v != null) {
        node.setAttribute(k, v);
      }
    }
    for (const child of children) {
      if (child == null) continue;
      if (typeof child === 'string') node.appendChild(document.createTextNode(child));
      else node.appendChild(child);
    }
    return node;
  }

  function closeCard() {
    if (currentCard && currentCard.parentNode) {
      currentCard.parentNode.removeChild(currentCard);
    }
    currentCard = null;
  }

  function ensureCard() {
    if (currentCard) return currentCard;
    const card = el('div', { class: 'chh-card' });
    document.body.appendChild(card);
    currentCard = card;
    return card;
  }

  const GITHUB_URL = 'https://github.com/tonoid/chh';

  function githubIconSvg() {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 16 16');
    svg.setAttribute('width', '12');
    svg.setAttribute('height', '12');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('fill', 'currentColor');
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute(
      'd',
      'M8 0C3.58 0 0 3.58 0 8a8 8 0 0 0 5.47 7.59c.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0 0 16 8c0-4.42-3.58-8-8-8z'
    );
    svg.appendChild(path);
    return svg;
  }

  function renderCredit() {
    const wrap = el('span', { class: 'chh-credit' });
    const ghLink = el('a', {
      class: 'chh-credit-gh',
      href: GITHUB_URL,
      target: '_blank',
      rel: 'noopener noreferrer',
      title: 'Code source sur GitHub',
      'aria-label': 'GitHub',
    });
    ghLink.appendChild(githubIconSvg());
    wrap.appendChild(ghLink);
    return wrap;
  }

  function renderHeader(card) {
    const header = el(
      'div',
      { class: 'chh-header' },
      el('div', { class: 'chh-title' }, 'CHH'),
      el('button', { class: 'chh-close', onclick: closeCard }, '×')
    );
    card.appendChild(header);
  }

  function renderFields(card, payload) {
    const fields = el('div', { class: 'chh-fields' });
    const isLand = payload && payload.kind === 'land';
    const rows = isLand
      ? [
          ['Code postal', payload.postal],
          ['Ville', payload.city],
          ['Surface terrain', payload.surface ? `${payload.surface} m²` : null],
          ['Section', payload.section],
        ]
      : [
          ['Code postal', payload.postal],
          ['Ville', payload.city],
          ['Surface', payload.surface ? `${payload.surface} m²` : null],
          ['Classe énergie', payload.energyClass],
          ['Classe GES', payload.gesClass],
          ['Type', payload.buildingType],
          ['Date DPE', payload.dateRange ? `${payload.dateRange.gte} → ${payload.dateRange.lte}` : null],
        ];
    for (const [label, value] of rows) {
      if (!value) continue;
      fields.appendChild(
        el(
          'div',
          { class: 'chh-fields-row' },
          el('span', { class: 'chh-fields-label' }, label),
          el('span', null, String(value))
        )
      );
    }
    card.appendChild(fields);
  }

  function showLoading(payload) {
    const card = ensureCard();
    card.innerHTML = '';
    renderHeader(card);
    renderFields(card, payload);
    card.appendChild(el('div', { class: 'chh-status' }, 'Recherche en cours…'));
    return card;
  }

  function showError(message, payload) {
    const card = ensureCard();
    card.innerHTML = '';
    renderHeader(card);
    if (payload) renderFields(card, payload);
    card.appendChild(el('div', { class: 'chh-error' }, message));
  }

  function showDatePrompt(payload, onSubmit) {
    const card = ensureCard();
    card.innerHTML = '';
    renderHeader(card);
    renderFields(card, payload);

    const input = el('input', {
      type: 'text',
      placeholder: 'JJ/MM/AAAA, MM/AAAA ou AAAA (facultatif)',
      autocomplete: 'off',
    });
    const errBox = el('div', { class: 'chh-error', style: { display: 'none' } });
    const submit = () => {
      const raw = input.value.trim();
      if (!raw) {
        errBox.style.display = 'none';
        onSubmit({ ...payload, dateRange: null });
        return;
      }
      const parsed = window.__chhExtract.parseUserDate(raw);
      if (!parsed) {
        errBox.textContent = 'Format de date invalide. Laisser vide pour chercher sans date.';
        errBox.style.display = 'block';
        return;
      }
      errBox.style.display = 'none';
      const range = window.__chhExtract.parseDateRange(parsed);
      onSubmit({ ...payload, dateRange: range });
    };
    const submitNoDate = () => {
      errBox.style.display = 'none';
      onSubmit({ ...payload, dateRange: null });
    };
    input.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') {
        ev.preventDefault();
        submit();
      }
    });

    const prompt = el(
      'div',
      { class: 'chh-date-prompt' },
      el('label', null, 'Date du DPE (facultatif — laisser vide pour chercher par surface + classes)'),
      input,
      errBox,
      el('button', { onclick: submit }, 'Rechercher'),
      el('a', { onclick: submitNoDate, class: 'chh-skip-date' }, 'Chercher sans date')
    );
    card.appendChild(prompt);
    setTimeout(() => input.focus(), 30);
  }

  function confidenceClass(score) {
    if (score >= 80) return 'chh-conf-green';
    if (score >= 50) return 'chh-conf-yellow';
    return 'chh-conf-red';
  }

  function gmapsLink(address, postal, city) {
    const q = encodeURIComponent([address, postal, city].filter(Boolean).join(', '));
    return `https://www.google.com/maps/search/?api=1&query=${q}`;
  }

  function renderCopyBtn(textToCopy) {
    const btn = el('button', { class: 'chh-copy-btn', type: 'button', title: 'Copier l\'adresse' }, '⎘ Copier');
    btn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      navigator.clipboard.writeText(textToCopy).then(() => {
        btn.textContent = '✓ Copié';
        btn.classList.add('chh-copy-done');
        setTimeout(() => {
          btn.textContent = '⎘ Copier';
          btn.classList.remove('chh-copy-done');
        }, 2000);
      }).catch(() => {
        // fallback : sélection manuelle
        btn.textContent = '✗ Erreur';
        setTimeout(() => { btn.textContent = '⎘ Copier'; }, 2000);
      });
    });
    return btn;
  }

  function showResult(payload, result, onModify) {
    const card = ensureCard();
    card.innerHTML = '';
    renderHeader(card);
    renderFields(card, payload);

    if (!result || !result.candidates || result.candidates.length === 0) {
      card.appendChild(
        el(
          'div',
          { class: 'chh-empty' },
          'Aucune correspondance trouvée dans le registre ADEME. Essayez d’ajuster les champs.'
        )
      );
      const footer = el('div', { class: 'chh-footer' });
      if (onModify) footer.appendChild(el('a', { onclick: onModify }, 'Modifier les champs'));
      footer.appendChild(renderCredit());
      card.appendChild(footer);
      return;
    }

    const top = result.candidates[0];
    const conf = confidenceClass(top.score);
    const topBox = el('div', { class: `chh-top ${conf}` });
    const addressText = top.record.address || '(adresse inconnue)';
    topBox.appendChild(el('div', { class: 'chh-address' }, addressText));
    topBox.appendChild(renderCopyBtn([addressText, top.record.postal, top.record.city].filter(Boolean).join(', ')));
    const metaParts = [];
    if (top.record.postal) metaParts.push(top.record.postal);
    if (top.record.city) metaParts.push(top.record.city);
    if (top.record.surface != null) metaParts.push(`${top.record.surface} m²`);
    if (top.record.date) metaParts.push(`DPE ${String(top.record.date).slice(0, 10)}`);
    topBox.appendChild(el('div', { class: 'chh-meta' }, metaParts.join(' • ')));

    const confLabel =
      top.score >= 80 ? 'Confiance élevée' : top.score >= 50 ? 'Confiance moyenne' : 'Confiance faible';
    topBox.appendChild(
      el(
        'div',
        { class: 'chh-confidence' },
        el('span', { class: 'chh-dot' }),
        `${confLabel} (${top.score}/100)`
      )
    );

    const links = el(
      'div',
      { class: 'chh-links' },
      el(
        'a',
        {
          href: gmapsLink(top.record.address, top.record.postal, top.record.city),
          target: '_blank',
          rel: 'noopener noreferrer',
        },
        'Voir sur Google Maps'
      )
    );
    if (top.record.id) {
      links.appendChild(
        el(
          'a',
          {
            href: `https://observatoire-dpe-audit.ademe.fr/afficher-dpe/${encodeURIComponent(top.record.id)}`,
            target: '_blank',
            rel: 'noopener noreferrer',
          },
          'Fiche ADEME'
        )
      );
    }
    topBox.appendChild(links);
    card.appendChild(topBox);

    const alts = result.candidates.slice(1);
    if (alts.length > 0) {
      const details = el(
        'details',
        { class: 'chh-alts' },
        el('summary', null, `Autres candidats (${alts.length})`)
      );
      for (const alt of alts) {
        const row = el(
          'div',
          { class: 'chh-alt-row' },
          el('div', { class: 'chh-alt-address' }, alt.record.address || '(adresse inconnue)'),
          el(
            'div',
            { class: 'chh-meta' },
            [
              alt.record.postal,
              alt.record.city,
              alt.record.surface != null ? `${alt.record.surface} m²` : null,
              alt.record.date ? String(alt.record.date).slice(0, 10) : null,
              `score ${alt.score}`,
            ]
              .filter(Boolean)
              .join(' • ')
          )
        );
        if (alt.diffs && alt.diffs.length > 0) {
          row.appendChild(el('div', { class: 'chh-alt-diffs' }, '≠ ' + alt.diffs.join(' ; ')));
        }
        const altLinks = el(
          'div',
          { class: 'chh-links' },
          el(
            'a',
            {
              href: gmapsLink(alt.record.address, alt.record.postal, alt.record.city),
              target: '_blank',
              rel: 'noopener noreferrer',
            },
            'Google Maps'
          )
        );
        row.appendChild(altLinks);
        details.appendChild(row);
      }
      card.appendChild(details);
    }

    const footerParts = [];
    if (result.cached) footerParts.push(el('span', null, 'cache'));
    if (result.matchMethod === 'ademe') {
      footerParts.push(el('span', null, 'source : registre DPE'));
    } else if (result.matchMethod === 'cadastre') {
      footerParts.push(el('span', null, 'source : cadastre IGN'));
    }
    footerParts.push(el('span', null, `dataset ${result.dataset}`));
    footerParts.push(el('span', null, `tier ${result.tier}`));
    if (onModify) footerParts.push(el('a', { onclick: onModify }, 'Modifier les champs'));
    footerParts.push(renderCredit());
    card.appendChild(el('div', { class: 'chh-footer' }, ...footerParts));
  }

  function landConfidenceClass(score) {
    if (score >= 70) return 'chh-conf-green';
    if (score >= 40) return 'chh-conf-yellow';
    return 'chh-conf-red';
  }

  function geoportailLink(lon, lat) {
    return `https://www.geoportail.gouv.fr/carte?c=${lon.toFixed(6)},${lat.toFixed(6)}&z=19&l0=CADASTRALPARCELS.PARCELLAIRE_EXPRESS::GEOPORTAIL:OGC:WMTS(1)&permalink=yes`;
  }

  function cadastreOrthoLink(lon, lat) {
    return `https://www.geoportail.gouv.fr/carte?c=${lon.toFixed(6)},${lat.toFixed(6)}&z=20&l0=ORTHOIMAGERY.ORTHOPHOTOS::GEOPORTAIL:OGC:WMTS(1)&l1=CADASTRALPARCELS.PARCELLAIRE_EXPRESS::GEOPORTAIL:OGC:WMTS(0.7)&permalink=yes`;
  }

  function gmapsCoordLink(lon, lat) {
    return `https://www.google.com/maps?q=${lat.toFixed(6)},${lon.toFixed(6)}`;
  }

  function showLandResult(payload, result, onModify) {
    const card = ensureCard();
    card.innerHTML = '';
    renderHeader(card);
    renderFields(card, payload);

    if (!result || !result.candidates || result.candidates.length === 0) {
      card.appendChild(
        el(
          'div',
          { class: 'chh-empty' },
          'Aucune parcelle trouvée dans le cadastre IGN pour ces critères.'
        )
      );
      const footer = el('div', { class: 'chh-footer' });
      if (onModify) footer.appendChild(el('a', { onclick: onModify }, 'Modifier les champs'));
      footer.appendChild(renderCredit());
      card.appendChild(footer);
      return;
    }

    const top = result.candidates[0];
    const conf = landConfidenceClass(top.score);
    const parcel = top.parcel;
    const topBox = el('div', { class: `chh-top ${conf}` });

    const addressLine = parcel.address || parcel.street || '(adresse approximative)';
    topBox.appendChild(el('div', { class: 'chh-address' }, addressLine));
    topBox.appendChild(renderCopyBtn([addressLine, parcel.nom_com].filter(Boolean).join(', ')));

    const metaParts = [];
    if (parcel.nom_com) metaParts.push(parcel.nom_com);
    if (parcel.codeInsee) metaParts.push(`INSEE ${parcel.codeInsee}`);
    if (parcel.contenance != null) metaParts.push(`${parcel.contenance} m²`);
    topBox.appendChild(el('div', { class: 'chh-meta' }, metaParts.join(' • ')));

    const idLine = el('div', { class: 'chh-parcel-id' });
    const idParts = [];
    if (parcel.idu) idParts.push(parcel.idu);
    const sn = [];
    if (parcel.section) sn.push(`section ${parcel.section}`);
    if (parcel.numero) sn.push(`n°${parcel.numero}`);
    if (sn.length > 0) idParts.push(sn.join(' '));
    idLine.textContent = idParts.join(' — ');
    topBox.appendChild(idLine);

    const confLabel =
      top.score >= 70 ? 'Confiance élevée' : top.score >= 40 ? 'Confiance moyenne' : 'Confiance faible';
    topBox.appendChild(
      el(
        'div',
        { class: 'chh-confidence' },
        el('span', { class: 'chh-dot' }),
        `${confLabel} (${top.score}/100)`
      )
    );

    const links = el('div', { class: 'chh-links' });
    if (Array.isArray(parcel.centroid)) {
      const [lon, lat] = parcel.centroid;
      links.appendChild(
        el(
          'a',
          { href: gmapsCoordLink(lon, lat), target: '_blank', rel: 'noopener noreferrer' },
          'Google Maps'
        )
      );
      links.appendChild(
        el(
          'a',
          { href: geoportailLink(lon, lat), target: '_blank', rel: 'noopener noreferrer' },
          'Géoportail'
        )
      );
    }
    if (Array.isArray(parcel.centroid)) {
      const [lon, lat] = parcel.centroid;
      links.appendChild(
        el(
          'a',
          {
            href: cadastreOrthoLink(lon, lat),
            target: '_blank',
            rel: 'noopener noreferrer',
            title: 'Orthophoto + cadastre superposé',
          },
          'Cadastre + photo'
        )
      );
    }
    topBox.appendChild(links);
    card.appendChild(topBox);

    const alts = result.candidates.slice(1);
    if (alts.length > 0) {
      const details = el(
        'details',
        { class: 'chh-alts' },
        el('summary', null, `Autres parcelles (${alts.length})`)
      );
      for (const alt of alts) {
        const ap = alt.parcel;
        const altAddress = ap.address || ap.street || '(adresse approximative)';
        const row = el(
          'div',
          { class: 'chh-alt-row' },
          el('div', { class: 'chh-alt-address' }, altAddress),
          el(
            'div',
            { class: 'chh-meta' },
            [
              ap.nom_com,
              ap.contenance != null ? `${ap.contenance} m²` : null,
              ap.section ? `section ${ap.section}` : null,
              ap.numero ? `n°${ap.numero}` : null,
              `score ${alt.score}`,
            ]
              .filter(Boolean)
              .join(' • ')
          )
        );
        if (ap.idu) row.appendChild(el('div', { class: 'chh-parcel-id' }, ap.idu));
        if (alt.diffs && alt.diffs.length > 0) {
          row.appendChild(el('div', { class: 'chh-alt-diffs' }, '≠ ' + alt.diffs.join(' ; ')));
        }
        if (Array.isArray(ap.centroid)) {
          const [lon, lat] = ap.centroid;
          const altLinks = el(
            'div',
            { class: 'chh-links' },
            el('a', { href: gmapsCoordLink(lon, lat), target: '_blank', rel: 'noopener noreferrer' }, 'Maps'),
            el('a', { href: geoportailLink(lon, lat), target: '_blank', rel: 'noopener noreferrer' }, 'Géoportail')
          );
          row.appendChild(altLinks);
        }
        details.appendChild(row);
      }
      card.appendChild(details);
    }

    const footerParts = [];
    if (result.cached) footerParts.push(el('span', null, 'cache'));
    if (result.matchMethod === 'ademe') {
      footerParts.push(el('span', null, 'source : registre DPE'));
    } else if (result.matchMethod === 'cadastre') {
      footerParts.push(el('span', null, 'source : cadastre IGN'));
    }
    if (result.tier != null) footerParts.push(el('span', null, `tier ${result.tier}`));
    if (result.total != null) footerParts.push(el('span', null, `${result.total} candidat(s)`));
    if (onModify) footerParts.push(el('a', { onclick: onModify }, 'Modifier les champs'));
    footerParts.push(renderCredit());
    card.appendChild(el('div', { class: 'chh-footer' }, ...footerParts));
  }

  function injectButton(anchor, label, onClick) {
    if (!anchor || anchor.querySelector('.chh-btn')) return null;
    const btn = el('button', { class: 'chh-btn', type: 'button' }, label);
    btn.addEventListener('click', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      onClick(btn);
    });
    anchor.appendChild(btn);
    return btn;
  }

  let floatingBtnState = null;

  function buildFloatingBtn(label, onClick) {
    const btn = el(
      'button',
      {
        class: 'chh-btn chh-floating-btn',
        type: 'button',
        id: 'chh-floating-btn',
        title: label,
        'aria-label': label,
      },
      label
    );
    btn.style.cssText = 'position:fixed!important;right:18px!important;bottom:18px!important;z-index:2147483646!important;visibility:visible!important;opacity:1!important;display:inline-flex!important;';
    btn.addEventListener('click', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      onClick(btn);
    });
    return btn;
  }

  function mountFloatingButton(label, onClick) {
    if (floatingBtnState) {
      floatingBtnState.label = label;
      floatingBtnState.onClick = onClick;
    } else {
      floatingBtnState = { label, onClick, observer: null };
    }

    const ensureInDom = () => {
      if (!document.body) return null;
      const existing = document.getElementById('chh-floating-btn');
      if (existing && existing.isConnected) return existing;
      const fresh = buildFloatingBtn(floatingBtnState.label, floatingBtnState.onClick);
      document.body.appendChild(fresh);
      return fresh;
    };

    const btn = ensureInDom();

    if (!floatingBtnState.observer && typeof MutationObserver !== 'undefined') {
      const obs = new MutationObserver(() => {
        const inDom = document.getElementById('chh-floating-btn');
        if (!inDom || !inDom.isConnected) ensureInDom();
      });
      try {
        obs.observe(document.documentElement, { childList: true, subtree: true });
        floatingBtnState.observer = obs;
      } catch (e) {
        // ignore
      }
    }

    return btn;
  }

  function resetFloatingButton() {
    const existing = document.getElementById('chh-floating-btn');
    if (existing && existing.parentNode) existing.parentNode.removeChild(existing);
    if (floatingBtnState) {
      const fresh = buildFloatingBtn(floatingBtnState.label, floatingBtnState.onClick);
      (document.body || document.documentElement).appendChild(fresh);
      return fresh;
    }
    return null;
  }

  // ─── Floating Container (Material Design, bas-gauche) ────────────────────

  let _fcClickHandler = null;
  let _fcObserver = null;

  function _getOrCreateFc() {
    if (!document.body) return null;
    let fc = document.getElementById('chh-floating-container');
    if (!fc || !fc.isConnected) {
      fc = document.createElement('div');
      fc.id = 'chh-floating-container';
      document.body.appendChild(fc);
    }
    if (!_fcObserver && typeof MutationObserver !== 'undefined') {
      _fcObserver = new MutationObserver(() => {
        const inDom = document.getElementById('chh-floating-container');
        if (!inDom || !inDom.isConnected) _getOrCreateFc();
      });
      try { _fcObserver.observe(document.documentElement, { childList: true, subtree: false }); } catch (e) {}
    }
    return fc;
  }

  function _fcReset(className) {
    const fc = _getOrCreateFc();
    if (!fc) return null;
    fc.className = 'chh-floating-container ' + className;
    fc.innerHTML = '';
    if (_fcClickHandler) {
      fc.removeEventListener('click', _fcClickHandler);
      _fcClickHandler = null;
    }
    fc.removeAttribute('title');
    return fc;
  }

  // — Drag & drop + position mémoire par hostname —

  let _fcDragInit = false;

  function _initDraggable(fc) {
    if (_fcDragInit) return;
    _fcDragInit = true;
    let dragging = false;
    let ox = 0, oy = 0;
    function onMouseDown(ev) {
      if (ev.target.closest('a, button, input, .chh-fc-address-text, .chh-fc-copy-addr')) return;
      dragging = true;
      const r = fc.getBoundingClientRect();
      ox = ev.clientX - r.left;
      oy = ev.clientY - r.top;
      fc.style.setProperty('bottom', 'auto', 'important');
      fc.style.setProperty('right', 'auto', 'important');
      fc.style.setProperty('left', r.left + 'px', 'important');
      fc.style.setProperty('top', r.top + 'px', 'important');
      fc.style.setProperty('cursor', 'grabbing', 'important');
      ev.preventDefault();
    }
    function onMouseMove(ev) {
      if (!dragging) return;
      const nl = Math.max(0, Math.min(ev.clientX - ox, window.innerWidth - fc.offsetWidth));
      const nt = Math.max(0, Math.min(ev.clientY - oy, window.innerHeight - fc.offsetHeight));
      fc.style.setProperty('left', nl + 'px', 'important');
      fc.style.setProperty('top', nt + 'px', 'important');
    }
    function onMouseUp() {
      if (!dragging) return;
      dragging = false;
      fc.style.setProperty('cursor', 'grab', 'important');
      try {
        localStorage.setItem('chh.pos.' + location.hostname,
          JSON.stringify({ left: fc.style.left, top: fc.style.top }));
      } catch (e) {}
    }
    fc.addEventListener('mousedown', onMouseDown);
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
    fc.style.setProperty('cursor', 'grab', 'important');
  }

  function _restoreSavedPosition(fc) {
    try {
      const raw = localStorage.getItem('chh.pos.' + location.hostname);
      if (!raw) return;
      const pos = JSON.parse(raw);
      if (pos && pos.left && pos.top) {
        fc.style.setProperty('bottom', 'auto', 'important');
        fc.style.setProperty('right', 'auto', 'important');
        fc.style.setProperty('left', pos.left, 'important');
        fc.style.setProperty('top', pos.top, 'important');
      }
    } catch (e) {}
  }

  // — Helpers de rendu partagés —

  function _createRows(fc) {
    const topRow = document.createElement('div');
    topRow.className = 'chh-fc-row chh-fc-row-top';
    fc.appendChild(topRow);
    const bottomRow = document.createElement('div');
    bottomRow.className = 'chh-fc-row chh-fc-row-bottom';
    fc.appendChild(bottomRow);
    const dvfRow = document.createElement('div');
    dvfRow.className = 'chh-fc-row chh-fc-row-dvf';
    fc.appendChild(dvfRow);
    return { topRow, bottomRow, dvfRow };
  }

  function _renderChhBadge(row, type, excludedTerm = null) {
    const wrap = document.createElement('span');
    const badgeType = excludedTerm ? 'excluded' : type;
    wrap.className = 'chh-fc-chh-label chh-fc-chh-badge-' + badgeType;
    const icon = document.createElement('span');
    icon.className = 'chh-fc-chh-icon chh-fc-chh-' + badgeType;
    if (excludedTerm || badgeType === 'excluded') {
      icon.textContent = '✖';
      wrap.style.cssText = 'background: linear-gradient(135deg, #6b7280 0%, #4b5563 100%) !important; border: 1px solid #374151 !important; color: #fff !important;';
    } else if (badgeType === 'match') {
      icon.textContent = '✔︎';
    } else if (badgeType === 'loading') {
      icon.textContent = '⟳';
    } else {
      icon.textContent = '○';
    }
    const txt = document.createElement('span');
    txt.textContent = excludedTerm ? `CHH (${excludedTerm})` : 'CHH';
    wrap.appendChild(icon);
    wrap.appendChild(txt);
    if (excludedTerm) {
      wrap.title = `Annonce masquée (contient le terme : "${excludedTerm}")`;
    }
    row.appendChild(wrap);

    return wrap;
  }

  function _renderAddress(row, addressText, mapsUrl, score, candidates) {
    const addrContainer = document.createElement('div');
    addrContainer.className = 'chh-fc-addr-container';

    const addrWrap = document.createElement('div');
    addrWrap.className = 'chh-fc-addr-wrap';

    const finalMapsUrl = mapsUrl || (addressText && addressText !== 'Adresse non trouvée' ? 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(addressText) : null);

    const addrSpan = document.createElement('span');
    addrSpan.className = 'chh-fc-address-text' + (addressText === 'Adresse non trouvée' ? ' chh-fc-no-address-text' : '');
    if (addressText !== 'Adresse non trouvée') {
      addrSpan.innerHTML = addressText.replace(/(,?\s+)(\d{5}\b)/, '<br>$2');
    } else {
      addrSpan.textContent = addressText;
    }
    addrSpan.style.cursor = addressText !== 'Adresse non trouvée' ? 'text' : 'inherit';
    addrSpan.style.userSelect = addressText !== 'Adresse non trouvée' ? 'text' : 'none';
    addrWrap.appendChild(addrSpan);

    if (addressText !== 'Adresse non trouvée') {
      const actionsWrap = document.createElement('span');
      actionsWrap.className = 'chh-fc-addr-actions';
      actionsWrap.style.cssText = 'display:inline-flex;gap:4px;margin-left:6px;align-items:center;flex-shrink:0;';
      
      const copyBtn = document.createElement('button');
      copyBtn.className = 'chh-fc-copy-addr';
      copyBtn.innerHTML = '&#x2398;';
      copyBtn.title = 'Copier l\'adresse';
      copyBtn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        navigator.clipboard.writeText(addressText).then(() => {
          copyBtn.innerHTML = '✓';
          setTimeout(() => { copyBtn.innerHTML = '&#x2398;'; }, 2000);
        });
      });
      actionsWrap.appendChild(copyBtn);

      if (finalMapsUrl) {
        const pinLink = document.createElement('a');
        pinLink.className = 'chh-fc-notion-link chh-fc-maps-pin-link';
        pinLink.href = finalMapsUrl;
        pinLink.target = '_blank';
        pinLink.rel = 'noopener noreferrer';
        pinLink.textContent = 'Maps ↗';
        pinLink.title = 'Ouvrir dans Google Maps';
        pinLink.addEventListener('click', (ev) => ev.stopPropagation());
        actionsWrap.appendChild(pinLink);
      }
      
      addrWrap.appendChild(actionsWrap);
    }
    addrContainer.appendChild(addrWrap);

    if (score !== undefined && addressText !== 'Adresse non trouvée') {
      const subAddr = document.createElement('div');
      subAddr.className = 'chh-fc-sub-addr';

      const suppSpan = document.createElement('span');
      suppSpan.className = 'chh-fc-supposition';
      suppSpan.textContent = 'Confiance : ' + score + '%';
      subAddr.appendChild(suppSpan);

      const alts = candidates ? candidates.slice(1) : [];
      if (alts.length > 0) {
        const sep = document.createElement('span');
        sep.className = 'chh-fc-sub-sep';
        sep.textContent = '•';
        subAddr.appendChild(sep);

        const altBtn = document.createElement('button');
        altBtn.className = 'chh-fc-alt-btn';
        altBtn.textContent = 'Alternatives (' + alts.length + ')';
        altBtn.title = 'Afficher les autres adresses candidates';
        altBtn.addEventListener('click', (ev) => {
          ev.preventDefault();
          ev.stopPropagation();

          let altList = addrContainer.querySelector('.chh-fc-alt-list');
          if (altList) {
            altList.remove();
            altBtn.textContent = 'Alternatives (' + alts.length + ')';
          } else {
            altList = document.createElement('div');
            altList.className = 'chh-fc-alt-list';

            alts.forEach((alt) => {
              const altRow = document.createElement('div');
              altRow.className = 'chh-fc-alt-row';

              const altAddressText = alt.record.address || '(adresse inconnue)';

              const altSpan = document.createElement('span');
              altSpan.className = 'chh-fc-address-text';
              altSpan.innerHTML = altAddressText.replace(/(,?\s+)(\d{5}\b)/, '<br>$2') + 
                ` <span style="opacity: 0.7; font-size: 11px; font-weight: normal; margin-left: 4px; white-space: nowrap;">(${alt.score}%)</span>`;
              altSpan.style.cursor = 'text';
              altSpan.style.userSelect = 'text';
              altRow.appendChild(altSpan);

              const actionsWrap = document.createElement('span');
              actionsWrap.className = 'chh-fc-addr-actions';
              actionsWrap.style.cssText = 'display:inline-flex;gap:4px;margin-left:6px;align-items:center;flex-shrink:0;';

              const copyBtn = document.createElement('button');
              copyBtn.className = 'chh-fc-copy-addr';
              copyBtn.innerHTML = '&#x2398;';
              copyBtn.title = 'Copier l\'adresse';
              copyBtn.addEventListener('click', (ev) => {
                ev.stopPropagation();
                navigator.clipboard.writeText(altAddressText).then(() => {
                  copyBtn.innerHTML = '✓';
                  setTimeout(() => { copyBtn.innerHTML = '&#x2398;'; }, 2000);
                });
              });
              actionsWrap.appendChild(copyBtn);

              const altMapsUrl = 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(altAddressText);
              const pinLink = document.createElement('a');
              pinLink.className = 'chh-fc-notion-link chh-fc-maps-pin-link';
              pinLink.href = altMapsUrl;
              pinLink.target = '_blank';
              pinLink.rel = 'noopener noreferrer';
              pinLink.textContent = 'Maps ↗';
              pinLink.title = 'Ouvrir dans Google Maps';
              pinLink.addEventListener('click', (ev) => ev.stopPropagation());
              actionsWrap.appendChild(pinLink);

              altRow.appendChild(actionsWrap);

              altList.appendChild(altRow);
            });

            addrContainer.appendChild(altList);
            altBtn.textContent = 'Masquer alternatives';
          }
        });
        subAddr.appendChild(altBtn);
      }
      addrContainer.appendChild(subAddr);
    }
    row.appendChild(addrContainer);
  }

  // — API publique du floating container —

  function mountFloatingContainer(label, onClick) {
    const fc = _fcReset('chh-fc-btn');
    if (!fc) return null;
    const { topRow, bottomRow, dvfRow } = _createRows(fc);
    _renderChhBadge(topRow, 'nomatch');
    const btn = document.createElement('button');
    btn.className = 'chh-fc-find-btn';
    btn.textContent = label;
    btn.addEventListener('click', (ev) => { ev.preventDefault(); ev.stopPropagation(); onClick(); });
    topRow.appendChild(btn);
    _renderAddress(bottomRow, 'Adresse non trouvée');
    dvfRow.style.display = 'none';
    _initDraggable(fc);
    _restoreSavedPosition(fc);
    return fc;
  }

  function setFloatingContainerLoading(label) {
    const fc = _fcReset('chh-fc-loading');
    if (!fc) return null;
    const { topRow, bottomRow, dvfRow } = _createRows(fc);
    _renderChhBadge(topRow, 'loading');
    const spinner = document.createElement('span');
    spinner.className = 'chh-fc-spinner';
    topRow.appendChild(spinner);
    const text = document.createElement('span');
    text.className = 'chh-fc-loading-text';
    text.textContent = label || 'Analyse en cours…';
    topRow.appendChild(text);
    bottomRow.style.display = 'none';
    dvfRow.style.display = 'none';
    _initDraggable(fc);
    _restoreSavedPosition(fc);
    return fc;
  }

  function sendMessageSafe(message) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error('Délai dépassé (timeout 15s) lors de la communication avec l’extension.'));
      }, 15000);

      try {
        chrome.runtime.sendMessage(message, (res) => {
          clearTimeout(timer);
          const err = chrome.runtime.lastError;
          if (err) {
            return reject(new Error(err.message || 'Erreur de communication avec l’extension.'));
          }
          resolve(res);
        });
      } catch (e) {
        clearTimeout(timer);
        reject(e);
      }
    });
  }

  function setFloatingContainerAddress({ address, score, confidence, mapsUrl, candidates, dvfPrice, dvfDate, getPayload, onSaveNotion, isNotionAddress }) {
    const fc = _fcReset('chh-fc-address');
    if (!fc) return null;
    const { topRow, bottomRow, dvfRow } = _createRows(fc);

    const mainListingText = getListingMainText(getPayload);
    const fcExcludedTerm = findExcludedTermInText(mainListingText);

    if (fcExcludedTerm) {
      _renderChhBadge(topRow, 'excluded', fcExcludedTerm);
    } else {
      _renderChhBadge(topRow, 'nomatch');
    }

    if (getPayload || onSaveNotion) {
      const saveBtn = document.createElement('button');
      saveBtn.className = 'chh-fc-notion-save-btn';
      saveBtn.textContent = 'Non sauvegardé 💾';
      saveBtn.title = 'Enregistrer cette annonce dans Notion';
      saveBtn.addEventListener('click', async (ev) => {
        ev.preventDefault();
        ev.stopPropagation();

        if (saveBtn.disabled) return;
        saveBtn.disabled = true;
        saveBtn.textContent = '⏳ Enregistrement…';

        try {
          if (onSaveNotion) {
            await onSaveNotion();
          } else if (getPayload) {
            const rawPayload = typeof getPayload === 'function' ? getPayload() : (getPayload || {});
            const cleanPayload = {};
            for (const [k, v] of Object.entries(rawPayload)) {
              if (v !== null && v !== undefined && typeof v !== 'function' && typeof v !== 'symbol' && !(v instanceof Element) && !(v instanceof Node)) {
                cleanPayload[k] = v;
              }
            }
            if (address && !cleanPayload.address) cleanPayload.address = address;
            if (dvfPrice && !cleanPayload.dvfPrice) cleanPayload.dvfPrice = dvfPrice;
            if (dvfDate && !cleanPayload.dvfDate) cleanPayload.dvfDate = dvfDate;

            const safePayload = JSON.parse(JSON.stringify(cleanPayload));
            const res = await sendMessageSafe({ type: 'SAVE_TO_NOTION', payload: safePayload });

            if (res && res.ok && res.result && res.result.match) {
              saveBtn.textContent = '✓ Enregistré';
              setTimeout(() => {
                setFloatingContainerChh(res.result.match);
              }, 400);
            } else {
              const errMsg = res?.error || 'Erreur lors de la sauvegarde dans Notion.';
              alert('Erreur Notion : ' + errMsg);
              saveBtn.disabled = false;
              saveBtn.textContent = 'Non sauvegardé 💾';
            }
          }
        } catch (err) {
          alert('Erreur Notion : ' + (err.message || String(err)));
          saveBtn.disabled = false;
          saveBtn.textContent = 'Non sauvegardé 💾';
        }
      });
      topRow.appendChild(saveBtn);
    } else {
      const asideTxt = document.createElement('span');
      asideTxt.className = 'chh-fc-status-aside';
      asideTxt.textContent = 'Non sauvegardé';
      topRow.appendChild(asideTxt);
    }

    const finalScore = isNotionAddress ? undefined : (score !== undefined ? score : confidence);
    const finalCandidates = isNotionAddress ? undefined : candidates;
    const finalMapsUrl = mapsUrl || (address && address !== 'Adresse non trouvée' ? 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(address) : null);

    if (address) {
      _renderAddress(bottomRow, address, finalMapsUrl, finalScore, finalCandidates);
    } else {
      _renderAddress(bottomRow, 'Adresse non trouvée');
    }
    
    if (dvfPrice) {
      const icon = document.createElement('span');
      icon.className = 'chh-fc-icon';
      icon.textContent = '🏷️';
      dvfRow.appendChild(icon);
      
      const dvfSpan = document.createElement('span');
      dvfSpan.className = 'chh-fc-dvf';
      const fp = new Intl.NumberFormat('fr-FR', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 }).format(dvfPrice).replace(/[\u202f\u00a0]/g, ' ');
      const fd = dvfDate ? new Date(dvfDate).toLocaleDateString('fr-FR') : '';
      dvfSpan.textContent = fp + (fd ? ' (' + fd + ')' : '');
      dvfSpan.title = 'Dernier prix de vente enregistré dans DVF' + (fd ? ' le ' + fd : '');
      dvfRow.appendChild(dvfSpan);
    } else {
      const icon = document.createElement('span');
      icon.className = 'chh-fc-icon';
      icon.textContent = '🏷️';
      dvfRow.appendChild(icon);

      const dvfSpan = document.createElement('span');
      dvfSpan.className = 'chh-fc-dvf chh-fc-no-dvf-text';
      dvfSpan.textContent = 'DVF non trouvé';
      dvfRow.appendChild(dvfSpan);
    }

    _initDraggable(fc);
    _restoreSavedPosition(fc);
    return fc;
  }

  function setFloatingContainerChh(match, onFindAddress) {
    const fc = _fcReset('chh-fc-chh');
    if (!fc) return null;
    const { topRow, bottomRow, dvfRow } = _createRows(fc);
    
    const mainListingText = getListingMainText(match);
    const fcExcludedTerm = findExcludedTermInText(mainListingText);

    if (fcExcludedTerm) {
      _renderChhBadge(topRow, 'excluded', fcExcludedTerm);
    } else {
      _renderChhBadge(topRow, 'match');
    }
    
    // Lien Notion explicite sur la ligne 1
    const notionLink = document.createElement('a');
    notionLink.className = 'chh-fc-notion-link';
    notionLink.href = match.url;
    notionLink.target = '_blank';
    notionLink.rel = 'noopener noreferrer';
    notionLink.textContent = 'Notion ↗';
    let titleText = 'Ouvrir la fiche dans Notion';
    if (match.rawPrevPrices) titleText += '\nPrix précédents : ' + match.rawPrevPrices;
    if (match.rawOtherSurfaces) titleText += '\nAutres surfaces : ' + match.rawOtherSurfaces;
    notionLink.title = titleText;
    notionLink.addEventListener('click', (ev) => ev.stopPropagation());
    topRow.appendChild(notionLink);

    // Ligne 2 : Adresse
    // Priorité : adresse Notion > recherche automatique > non trouvée
    if (match.address) {
      const mapsUrl = 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(match.address);
      const isNotionAddr = match.isNotionAddress !== undefined ? match.isNotionAddress : true;
      const scoreToPass = isNotionAddr ? undefined : match.score;
      const candidatesToPass = isNotionAddr ? undefined : match.candidates;
      _renderAddress(bottomRow, match.address, mapsUrl, scoreToPass, candidatesToPass);
    } else if (typeof onFindAddress === 'function') {
      // Pas d'adresse dans Notion → afficher un bouton pour déclencher la recherche
      const icon = document.createElement('span');
      icon.className = 'chh-fc-icon';
      icon.textContent = '📍';
      bottomRow.appendChild(icon);
      const findBtn = document.createElement('button');
      findBtn.className = 'chh-fc-find-btn';
      findBtn.textContent = 'Rechercher l\'adresse';
      findBtn.addEventListener('click', (ev) => { ev.preventDefault(); ev.stopPropagation(); onFindAddress(); });
      bottomRow.appendChild(findBtn);
    } else {
      _renderAddress(bottomRow, 'Adresse non trouvée');
    }

    // Ligne 3 : DVF
    if (match.dvfPrice) {
      // Icône d'étiquette simple, non cliquable
      const icon = document.createElement('span');
      icon.className = 'chh-fc-icon';
      icon.textContent = '🏷️';
      dvfRow.appendChild(icon);
      
      const dvfSpan = document.createElement('span');
      dvfSpan.className = 'chh-fc-dvf';
      const fp = new Intl.NumberFormat('fr-FR', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 }).format(match.dvfPrice).replace(/[\u202f\u00a0]/g, ' ');
      const fd = match.dvfDate ? new Date(match.dvfDate).toLocaleDateString('fr-FR') : '';
      dvfSpan.textContent = fp + (fd ? ' (' + fd + ')' : '');
      dvfSpan.title = 'Dernier prix de vente enregistré dans DVF' + (fd ? ' le ' + fd : '');
      dvfRow.appendChild(dvfSpan);
    } else {
      const icon = document.createElement('span');
      icon.className = 'chh-fc-icon';
      icon.textContent = '🏷️';
      dvfRow.appendChild(icon);

      const dvfSpan = document.createElement('span');
      dvfSpan.className = 'chh-fc-dvf chh-fc-no-dvf-text';
      dvfSpan.textContent = 'DVF non trouvé';
      dvfRow.appendChild(dvfSpan);
    }

    _initDraggable(fc);
    _restoreSavedPosition(fc);
    return fc;
  }

  function removeFloatingContainer() {
    const existing = document.getElementById('chh-floating-container');
    if (existing && existing.parentNode) existing.parentNode.removeChild(existing);
    _fcClickHandler = null;
    _fcDragInit = false;
    if (_fcObserver) { _fcObserver.disconnect(); _fcObserver = null; }
  }


  function onNavigate(cb) {
    let lastUrl = location.href;
    const fire = () => {
      if (location.href !== lastUrl) {
        const prev = lastUrl;
        lastUrl = location.href;
        try { cb(prev, lastUrl); } catch (e) { /* ignore */ }
      }
    };
    window.addEventListener('popstate', fire);
    window.addEventListener('hashchange', fire);
    setInterval(fire, 250);
    return () => {
      window.removeEventListener('popstate', fire);
      window.removeEventListener('hashchange', fire);
    };
  }

  function hasExistingBadge(cardEl) {
    if (!cardEl) return true;
    if (cardEl.querySelector('.chh-card-chh-badge') || (cardEl.classList && cardEl.classList.contains('chh-card-chh-badge'))) {
      return true;
    }
    if (cardEl.dataset && (cardEl.dataset.chhHasBadge === 'true' || cardEl.dataset.chhExcluded)) {
      return true;
    }
    return false;
  }

  function markCardAsMatched(cardEl, match, forceNoOpacity = false) {
    if (!cardEl) return;
    if (hasExistingBadge(cardEl)) return;

    cardEl.dataset.chhHasBadge = 'true';
    cardEl.classList.add('chh-card-has-badge');

    const isPopup = forceNoOpacity || 
                    cardEl.classList.contains('leaflet-popup') || 
                    cardEl.classList.contains('leaflet-popup-content-wrapper') ||
                    cardEl.classList.contains('mapboxgl-popup') ||
                    cardEl.classList.contains('mapboxgl-popup-content') ||
                    cardEl.classList.contains('gm-style-iw') ||
                    cardEl.classList.contains('gm-style-iw-c') ||
                    /popup/i.test(cardEl.className || '') ||
                    cardEl.closest('.leaflet-popup, .mapboxgl-popup, .gm-style-iw, [class*="popup" i]') !== null;

    if (!isPopup) {
      cardEl.style.setProperty('opacity', '0.4', 'important');
      cardEl.style.transition = 'opacity 0.25s ease';
    }
    
    if (!cardEl.querySelector('.chh-card-chh-badge')) {
      const badge = document.createElement('a');
      badge.className = 'chh-card-chh-badge';
      badge.href = match.url;
      badge.target = '_blank';
      badge.rel = 'noopener noreferrer';
      badge.textContent = '✔︎ CHH';
      badge.title = 'Ce bien est déjà enregistré dans Notion (cliquez pour ouvrir)';
      badge.addEventListener('click', (ev) => ev.stopPropagation());
      
      badge.addEventListener('mouseenter', () => {
        badge.style.transform = 'scale(1.06)';
      });
      badge.addEventListener('mouseleave', () => {
        badge.style.transform = 'scale(1)';
      });

      const isTableRow = cardEl.tagName === 'TR';
      if (isTableRow) {
        badge.style.cssText = `
          display: inline-flex !important;
          align-items: center !important;
          gap: 4px !important;
          padding: 2px 7px !important;
          margin-right: 8px !important;
          vertical-align: middle !important;
          font-size: 11px !important;
          font-weight: 700 !important;
          color: #fff !important;
          background: linear-gradient(135deg, #f97316 0%, #d97706 100%) !important;
          border: 1px solid #b45309 !important;
          border-radius: 4px !important;
          text-decoration: none !important;
          box-shadow: 0 1px 3px rgba(0, 0, 0, 0.2) !important;
          pointer-events: auto !important;
          font-family: system-ui, -apple-system, sans-serif !important;
          transition: transform 0.15s ease !important;
        `;

        const targetCell = cardEl.querySelector('.col-titre, [data-column="titre"], td:nth-child(2), td');
        if (targetCell) {
          targetCell.insertBefore(badge, targetCell.firstChild);
        } else {
          cardEl.appendChild(badge);
        }
      } else {
        badge.style.cssText = `
          position: absolute !important;
          top: 10px !important;
          left: 10px !important;
          z-index: 999999 !important;
          display: inline-flex !important;
          align-items: center !important;
          gap: 4px !important;
          padding: 4px 10px !important;
          font-size: 11.5px !important;
          font-weight: 700 !important;
          color: #fff !important;
          background: linear-gradient(135deg, #f97316 0%, #d97706 100%) !important;
          border: 1px solid #b45309 !important;
          border-radius: 4px !important;
          text-decoration: none !important;
          box-shadow: 0 2px 6px rgba(0, 0, 0, 0.25) !important;
          pointer-events: auto !important;
          font-family: system-ui, -apple-system, sans-serif !important;
          transition: transform 0.15s ease !important;
        `;

        const currentStyle = window.getComputedStyle(cardEl);
        if (currentStyle.position === 'static') {
          cardEl.style.position = 'relative';
        }
        cardEl.appendChild(badge);
      }
    }

    if (!isPopup) {
      cardEl.addEventListener('mouseenter', () => {
        cardEl.style.setProperty('opacity', '0.95', 'important');
      });
      cardEl.addEventListener('mouseleave', () => {
        cardEl.style.setProperty('opacity', '0.4', 'important');
      });
    }
  }

  // ── Excluded Terms Management ──────────────────────────────────────────

  const DEFAULT_EXCLUDED_TERMS = ['Courtarelles', 'Courtarelle', 'Estanove', 'Aiguelongue', 'Seigneurs', 'Domaine des Oliviers', 'Jacou', 'Clapiers', 'Caylus', 'Celleneuve', 'Védas'];
  let cachedExcludedTerms = [...DEFAULT_EXCLUDED_TERMS];

  if (typeof chrome !== 'undefined' && chrome && chrome.storage && chrome.storage.local) {
    chrome.storage.local.get(['excludedTerms'], (res) => {
      if (res && Array.isArray(res.excludedTerms) && res.excludedTerms.length > 0) {
        cachedExcludedTerms = res.excludedTerms;
      }
    });
    chrome.storage.onChanged.addListener((changes, areaName) => {
      if (areaName === 'local' && changes.excludedTerms) {
        if (Array.isArray(changes.excludedTerms.newValue) && changes.excludedTerms.newValue.length > 0) {
          cachedExcludedTerms = changes.excludedTerms.newValue;
        } else {
          cachedExcludedTerms = [...DEFAULT_EXCLUDED_TERMS];
        }
      }
    });
  }

  function getExcludedTerms() {
    return cachedExcludedTerms;
  }

  function normalizeForMatching(str) {
    return (str || '')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase();
  }

  function findExcludedTermInText(text) {
    if (!text) return null;
    const normalizedText = normalizeForMatching(text);
    let bestTerm = null;
    let earliestPos = Infinity;

    for (const rawTerm of cachedExcludedTerms) {
      if (!rawTerm || !rawTerm.trim()) continue;
      const term = rawTerm.trim();
      const normalizedTerm = normalizeForMatching(term);
      const pos = normalizedText.indexOf(normalizedTerm);
      if (pos !== -1 && pos < earliestPos) {
        earliestPos = pos;
        bestTerm = term;
      }
    }
    return bestTerm;
  }

  function isInsideSimilarOrFooterSection(el) {
    if (!el) return false;
    if (el.closest('footer, nav, aside')) return true;
    if (el.closest('[class*="similar" i], [class*="recommend" i], [class*="related" i], [class*="suggestion" i], [class*="carousel" i]')) return true;
    if (el.closest('[data-testid*="similar" i], [data-qa-id*="similar" i], [data-testid*="recommend" i]')) return true;
    
    let parent = el.parentElement;
    let depth = 0;
    while (parent && depth < 6 && parent !== document.body) {
      const heading = parent.querySelector('h1, h2, h3, h4, [class*="title" i], [class*="heading" i]');
      if (heading && heading !== el) {
        const headingText = (heading.innerText || heading.textContent || '').toLowerCase();
        if (/pourraient vous intéresser|annonces similaires|biens similaires|vous aimerez aussi|dans la même ville|offres similaires|biens recommandés|sélection d'annonces|d'autres biens|à voir aussi/i.test(headingText)) {
          return true;
        }
      }
      parent = parent.parentElement;
      depth++;
    }
    return false;
  }

  function getListingMainText(payloadOrMatch) {
    let payloadText = '';
    if (payloadOrMatch) {
      let pObj = payloadOrMatch;
      if (typeof pObj === 'function') {
        try { pObj = pObj(); } catch (e) {}
      }
      if (pObj && typeof pObj === 'object') {
        payloadText = [
          pObj.title,
          pObj.city,
          pObj.address,
          pObj.description,
          pObj.url
        ].filter(Boolean).join(' ');
      }
    }
    const mainEls = document.querySelectorAll('h1, h2, h3, [class*="title" i], [class*="location" i], [class*="address" i], [class*="description" i], [data-testid*="description" i], [data-qa-id*="description" i]');
    let domText = '';
    for (const el of mainEls) {
      if (isInsideSimilarOrFooterSection(el)) continue;
      domText += ' ' + (el.innerText || el.textContent || '');
    }
    return (payloadText + ' ' + domText).trim();
  }

  function markCardAsExcluded(cardEl, term = '', forceNoOpacity = false) {
    if (!cardEl) return;
    if (hasExistingBadge(cardEl)) return;

    cardEl.dataset.chhHasBadge = 'true';
    cardEl.classList.add('chh-card-has-badge');

    const isPopup = forceNoOpacity || 
                    cardEl.classList.contains('leaflet-popup') || 
                    cardEl.classList.contains('leaflet-popup-content-wrapper') ||
                    cardEl.classList.contains('mapboxgl-popup') ||
                    cardEl.classList.contains('mapboxgl-popup-content') ||
                    cardEl.classList.contains('gm-style-iw') ||
                    cardEl.classList.contains('gm-style-iw-c') ||
                    /popup/i.test(cardEl.className || '') ||
                    cardEl.closest('.leaflet-popup, .mapboxgl-popup, .gm-style-iw, [class*="popup" i]') !== null;

    if (!isPopup) {
      cardEl.style.setProperty('opacity', '0.4', 'important');
      cardEl.style.transition = 'opacity 0.25s ease';
    }

    cardEl.dataset.chhExcluded = term || 'true';
    const badgeText = term ? `✖ CHH (${term})` : '✖ CHH';
    
    let badge = cardEl.querySelector('.chh-card-chh-badge');
    if (!badge) {
      badge = document.createElement('span');
      badge.className = 'chh-card-chh-badge chh-card-chh-badge-excluded';
      badge.textContent = badgeText;
      badge.title = term ? `Annonce masquée (contient le terme : "${term}")` : 'Annonce masquée (terme exclu)';
      badge.addEventListener('click', (ev) => ev.stopPropagation());
      
      badge.addEventListener('mouseenter', () => {
        badge.style.transform = 'scale(1.06)';
      });
      badge.addEventListener('mouseleave', () => {
        badge.style.transform = 'scale(1)';
      });

      const isTableRow = cardEl.tagName === 'TR';
      if (isTableRow) {
        badge.style.cssText = `
          display: inline-flex !important;
          align-items: center !important;
          gap: 4px !important;
          padding: 2px 7px !important;
          margin-right: 8px !important;
          vertical-align: middle !important;
          font-size: 11px !important;
          font-weight: 700 !important;
          color: #fff !important;
          background: linear-gradient(135deg, #6b7280 0%, #4b5563 100%) !important;
          border: 1px solid #374151 !important;
          border-radius: 4px !important;
          text-decoration: none !important;
          box-shadow: 0 1px 3px rgba(0, 0, 0, 0.2) !important;
          pointer-events: auto !important;
          font-family: system-ui, -apple-system, sans-serif !important;
          transition: transform 0.15s ease !important;
          cursor: default !important;
        `;

        const targetCell = cardEl.querySelector('.col-titre, [data-column="titre"], td:nth-child(2), td');
        if (targetCell) {
          targetCell.insertBefore(badge, targetCell.firstChild);
        } else {
          cardEl.appendChild(badge);
        }
      } else {
        badge.style.cssText = `
          position: absolute !important;
          top: 10px !important;
          left: 10px !important;
          z-index: 999999 !important;
          display: inline-flex !important;
          align-items: center !important;
          gap: 4px !important;
          padding: 4px 10px !important;
          font-size: 11.5px !important;
          font-weight: 700 !important;
          color: #fff !important;
          background: linear-gradient(135deg, #6b7280 0%, #4b5563 100%) !important;
          border: 1px solid #374151 !important;
          border-radius: 4px !important;
          text-decoration: none !important;
          box-shadow: 0 2px 6px rgba(0, 0, 0, 0.25) !important;
          pointer-events: auto !important;
          font-family: system-ui, -apple-system, sans-serif !important;
          transition: transform 0.15s ease !important;
          cursor: default !important;
        `;

        const currentStyle = window.getComputedStyle(cardEl);
        if (currentStyle.position === 'static') {
          cardEl.style.position = 'relative';
        }
        cardEl.appendChild(badge);
      }
    }

    if (!isPopup) {
      cardEl.addEventListener('mouseenter', () => {
        cardEl.style.setProperty('opacity', '0.95', 'important');
      });
      cardEl.addEventListener('mouseleave', () => {
        cardEl.style.setProperty('opacity', '0.4', 'important');
      });
    }
  }

  function checkAndMarkExcluded(cardEl, extraText = '', forceNoOpacity = false) {
    if (!cardEl) return null;
    if (hasExistingBadge(cardEl)) {
      if (cardEl.querySelector('.chh-card-chh-badge-excluded') ||
          (cardEl.classList && cardEl.classList.contains('chh-card-chh-badge-excluded')) ||
          cardEl.dataset.chhExcluded) {
        return cardEl.dataset.chhExcluded || 'excluded';
      }
      return null;
    }
    const fullText = (cardEl.innerText || cardEl.textContent || '') + ' ' + (extraText || '');
    const matchedTerm = findExcludedTermInText(fullText);
    if (matchedTerm) {
      markCardAsExcluded(cardEl, matchedTerm, forceNoOpacity);
      return matchedTerm;
    }
    return null;
  }

  window.__chhOverlay = {
    showLoading,
    showError,
    showDatePrompt,
    showResult,
    showLandResult,
    closeCard,
    injectButton,
    mountFloatingButton,
    resetFloatingButton,
    onNavigate,
    // Floating container (Material Design, bas-gauche)
    mountFloatingContainer,
    setFloatingContainerLoading,
    setFloatingContainerAddress,
    setFloatingContainerChh,
    removeFloatingContainer,
    markCardAsMatched,
    markCardAsExcluded,
    checkAndMarkExcluded,
    getExcludedTerms,
    findExcludedTermInText,
  };
})();
