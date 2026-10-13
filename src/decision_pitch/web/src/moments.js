import * as THREE from 'three';

const labels = {
  goal: 'GOAL', foul: 'Foul', free_kick: 'Free kick', penalty: 'Penalty', offside: 'Offside',
  yellow: 'Yellow card', red: 'Red card', kickoff: 'Kick-off', throw_in: 'Throw-in',
  goal_kick: 'Goal kick', corner: 'Corner', half_time: 'Half-time', full_time: 'Full-time',
  substitution: 'Substitution',
};
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
  scorebar.append(brand, names[0], score, names[1], clock, phase);
  const banner = make('div', 'moment');
  banner.hidden = true;
  banner.setAttribute('role', 'status');
  banner.setAttribute('aria-live', 'polite');
  const eyebrow = make('span', 'moment-eyebrow', 'MATCH MOMENT');
  const headline = make('strong', 'moment-title');
  const detail = make('span', 'moment-detail');
  banner.append(eyebrow, headline, detail);
  root.append(scorebar, banner);
  document.body.append(root);
  const roster = new Map(teams.flatMap((team, index) => [...team.players, ...(team.bench ?? [])].map(p => [p.id, { ...p, team: index }])));
  const markers = [];
  const lastPositions = new Map();
  const projected = new THREE.Vector3();
  let bannerUntil = 0;
  const pending = [];
  const playerLabel = id => {
    const player = roster.get(id);
    return player ? `${player.number} · ${player.name}` : `Player ${id}`;
  };
  const show = (event, now) => {
    const player = roster.get(event.player);
    headline.textContent = event.kind === 'free_kick' && event.indirect ? 'Indirect free kick' : labels[event.kind];
    const team = teams[(event.kind === 'foul' || event.kind === 'offside') && player ? player.team : event.team];
    const who = event.kind === 'substitution' ? `${playerLabel(event.off)} → ${playerLabel(event.on)}` : (player ? playerLabel(event.player) : '');
    detail.textContent = [team?.name, who].filter(Boolean).join(' / ');
    eyebrow.textContent = event.kind === 'goal' ? 'THE FINISH' : 'MATCH MOMENT';
    banner.dataset.kind = event.kind;
    banner.hidden = false;
    bannerUntil = now + (event.kind === 'goal' ? 5 : 2.5);
  };
  return {
    setSnapshot(snapshot) {
      score.textContent = `${snapshot.score[0]} : ${snapshot.score[1]}`;
      clock.textContent = snapshot.clock;
      phase.textContent = snapshot.phase === 'play' ? `${snapshot.period === 2 ? '2ND' : '1ST'} HALF` : (labels[snapshot.phase] ?? snapshot.phase.replaceAll('_', ' '));
    },
    handleEvent(event, now) {
      if (!labels[event.kind]) return;
      const player = roster.get(event.player);
      if (event.kind === 'yellow' || event.kind === 'red') {
        const node = make('div', `player-card ${event.kind}`);
        node.setAttribute('role', 'img');
        node.setAttribute('aria-label', `${labels[event.kind]}${player ? `: ${player.name}` : ''}`);
        root.append(node);
        markers.push({ node, player: event.player, until: now + 7, position: lastPositions.get(event.player)?.clone() ?? null });
      }
      if (now < bannerUntil) {
        // Keep paired offence/restart and second-yellow/red events readable.
        pending.push(event);
        if (pending.length > 8) pending.shift();
      } else show(event, now);
    },
    update(camera, actors, now) {
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
