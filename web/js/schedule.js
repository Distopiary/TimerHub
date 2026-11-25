// Calcul des périodes, des états et des comptes à rebours.
(function () {
  'use strict';

  const WEEKDAYS = ['dimanche', 'lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi'];
  const pad = (n) => String(n).padStart(2, '0');

  // Début de la période en cours (dernier reset passé) pour une tâche journalière / hebdomadaire.
  function periodStart(task, now) {
    const d = new Date(now);
    d.setHours(task.reset_hour || 0, task.reset_minute || 0, 0, 0);
    if (task.kind === 'daily') {
      if (d > now) d.setDate(d.getDate() - 1);
      return d;
    }
    const diff = (d.getDay() - (task.reset_weekday ?? 1) + 7) % 7;
    d.setDate(d.getDate() - diff);
    if (d > now) d.setDate(d.getDate() - 7);
    return d;
  }

  // État d'une tâche :
  //  done    : validée pour la période / timer en cours
  //  target  : prochaine échéance (reset ou fin du timer)
  //  start   : début de la période courante (pour la barre de progression)
  function status(task, now = new Date()) {
    const last = task.last_done_at ? new Date(task.last_done_at) : null;
    if (task.kind === 'interval') {
      const total = Math.max(1, task.interval_minutes || 1) * 60000;
      if (!last) return { done: false, target: null, start: null, total };
      const end = new Date(last.getTime() + total);
      return { done: now < end, target: end, start: last, total };
    }
    const start = periodStart(task, now);
    const next = new Date(start);
    next.setDate(next.getDate() + (task.kind === 'daily' ? 1 : 7));
    return { done: !!last && last >= start, target: next, start, total: next - start };
  }

  function formatDuration(ms) {
    ms = Math.max(0, ms);
    const s = Math.floor(ms / 1000);
    const d = Math.floor(s / 86400);
    const h = Math.floor((s % 86400) / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    if (d > 0) return `${d}j ${h}h`;
    if (h > 0) return `${h}h ${pad(m)}m`;
    if (m > 0) return `${m}m ${pad(sec)}s`;
    return `${sec}s`;
  }

  function formatInterval(minutes) {
    const h = Math.floor(minutes / 60);
    const m = minutes % 60;
    if (h && m) return `${h}h${pad(m)}`;
    if (h) return `${h}h`;
    return `${m} min`;
  }

  function describe(task) {
    const time = `${pad(task.reset_hour || 0)}:${pad(task.reset_minute || 0)}`;
    if (task.kind === 'daily') return `Chaque jour · ${time}`;
    if (task.kind === 'weekly') return `Chaque ${WEEKDAYS[task.reset_weekday ?? 1]} · ${time}`;
    return `Toutes les ${formatInterval(task.interval_minutes || 0)}`;
  }

  function timerText(task, st, now = new Date()) {
    if (task.kind === 'interval') {
      if (!st.target) return 'Prêt';
      if (st.done) return `Disponible dans ${formatDuration(st.target - now)}`;
      return `Prêt depuis ${formatDuration(now - st.target)}`;
    }
    if (st.done) return `Fait · reset dans ${formatDuration(st.target - now)}`;
    return `Reset dans ${formatDuration(st.target - now)}`;
  }

  function progress(task, st, now = new Date()) {
    if (!st.start || !st.total) return task.kind === 'interval' ? 1 : 0;
    if (task.kind === 'interval' && !st.done) return 1;
    return Math.min(1, Math.max(0, (now - st.start) / st.total));
  }

  window.Schedule = { WEEKDAYS, pad, periodStart, status, formatDuration, formatInterval, describe, timerText, progress };
})();
