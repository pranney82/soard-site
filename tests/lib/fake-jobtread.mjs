/**
 * A tiny in-memory JobTread (Pave) for the reveal tests. Understands the
 * queries the reveal modules send: one job by id (Reveal tasks only), a job's
 * schedule (isToDo = false), the org's open jobs, updateJob, updateTask and
 * createComment. Every mutation is recorded in `calls`.
 *
 * Jobs are plain objects:
 *   { id, name, closedOn, org, fields: { fieldId: value },
 *     reveals: [{ id, startDate, startTime, endDate, endTime, progress }],
 *     schedule: [{ name, endDate, progress, isGroup, taskType }] }
 */
const REVEAL = '22NZSbkR5rZw'; // Reveal task type

export function fakeJobTread(jobs) {
  const state = { jobs: Object.fromEntries(jobs.map(j => [j.id, j])), comments: [], calls: [] };

  const render = (j) => ({
    id: j.id, name: j.name, closedOn: j.closedOn ?? null, organization: { id: j.org ?? '22NJw42j5GLg' },
    customFieldValues: { nodes: Object.entries(j.fields || {}).filter(([, v]) => v != null).map(([id, value]) => ({ value, customField: { id } })) },
    tasks: { nodes: (j.reveals || []).map(t => ({ name: 'Reveal', endDate: null, endTime: null, progress: null, ...t, taskType: { id: REVEAL } })) },
  });

  const fetchImpl = async (url, init) => {
    const { query } = JSON.parse(init.body);
    const { $, ...rest } = query;
    const out = {};
    for (const [key, v] of Object.entries(rest)) {
      if (key === 'job') {
        const j = state.jobs[v.$.id];
        const scheduleQuery = v.tasks?.$?.where?.[0] === 'isToDo';
        out.job = !j ? null : scheduleQuery ? { tasks: { nodes: j.schedule || [] } } : render(j);
      } else if (key === 'organization') {
        out.organization = { jobs: { nextPage: null, nodes: Object.values(state.jobs).filter(j => !j.closedOn).map(render) } };
      } else if (key === 'updateJob') {
        state.calls.push({ updateJob: v.$ });
        const j = state.jobs[v.$.id];
        Object.assign(j.fields, v.$.customFieldValues || {});
        out.updateJob = {};
      } else if (key === 'updateTask') {
        state.calls.push({ updateTask: v.$ });
        const { id, notify, ...patch } = v.$;
        for (const j of Object.values(state.jobs)) {
          const t = (j.reveals || []).find(x => x.id === id);
          if (t) Object.assign(t, patch);
        }
        out.updateTask = {};
      } else if (key === 'createComment') {
        state.calls.push({ createComment: v.$ });
        state.comments.push(v.$);
        out.createComment = {};
      } else {
        throw new Error(`fake JobTread doesn't know ${key}`);
      }
    }
    return new Response(JSON.stringify(out), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };

  return { state, fetchImpl, job: (id) => state.jobs[id] };
}
