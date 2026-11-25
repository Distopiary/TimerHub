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
    if (task.kind === 'once') {
      // Tâche unique : jamais "faite" (la valider propose de la reprogrammer ou de la supprimer)
      const due = task.due_at ? new Date(task.due_at) : now;
      const dur = Math.max(0, task.duration_minutes || 0) * 60000;
      const end = new Date(due.getTime() + dur);
      return { done: false, target: now < due ? due : end, start: due, end, total: dur, due };
    }
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

  const MONTHS = ['janv.', 'févr.', 'mars', 'avr.', 'mai', 'juin', 'juil.', 'août', 'sept.', 'oct.', 'nov.', 'déc.'];
  const hm = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const dayMonth = (d) => `${d.getDate()} ${MONTHS[d.getMonth()]}`;

  function describe(task) {
    if (task.kind === 'once') {
      const d = task.due_at ? new Date(task.due_at) : new Date();
      const dur = task.duration_minutes ? ` · ${formatInterval(task.duration_minutes)}` : '';
      return `Le ${WEEKDAYS[d.getDay()].slice(0, 3)}. ${dayMonth(d)} à ${hm(d)}${dur}`;
    }
    const time = `${pad(task.reset_hour || 0)}:${pad(task.reset_minute || 0)}`;
    if (task.kind === 'daily') return `Chaque jour · ${time}`;
    if (task.kind === 'weekly') return `Chaque ${WEEKDAYS[task.reset_weekday ?? 1]} · ${time}`;
    return `Toutes les ${formatInterval(task.interval_minutes || 0)}`;
  }

  function timerText(task, st, now = new Date()) {
    if (task.kind === 'once') {
      if (now < st.due) return `Dans ${formatDuration(st.due - now)}`;
      if (now < st.end) return `En cours · fin dans ${formatDuration(st.end - now)}`;
      return `En retard de ${formatDuration(now - st.end)}`;
    }
    if (task.kind === 'interval') {
      if (!st.target) return 'Prêt';
      if (st.done) return `Disponible dans ${formatDuration(st.target - now)}`;
      return `Prêt depuis ${formatDuration(now - st.target)}`;
    }
    if (st.done) return `Fait · reset dans ${formatDuration(st.target - now)}`;
    return `Reset dans ${formatDuration(st.target - now)}`;
  }

  function progress(task, st, now = new Date()) {
    if (task.kind === 'once') {
      if (now < st.due) return 0;
      if (!st.total || now >= st.end) return 1;
      return (now - st.due) / st.total;
    }
    if (!st.start || !st.total) return task.kind === 'interval' ? 1 : 0;
    if (task.kind === 'interval' && !st.done) return 1;
    return Math.min(1, Math.max(0, (now - st.start) / st.total));
  }

  // Occurrences d'une tâche entre from (inclus) et to (exclu), pour le calendrier.
  //  { date, end?, label, current } — current = occurrence de la période en cours (son état "fait" est connu)
  function occurrences(task, from, to, now = new Date()) {
    const out = [];
    const st = status(task, now);
    if (task.kind === 'daily' || task.kind === 'weekly') {
      const d = new Date(from);
      d.setHours(task.reset_hour || 0, task.reset_minute || 0, 0, 0);
      if (d < from) d.setDate(d.getDate() + 1);
      for (; d < to; d.setDate(d.getDate() + 1)) {
        if (task.kind === 'weekly' && d.getDay() !== (task.reset_weekday ?? 1)) continue;
        out.push({ date: new Date(d), label: 'Reset', current: d.getTime() === st.start.getTime() });
      }
    } else if (task.kind === 'interval') {
      if (st.done && st.target >= from && st.target < to) out.push({ date: st.target, label: 'Disponible', current: false });
      else if (!st.done && now >= from && now < to) out.push({ date: st.target && st.target < now ? st.target : now, label: 'Prêt', current: true, ready: true });
    } else if (task.kind === 'once') {
      if (st.due < to && st.end >= from) out.push({ date: st.due, end: task.duration_minutes ? st.end : null, label: 'Unique', current: true });
    }
    return out;
  }

  // Valeur pour <input type="datetime-local"> (heure locale)
  const toLocalInput = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${hm(d)}`;

  window.Schedule = { WEEKDAYS, MONTHS, pad, hm, dayMonth, periodStart, status, formatDuration, formatInterval, describe, timerText, progress, occurrences, toLocalInput };
})();
