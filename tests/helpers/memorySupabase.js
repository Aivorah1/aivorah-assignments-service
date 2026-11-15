// In-memory Supabase stand-in that really stores rows: select/eq/in/order,
// insert/update/upsert, then single()/maybeSingle() or await. Column lists in
// select() are ignored (whole rows come back). For tests that need writes to
// be visible to later requests, e.g. save a document, share it, list it.
function makeMemorySupabase(seed = {}) {
  const tables = {};
  for (const [name, rows] of Object.entries(seed)) tables[name] = rows.map((r) => ({ ...r }));
  let seq = 0;
  const newId = () => {
    seq += 1;
    return `00000000-0000-4000-8000-${String(seq).padStart(12, '0')}`;
  };

  function from(table) {
    const rows = () => (tables[table] ||= []);
    const filters = [];
    let op = 'select';
    let payload = null;
    let conflictCols = [];
    let orderBy = null;

    const run = (mode) => {
      let result;
      if (op === 'insert') {
        const items = (Array.isArray(payload) ? payload : [payload]).map((p) => ({ id: newId(), ...p }));
        rows().push(...items);
        result = items;
      } else if (op === 'update') {
        result = rows().filter((r) => filters.every((f) => f(r)));
        for (const r of result) Object.assign(r, payload);
      } else if (op === 'upsert') {
        result = (Array.isArray(payload) ? payload : [payload]).map((p) => {
          const existing = rows().find((r) => conflictCols.every((c) => r[c] === p[c]));
          if (existing) return Object.assign(existing, p);
          const row = { id: newId(), ...p };
          rows().push(row);
          return row;
        });
      } else {
        result = rows().filter((r) => filters.every((f) => f(r)));
        if (orderBy) {
          const [col, asc] = orderBy;
          result = [...result].sort((a, b) => String(a[col]).localeCompare(String(b[col])) * (asc ? 1 : -1));
        }
      }
      const copy = result.map((r) => ({ ...r }));
      if (mode === 'single') {
        return copy.length === 1 ? { data: copy[0], error: null } : { data: null, error: { message: 'expected one row' } };
      }
      if (mode === 'maybe') return { data: copy[0] || null, error: null };
      return { data: copy, error: null };
    };

    const q = {
      select: () => q,
      eq: (col, val) => { filters.push((r) => r[col] === val); return q; },
      in: (col, vals) => { filters.push((r) => vals.includes(r[col])); return q; },
      order: (col, { ascending = true } = {}) => { orderBy = [col, ascending]; return q; },
      insert: (p) => { op = 'insert'; payload = p; return q; },
      update: (p) => { op = 'update'; payload = p; return q; },
      upsert: (p, { onConflict = 'id' } = {}) => {
        op = 'upsert'; payload = p; conflictCols = onConflict.split(',').map((c) => c.trim());
        return Promise.resolve(run('all'));
      },
      single: () => Promise.resolve(run('single')),
      maybeSingle: () => Promise.resolve(run('maybe')),
      then: (resolve, reject) => Promise.resolve(run('all')).then(resolve, reject),
    };
    return q;
  }

  return { supabase: { from: jest.fn(from) }, tables };
}

module.exports = { makeMemorySupabase };
