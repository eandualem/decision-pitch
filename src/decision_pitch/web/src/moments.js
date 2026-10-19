import * as THREE from 'three';

const labels = {
  goal: 'GOAL', foul: 'Foul', free_kick: 'Free kick', penalty: 'Penalty', offside: 'Offside',
  yellow: 'Yellow card', red: 'Red card', kickoff: 'Kick-off', throw_in: 'Throw-in',
  goal_kick: 'Goal kick', corner: 'Corner', half_time: 'Half-time', full_time: 'Full-time',
  substitution: 'Substitution', second_touch: 'Played twice', held: 'Held too long',
  advantage: 'Advantage', handball: 'Handball', added_time: 'Added time',
};
const HOLD_LIMIT = 8; // s a goalkeeper may hold the ball; the referee counts the last five
const make = (tag, className, text = '') => {
  const node = document.createElement(tag);
  node.className = className;
  node.textContent = text;
  return node;
};

export function createMoments(scene, teams) {
  const root = make('div', 'broadcast');
  const scorebar = make('div', 'scorebar');
  scorebar.setAttribute('aria-label', 'Match score');
  const brand = make('div', 'broadcast-brand', 'DP');
  const names = teams.map(team => make('span', 'team-name', team.name));
  const score = make('strong', 'score', '0 : 0');
  const clock = make('span', 'match-clock', '00:00');
  const phase = make('span', 'match-phase', 'Kick-off');
  const count = make('span', 'keeper-count');
  count.hidden = true;
  scorebar.append(brand, names[0], score, names[1], clock, phase, count);
  const banner = make('div', 'moment');
  banner.hidden = true;
  banner.setAttribute('role', 'status');
  banner.setAttribute('aria-live', 'polite');
  const eyebrow = make('span', 'moment-eyebrow', 'MATCH MOMENT');
  const headline = make('strong', 'moment-title');
  const detail = make('span', 'moment-detail');
  const again = make('button', 'play-again', 'Play again');
  again.type = 'button';
  again.hidden = true;
  again.onclick = () => { again.disabled = true; location.reload(); };
  banner.append(eyebrow, headline, detail, again);
  root.append(scorebar, banner);
  const substitutions = make('section', 'substitution-notice');
  substitutions.hidden = true;
  substitutions.setAttribute('role', 'status');
  substitutions.setAttribute('aria-live', 'polite');
  const substitutionTitle = make('strong', 'substitution-title', 'Substitution made');
  const substitutionRows = make('div', 'substitution-rows');
  substitutions.append(substitutionTitle, substitutionRows);
  root.append(substitutions);
  document.body.append(root);
  const roster = new Map(teams.flatMap((team, index) => [...team.players, ...(team.bench ?? [])].map(p => [p.id, { ...p, team: index }])));
  const markers = [];
  const lastPositions = new Map();
  const projected = new THREE.Vector3();
  let bannerUntil = 0;
  let substitutionsUntil = 0;
  let finished = false;
  let lastScore = [0, 0];
  const pending = [];
  const finish = (result) => {
    finished = true;
    pending.length = 0;
    eyebrow.textContent = 'FULL-TIME';
    headline.textContent = `${teams[0].name} ${result[0]} : ${result[1]} ${teams[1].name}`;
    detail.hidden = true;
    again.hidden = false;
    banner.dataset.kind = 'full_time';
    banner.hidden = false;
    bannerUntil = Infinity;
  };
  const playerLabel = id => {
    const player = roster.get(id);
    return player ? `${player.number} · ${player.name}` : `Player ${id}`;
  };
  const show = (event, now) => {
    const player = roster.get(event.player);
    headline.textContent = event.kind === 'free_kick' && event.indirect ? 'Indirect free kick' : labels[event.kind];
    const team = teams[(event.kind === 'foul' || event.kind === 'offside' || event.kind === 'handball') && player ? player.team : event.team];
    const who = event.kind === 'substitution' ? `${playerLabel(event.off)} → ${playerLabel(event.on)}`
      : event.kind === 'added_time' ? `+${event.minutes} min` : (player ? playerLabel(event.player) : '');
    detail.textContent = [team?.name, who].filter(Boolean).join(' / ');
    eyebrow.textContent = event.kind === 'goal' ? 'THE FINISH' : 'MATCH MOMENT';
    banner.dataset.kind = event.kind;
    banner.hidden = false;
    bannerUntil = now + (event.kind === 'goal' ? 5 : 2.5);
  };
  return {
    setSnapshot(snapshot) {
      // Keep a position even when several socket messages arrive before a frame.
      for (const player of snapshot.players) {
        if (!lastPositions.has(player.id)) lastPositions.set(player.id, new THREE.Vector3());
        lastPositions.get(player.id).set(player.x, 0, -player.y);
      }
      score.textContent = `${snapshot.score[0]} : ${snapshot.score[1]}`;
      lastScore = snapshot.score;
      if (snapshot.phase === 'full_time') finish(snapshot.score);
      clock.textContent = snapshot.clock;
      phase.textContent = snapshot.phase === 'play' ? `${snapshot.period === 2 ? '2ND' : '1ST'} HALF` : (labels[snapshot.phase] ?? snapshot.phase.replaceAll('_', ' '));
      const held = snapshot.ball?.held;
      count.hidden = !(held >= HOLD_LIMIT - 5);
      if (!count.hidden) count.textContent = `Keeper ${Math.max(1, Math.ceil(HOLD_LIMIT - held))}`;
    },
    handleEvent(event, now, late = false) {
      if (event.kind === 'substitution' && event.model && roster.has(event.on)) {
        roster.get(event.on).model = event.model;
      }
      if (late) return;
      if (finished) return;
      if (event.kind === 'full_time') { finish(event.score ?? lastScore); return; }
      if (event.kind === 'substitution') {
        if (now >= substitutionsUntil) {
          for (const row of [...substitutionRows.children]) row.remove();
        }
        const outgoing = roster.get(event.off);
        const row = make('div', 'substitution-row');
        row.append(make('span', 'substitution-team', teams[event.team]?.name ?? ''),
          make('span', 'substitution-off', `OUT ${playerLabel(event.off)}${outgoing?.model ? ` · ${outgoing.model}` : ''}`),
          make('span', 'substitution-on', `IN ${playerLabel(event.on)}${event.model ? ` · ${event.model}` : ''}`));
        substitutionRows.append(row);
        substitutionTitle.textContent = substitutionRows.children.length > 1 ? 'Substitutions made' : 'Substitution made';
        substitutions.hidden = false;
        substitutionsUntil = now + 8;
        return;
      }
      if (!labels[event.kind]) return;
      const player = roster.get(event.player);
      if (event.kind === 'yellow' || event.kind === 'red') {
        const node = make('div', `player-card ${event.kind}`);
        node.setAttribute('role', 'img');
        node.setAttribute('aria-label', `${labels[event.kind]}${player ? `: ${player.name}` : ''}`);
        root.append(node);
        markers.push({ node, player: event.player, until: now + 7, position: lastPositions.get(event.player)?.clone() ?? null });
      }
      if (event.kind === 'goal') {
        // Decisive moments must match the live camera and supersede old play.
        pending.length = 0;
        show(event, now);
      } else if (now < bannerUntil) {
        // Keep paired offence/restart and second-yellow/red events readable.
        pending.push(event);
        if (pending.length > 8) pending.shift();
      } else show(event, now);
    },
    update(camera, actors, now) {
      substitutions.hidden = now >= substitutionsUntil;
      for (const id of roster.keys()) {
        const position = actors.getPlayerPosition(id);
        if (position) {
          if (!lastPositions.has(id)) lastPositions.set(id, new THREE.Vector3());
          lastPositions.get(id).copy(position);
        }
      }
      if (now >= bannerUntil) {
        if (pending.length) show(pending.shift(), now);
        else banner.hidden = true;
      }
      for (let i = markers.length - 1; i >= 0; i--) {
        const marker = markers[i];
        if (now >= marker.until) {
          marker.node.remove();
          markers.splice(i, 1);
          continue;
        }
        const livePosition = actors.getPlayerPosition(marker.player);
        if (livePosition) {
          marker.position ??= new THREE.Vector3();
          marker.position.copy(livePosition);
        }
        const position = marker.position;
        marker.node.hidden = !position;
        if (!position) continue;
        projected.copy(position);
        projected.y += 3.6;
        projected.project(camera);
        marker.node.hidden = projected.z < -1 || projected.z > 1 || Math.abs(projected.x) > 1 || Math.abs(projected.y) > 1;
        marker.node.style.left = `${(projected.x + 1) * 50}%`;
        marker.node.style.top = `${(1 - projected.y) * 50}%`;
      }
    },
    dispose() { root.remove(); },
  };
}
