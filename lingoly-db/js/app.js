import { buildIndex, runSearch } from './search.js';
import { createMultiSelect, renderResults, renderPagination } from './ui.js';

const YEAR_MIN_DEFAULT = 2003;
const YEAR_MAX_DEFAULT = new Date().getFullYear();
const PAGE_SIZE = 20;

async function main() {
  const [problems, languages, olympiads] = await Promise.all([
    fetch('data/problems.json').then(r => r.json()),
    fetch('data/languages.json').then(r => r.json()),
    fetch('data/olympiads.json').then(r => r.json()),
  ]);

  const problemMap = new Map(problems.map(p => [p.id, p]));
  const ms = buildIndex(problems);

  // ── DOM refs ──────────────────────────────────────────────────────────────
  const searchInput    = document.getElementById('search-input');
  const filterToggle   = document.getElementById('filter-toggle');
  const filterPanel    = document.getElementById('filter-panel');
  const problemesInput = document.getElementById('problemese-input');
  const authorInput    = document.getElementById('author-input');
  const yearMinInput   = document.getElementById('year-min');
  const yearMaxInput   = document.getElementById('year-max');
  const genresInput    = document.getElementById('genres-input');
  const resultsCount   = document.getElementById('results-count');
  const sortLabel      = document.getElementById('sort-label');
  const resultsList    = document.getElementById('results-list');
  const paginationEl   = document.getElementById('pagination');
  const resetBtn       = document.getElementById('reset-btn');

  let currentPage = 1;

  // Set year input defaults
  yearMinInput.value = YEAR_MIN_DEFAULT;
  yearMaxInput.value = YEAR_MAX_DEFAULT;

  // ── Multi-select components ───────────────────────────────────────────────
  const langOptions = Object.entries(languages)
    .map(([code, name]) => ({ value: code, label: name }))
    .sort((a, b) => a.label.localeCompare(b.label));

  const olympiadOptions = olympiads.map(o => ({ value: o.code, label: o.name }));

  const solverSelect   = createMultiSelect(document.getElementById('solverese-select'), langOptions, () => { currentPage = 1; update(); });
  const olympiadSelect = createMultiSelect(document.getElementById('olympiad-select'), olympiadOptions, () => { currentPage = 1; update(); });

  // ── Filter panel toggle ───────────────────────────────────────────────────
  filterToggle.addEventListener('click', () => {
    const nowOpen = filterPanel.hidden;
    filterPanel.hidden = !nowOpen;
    filterToggle.classList.toggle('open', nowOpen);
    filterToggle.querySelector('.chevron').textContent = nowOpen ? '▴' : '▾';
  });

  // ── Text input listeners ──────────────────────────────────────────────────
  [searchInput, problemesInput, authorInput, yearMinInput, yearMaxInput, genresInput].forEach(el => {
    el.addEventListener('input', () => { currentPage = 1; update(); });
  });

  // ── Reset ─────────────────────────────────────────────────────────────────
  resetBtn.addEventListener('click', () => {
    searchInput.value    = '';
    problemesInput.value = '';
    authorInput.value    = '';
    yearMinInput.value   = YEAR_MIN_DEFAULT;
    yearMaxInput.value   = YEAR_MAX_DEFAULT;
    genresInput.value    = '';
    solverSelect.reset();
    olympiadSelect.reset();
    currentPage = 1;
    update();
  });

  // ── State helpers ─────────────────────────────────────────────────────────
  function getFilters() {
    return {
      solverese: solverSelect.getSelected(),
      olympiads: olympiadSelect.getSelected(),
      problemese: problemesInput.value.trim(),
      author: authorInput.value.trim(),
      yearMin: parseInt(yearMinInput.value, 10) || YEAR_MIN_DEFAULT,
      yearMax: parseInt(yearMaxInput.value, 10) || YEAR_MAX_DEFAULT,
      // Split comma-separated genre tags and discard empty strings.
      genres: genresInput.value.split(',').map(s => s.trim()).filter(Boolean),
    };
  }

  // ── Main update ───────────────────────────────────────────────────────────
  function update() {
    const query = searchInput.value;
    const filters = getFilters();
    const results = runSearch(ms, problemMap, query, filters);

    const total = results.length;
    const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
    currentPage = Math.min(currentPage, totalPages);

    const start = (currentPage - 1) * PAGE_SIZE;
    const end = Math.min(start + PAGE_SIZE, total);
    const page = results.slice(start, end);

    if (total === 0) {
      resultsCount.textContent = '0 results';
    } else if (total <= PAGE_SIZE) {
      resultsCount.textContent = `${total} result${total !== 1 ? 's' : ''}`;
    } else {
      resultsCount.textContent = `Showing ${start + 1}–${end} of ${total} results`;
    }

    sortLabel.textContent = query.trim() ? 'Sort: relevance' : 'Sort: newest first';

    renderResults(resultsList, page, languages);
    renderPagination(paginationEl, currentPage, totalPages, (p) => {
      currentPage = p;
      update();
      resultsList.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
    pushHash(query, filters);
  }

  // ── URL hash — encode search state so results are shareable ──────────────
  function pushHash(query, filters) {
    const params = new URLSearchParams();
    if (query)                    params.set('q',         query);
    if (filters.solverese.length) params.set('solverese', filters.solverese.join(','));
    if (filters.olympiads.length) params.set('olympiad',  filters.olympiads.join(','));
    if (filters.problemese)       params.set('problemese', filters.problemese);
    if (filters.author)           params.set('author',    filters.author);
    if (filters.yearMin !== YEAR_MIN_DEFAULT) params.set('year_min', filters.yearMin);
    if (filters.yearMax !== YEAR_MAX_DEFAULT) params.set('year_max', filters.yearMax);
    if (filters.genres.length)    params.set('genres',    filters.genres.join(','));

    const str = params.toString();
    history.replaceState(null, '', str ? `#?${str}` : location.pathname + location.search);
  }

  function loadHash() {
    const raw = location.hash.replace(/^#\??/, '');
    if (!raw) return;

    const params = new URLSearchParams(raw);
    if (params.has('q'))          searchInput.value    = params.get('q');
    if (params.has('problemese')) problemesInput.value = params.get('problemese');
    if (params.has('author'))     authorInput.value    = params.get('author');
    if (params.has('year_min'))   yearMinInput.value   = params.get('year_min');
    if (params.has('year_max'))   yearMaxInput.value   = params.get('year_max');
    if (params.has('genres'))     genresInput.value    = params.get('genres');

    if (params.has('solverese'))
      solverSelect.setValue(params.get('solverese').split(',').filter(Boolean));
    if (params.has('olympiad'))
      olympiadSelect.setValue(params.get('olympiad').split(',').filter(Boolean));
  }

  loadHash();
  update();
}

main().catch(err => {
  console.error('Failed to initialise:', err);
  document.getElementById('results-list').innerHTML =
    '<p class="empty-state">Failed to load data. Run a local server to avoid CORS issues — see README.</p>';
  document.getElementById('results-count').textContent = '';
});
