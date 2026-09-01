// ── Multi-select dropdown ────────────────────────────────────────────────────

/**
 * Builds a multi-select dropdown inside `container`.
 * `options` is an array of { value, label }.
 * `onChange` is called with the current selected values array on every change.
 * Returns { getSelected(), setValue(values), reset() }.
 */
export function createMultiSelect(container, options, onChange) {
  let selected = new Set();
  let open = false;

  const field = document.createElement('div');
  field.className = 'ms-field';
  field.setAttribute('tabindex', '0');
  field.setAttribute('role', 'combobox');
  field.setAttribute('aria-expanded', 'false');
  field.setAttribute('aria-haspopup', 'listbox');

  const dropdown = document.createElement('div');
  dropdown.className = 'ms-dropdown';
  dropdown.setAttribute('role', 'listbox');
  dropdown.hidden = true;

  // Search input at the top of the dropdown for filtering options.
  const searchInput = document.createElement('input');
  searchInput.type = 'text';
  searchInput.className = 'ms-search';
  searchInput.placeholder = 'Filter…';
  searchInput.addEventListener('click', e => e.stopPropagation());
  searchInput.addEventListener('input', () => {
    const q = searchInput.value.toLowerCase();
    optionEls.forEach(o => {
      o.item.style.display = (q && !o.label.toLowerCase().includes(q)) ? 'none' : '';
    });
  });
  dropdown.appendChild(searchInput);

  // Build one checkbox row per option.
  const optionEls = options.map(({ value, label }) => {
    const item = document.createElement('label');
    item.className = 'ms-option';
    item.setAttribute('role', 'option');

    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.value = value;
    cb.addEventListener('change', (e) => {
      // Prevent the label click from bubbling to the field's click handler,
      // which would toggle the dropdown closed.
      e.stopPropagation();
      if (cb.checked) selected.add(value);
      else selected.delete(value);
      renderChips();
      onChange([...selected]);
    });

    item.appendChild(cb);
    item.appendChild(document.createTextNode(label));
    dropdown.appendChild(item);

    return { value, label, cb, item };
  });

  function renderChips() {
    field.innerHTML = '';
    for (const val of selected) {
      const opt = optionEls.find(o => o.value === val);
      if (!opt) continue;

      const chip = document.createElement('span');
      chip.className = 'ms-chip';
      chip.textContent = opt.label;

      const rm = document.createElement('button');
      rm.className = 'ms-chip-remove';
      rm.innerHTML = '&times;';
      rm.setAttribute('aria-label', `Remove ${opt.label}`);
      rm.addEventListener('click', (e) => {
        e.stopPropagation();
        selected.delete(val);
        opt.cb.checked = false;
        renderChips();
        onChange([...selected]);
      });

      chip.appendChild(rm);
      field.appendChild(chip);
    }

    const ph = document.createElement('span');
    ph.className = 'ms-placeholder';
    ph.textContent = '+ add…';
    field.appendChild(ph);
  }

  function openDropdown() {
    open = true;
    field.classList.add('open');
    field.setAttribute('aria-expanded', 'true');
    dropdown.hidden = false;
    searchInput.value = '';
    optionEls.forEach(o => { o.item.style.display = ''; });
    searchInput.focus();
  }

  function closeDropdown() {
    open = false;
    field.classList.remove('open');
    field.setAttribute('aria-expanded', 'false');
    dropdown.hidden = true;
  }

  field.addEventListener('click', () => (open ? closeDropdown() : openDropdown()));
  field.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      open ? closeDropdown() : openDropdown();
    }
    if (e.key === 'Escape') closeDropdown();
  });

  // Close when clicking outside the component.
  document.addEventListener('click', (e) => {
    if (!container.contains(e.target)) closeDropdown();
  });

  renderChips();
  container.appendChild(field);
  container.appendChild(dropdown);

  return {
    getSelected: () => [...selected],
    setValue(values) {
      selected = new Set(values);
      optionEls.forEach(o => { o.cb.checked = selected.has(o.value); });
      renderChips();
    },
    reset() {
      selected = new Set();
      optionEls.forEach(o => { o.cb.checked = false; });
      renderChips();
    },
  };
}

// ── Result rendering ─────────────────────────────────────────────────────────

