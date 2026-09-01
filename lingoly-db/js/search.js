// MiniSearch is loaded as a UMD global via <script> in index.html.

export function buildIndex(problems) {
  const indexable = problems.map(p => ({
    id: p.id,
    title: p.title,
    problemese_text: p.problemese.join(' '),
    authors_text: p.authors.join(' '),
    genres_text: p.genres.join(' '),
    olympiad: p.olympiad,
  }));

  const ms = new MiniSearch({
    fields: ['title', 'problemese_text', 'authors_text', 'genres_text', 'olympiad'],
    storeFields: ['id'],
    searchOptions: {
      prefix: true,
      fuzzy: 0.2,
      boost: { title: 2, problemese_text: 2 },
    },
  });
  ms.addAll(indexable);
  return ms;
}

function fold(str) {
  return str.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

// Returns a predicate that tests whether a problem passes the current filter state.
export function makeFilter({ solverese, olympiads, problemese, author, yearMin, yearMax, genres }) {
  return (p) => {
    if (solverese.length && !p.solverese.some(s => solverese.includes(s))) return false;
    if (olympiads.length && !olympiads.includes(p.olympiad)) return false;

    if (problemese) {
      const q = fold(problemese);
      if (!p.problemese.some(e => fold(e).includes(q))) return false;
    }

    if (author) {
      const q = fold(author);
      if (!p.authors.some(a => fold(a).includes(q))) return false;
    }

    if (p.year < yearMin || p.year > yearMax) return false;

    // Every typed genre prefix must match the start of at least one of the problem's genres.
    if (genres.length && !genres.every(g => p.genres.some(pg => pg.startsWith(g)))) return false;

    return true;
  };
}

export function runSearch(ms, problemMap, query, filters) {
  const passes = makeFilter(filters);
  const q = query.trim();

  if (!q) {
    return [...problemMap.values()]
      .filter(passes)
      .sort((a, b) => b.year - a.year || a.olympiad.localeCompare(b.olympiad));
  }

  // Year tokens must never go through fuzzy/prefix text search — a query like
  // "2024" would fuzzy-match "2014" (1 edit in 4 chars). Instead, pull out any
  // digit-only token, do an exact startsWith match on the year field, and let
  // MiniSearch handle the remaining non-numeric terms.
  const tokens = q.split(/\s+/);
  const yearTokens  = tokens.filter(t => /^\d+$/.test(t));
  const textTokens  = tokens.filter(t => !/^\d+$/.test(t));
  const textQuery   = textTokens.join(' ');

  const yearFilter = yearTokens.length
    ? (p) => yearTokens.every(yt => String(p.year).startsWith(yt))
    : () => true;

  const fullFilter = (p) => passes(p) && yearFilter(p);

  if (!textQuery) {
    // Pure year query — skip MiniSearch entirely.
    return [...problemMap.values()]
      .filter(fullFilter)
      .sort((a, b) => b.year - a.year || a.olympiad.localeCompare(b.olympiad));
  }

  // Mixed query: MiniSearch for the text part, year filter applied alongside.
  const msResults = ms
    .search(textQuery, {
      filter: r => {
        const p = problemMap.get(r.id);
        return p ? fullFilter(p) : false;
      },
    })
    .map(r => problemMap.get(r.id))
    .filter(Boolean);

  // Also surface any problems that match the year token but weren't in MiniSearch results.
  if (yearTokens.length) {
    const seen = new Set(msResults.map(p => p.id));
    const yearOnly = [...problemMap.values()].filter(p => fullFilter(p) && !seen.has(p.id));
    return [...msResults, ...yearOnly];
  }

  return msResults;
}
