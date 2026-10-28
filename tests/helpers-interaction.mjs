// Data for mocked production boundaries, not a rendered customer interaction.
export function detailsContract(candidate, page = 'index.html') {
  return { version: 1, kind: 'details', description: 'Synthetic source-backed disclosure', page, targetId: 'fixture-details',
    states: [{ id: 'closed', controlId: 'fixture-summary', outputIds: [] }, { id: 'open', controlId: 'fixture-summary', outputIds: ['fixture-output'] }],
    outputs: [{ id: 'fixture-output', text: candidate.facts[0].text, factIds: [candidate.facts[0].id] }],
    fallback: 'Native disclosure remains available.', accessibility: 'Native keyboard and touch summary.', reducedMotion: 'Immediate readable content.' };
}
