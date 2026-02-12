import { store } from '../store.js';

export function renderStatsBar(container) {
  const { tasks } = store.get();
  const { stats, day } = tasks;

  const dayLabel = day ? `<div class="day-label">Day ${day}</div>` : '';

  container.innerHTML = `
    ${dayLabel}
    <div class="stats-bar">
      <div class="stat">
        <span class="stat-value"><span class="flame">&#x1F525;</span> ${stats.streak}</span>
        <span class="stat-label">Streak</span>
      </div>
      <div class="stat">
        <span class="stat-value">&#x2764;&#xFE0F; ${stats.hearts}</span>
        <span class="stat-label">Hearts</span>
      </div>
      <div class="stat">
        <span class="stat-value">${formatXP(stats.xp)}</span>
        <span class="stat-label">XP</span>
      </div>
      <div class="stat">
        <span class="stat-value">Lv.${stats.level}</span>
        <span class="stat-label">Level</span>
      </div>
    </div>
  `;
}

function formatXP(xp) {
  if (xp >= 1000) return `${(xp / 1000).toFixed(1)}k`;
  return String(xp);
}

export function updateStats(newStats) {
  const { tasks } = store.get();
  store.update('tasks', { ...tasks, stats: { ...tasks.stats, ...newStats } });
}