export function renderResults(container, results, languageMap) {
  container.innerHTML = '';

  if (results.length === 0) {
    const msg = document.createElement('p');
    msg.className = 'empty-state';
    msg.textContent = 'No problems match the current filters.';
    container.appendChild(msg);
    return;
  }

  for (const p of results) {
    const card = document.createElement('div');
    card.className = 'result-card';
    card.id = p.id;

    // Header: title (left) + olympiad/year/round/problem (right)
    const header = document.createElement('div');
    header.className = 'card-header';

    const title = document.createElement('span');
    title.className = 'card-title';
    title.textContent = p.title;

    const meta = document.createElement('span');
    meta.className = 'card-meta';
    meta.textContent = `${p.olympiad} ${p.year} · ${p.round} · Problem ${p.problem_number}`;

    header.appendChild(title);
    header.appendChild(meta);

    // Tags: problemese chips then genre chips
    const tags = document.createElement('div');
    tags.className = 'card-tags';

    const PROBLEMESE_LIMIT = 3;
    const extraPeChips = [];
    for (let i = 0; i < p.problemese.length; i++) {
      const chip = document.createElement('span');
      chip.className = 'tag tag-problemese';
      chip.textContent = `problemese: ${p.problemese[i]}`;
      if (i >= PROBLEMESE_LIMIT) { chip.hidden = true; extraPeChips.push(chip); }
      tags.appendChild(chip);
    }
    if (p.problemese.length > PROBLEMESE_LIMIT) {
      let peExpanded = false;
      const more = document.createElement('span');
      more.className = 'tag tag-problemese tag-more';
      more.textContent = `+${p.problemese.length - PROBLEMESE_LIMIT} more`;
      more.addEventListener('click', () => {
        peExpanded = !peExpanded;
        extraPeChips.forEach(c => { c.hidden = !peExpanded; });
        more.textContent = peExpanded ? 'show less' : `+${p.problemese.length - PROBLEMESE_LIMIT} more`;
      });
      tags.appendChild(more);
    }

    for (const g of p.genres) {
      const chip = document.createElement('span');
      chip.className = 'tag tag-genre';
      chip.textContent = g;
      tags.appendChild(chip);
    }

    // Footer: solverese list · authors · links
    const footer = document.createElement('div');
    footer.className = 'card-footer';

    const solverNames = p.solverese.map(code => languageMap[code] ?? code);
    const SOLVERESE_LIMIT = 3;
    const solverSpan = document.createElement('span');
    if (solverNames.length <= SOLVERESE_LIMIT) {
      solverSpan.textContent = `Solverese: ${solverNames.join(', ')}`;
    } else {
      let svExpanded = false;
      const textNode = document.createTextNode(`Solverese: ${solverNames.slice(0, SOLVERESE_LIMIT).join(', ')}, `);
      const toggle = document.createElement('span');
      toggle.className = 'footer-toggle';
      toggle.textContent = `+${solverNames.length - SOLVERESE_LIMIT} more`;
      toggle.addEventListener('click', () => {
        svExpanded = !svExpanded;
        textNode.textContent = svExpanded
          ? `Solverese: ${solverNames.join(', ')} `
          : `Solverese: ${solverNames.slice(0, SOLVERESE_LIMIT).join(', ')}, `;
        toggle.textContent = svExpanded ? 'show less' : `+${solverNames.length - SOLVERESE_LIMIT} more`;
      });
      solverSpan.appendChild(textNode);
      solverSpan.appendChild(toggle);
    }
    footer.appendChild(solverSpan);

    const authorText = p.authors.join(', ');
    footer.appendChild(document.createTextNode(` · ${authorText} · `));

    const probLink = document.createElement('a');
    probLink.href = p.problem_url;
    probLink.target = '_blank';
    probLink.rel = 'noopener noreferrer';
    probLink.textContent = 'View original ↗';
    footer.appendChild(probLink);

    if (p.solution_url) {
      footer.appendChild(document.createTextNode(' · '));
      const solLink = document.createElement('a');
      solLink.href = p.solution_url;
      solLink.target = '_blank';
      solLink.rel = 'noopener noreferrer';
      solLink.textContent = 'View solution ↗';
      footer.appendChild(solLink);
    }

    card.appendChild(header);
    card.appendChild(tags);
    card.appendChild(footer);
    container.appendChild(card);
  }
}

// ── Pagination ───────────────────────────────────────────────────────────────

export function renderPagination(container, currentPage, totalPages, onPageChange) {
  container.innerHTML = '';
  if (totalPages <= 1) return;

  function btn(label, page, disabled, active) {
    const el = document.createElement('button');
    el.className = 'page-btn' + (active ? ' page-btn-active' : '');
    el.textContent = label;
    el.disabled = disabled;
    if (!disabled) el.addEventListener('click', () => onPageChange(page));
    return el;
  }

  function ellipsis() {
    const el = document.createElement('span');
    el.className = 'page-ellipsis';
    el.textContent = '…';
    return el;
  }

  container.appendChild(btn('← Prev', currentPage - 1, currentPage === 1, false));

  // Always show first, last, current, and the pages immediately adjacent to current.
  const show = new Set([1, totalPages, currentPage, currentPage - 1, currentPage + 1]
    .filter(p => p >= 1 && p <= totalPages));
  const pages = [...show].sort((a, b) => a - b);

  let prev = 0;
  for (const p of pages) {
    if (p - prev > 1) container.appendChild(ellipsis());
    container.appendChild(btn(p, p, false, p === currentPage));
    prev = p;
  }

  container.appendChild(btn('Next →', currentPage + 1, currentPage === totalPages, false));
}
