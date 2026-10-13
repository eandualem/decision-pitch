const make = (tag, className, text = '') => {
  const node = document.createElement(tag);
  node.className = className;
  node.textContent = text;
  return node;
};

export function createOverlay(teams) {
  const button = make('button', 'overlay-toggle', 'Decisions · O');
  button.type = 'button';
  button.setAttribute('aria-controls', 'decision-overlay');
  button.setAttribute('aria-expanded', 'false');
  const panel = make('section', 'decision-overlay');
  panel.id = 'decision-overlay';
  panel.hidden = true;
  panel.setAttribute('aria-label', 'Player decisions and managers');
  const header = make('div', 'overlay-header');
  header.append(make('h1', '', 'Inside the match'), make('p', '', 'Every player. Every decision.'));
  const columns = make('div', 'roster-columns');
  const rows = new Map();
  const roster = new Map();
  const feeds = [];
  teams.forEach((team, index) => {
    const section = make('section', 'team-panel');
    section.append(make('h2', '', team.name));
    const table = make('table', 'roster-table');
    const head = document.createElement('thead');
    const tr = document.createElement('tr');
    for (const title of ['Player / model', 'Decision', 'Latency']) {
      const cell = make('th', '', title);
      cell.scope = 'col';
      tr.append(cell);
    }
    head.append(tr);
    const body = document.createElement('tbody');
    for (const player of [...team.players, ...(team.bench ?? [])]) {
      roster.set(player.id, { ...player, team: index });
      const row = document.createElement('tr');
      const identity = document.createElement('td');
      const name = make('strong', 'player-name', `${player.number} ${player.name}`);
      const model = make('span', 'player-model', player.model ?? 'Built-in bot');
      identity.append(name, model);
      const action = make('td', 'player-action', 'Waiting');
      const latency = make('td', 'player-latency', '—');
      row.append(identity, action, latency);
      body.append(row);
      rows.set(player.id, { row, model, action, latency, decided: false });
    }
    table.append(head, body);
    const feed = make('ol', 'manager-feed');
    feed.append(make('li', 'feed-empty', 'No manager instructions yet.'));
    feeds.push(feed);
    section.append(table, make('h3', '', 'Manager & substitutions'), feed);
    columns.append(section);
  });
  panel.append(header, columns);
  document.body.append(panel, button);
  const toggle = () => {
    panel.hidden = !panel.hidden;
    button.setAttribute('aria-expanded', String(!panel.hidden));
  };
  const onKey = event => {
    if (event.repeat || event.ctrlKey || event.metaKey || event.altKey || event.target?.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(event.target?.tagName)) return;
    if (event.key.toLowerCase() === 'o') toggle();
    if (event.key === 'Escape' && !panel.hidden) { toggle(); button.focus(); }
  };
  button.addEventListener('click', toggle);
  document.addEventListener('keydown', onKey);
  const playerLabel = id => {
    const p = roster.get(id);
    return p ? `${p.number} ${p.name}` : `Player ${id}`;
  };
  const appendFeed = (team, text) => {
    const feed = feeds[team];
    if (!feed) return;
    feed.querySelector('.feed-empty')?.remove();
    feed.prepend(make('li', '', text));
    while (feed.children.length > 6) feed.lastElementChild.remove();
  };
  return {
    setSnapshot(snapshot) {
      const active = new Map(snapshot.players.map(p => [p.id, p]));
      for (const [id, row] of rows) {
        const player = active.get(id);
        row.row.classList.toggle('off-pitch', !player);
        if (!player) row.action.textContent = 'Off pitch';
        else if (!row.decided) row.action.textContent = player.action;
      }
    },
    handleMessage(message) {
      if (message.type === 'decision') {
        const row = rows.get(message.player);
        if (!row) return;
        row.decided = true;
        row.model.textContent = message.model ?? 'Built-in bot';
        row.action.textContent = message.error ? 'Answer failed' : (message.action ?? 'Waiting');
        row.action.title = message.error ? String(message.error) : '';
        row.latency.textContent = Number.isFinite(message.ms) ? `${Math.round(message.ms)} ms` : '—';
      } else if (message.kind === 'substitution' || message.type === 'substitution') {
        const row = rows.get(message.on);
        if (row) { row.model.textContent = message.model ?? 'Built-in bot'; row.decided = false; row.latency.textContent = '—'; }
        appendFeed(message.team, `${playerLabel(message.off)} → ${playerLabel(message.on)}${message.model ? ` · ${message.model}` : ''}`);
      } else if (message.type === 'manager') {
        appendFeed(message.team, `${message.player != null ? `${playerLabel(message.player)}: ` : ''}${message.text ?? message.kind ?? 'Manager update'}`);
      }
    },
    dispose() {
      document.removeEventListener('keydown', onKey);
      panel.remove();
      button.remove();
    },
  };
}
