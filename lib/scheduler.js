function calculateNextRun(schedule, now = new Date()) {
    if (!schedule?.enabled || !schedule.time || !Array.isArray(schedule.days) || schedule.days.length === 0) {
        return null;
    }

    const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(schedule.time);
    if (!match) return null;
    const hour = Number(match[1]);
    const minute = Number(match[2]);
    const allowedDays = new Set(schedule.days.map(Number));

    for (let offset = 0; offset <= 7; offset += 1) {
        const candidate = new Date(now);
        candidate.setSeconds(0, 0);
        candidate.setDate(now.getDate() + offset);
        candidate.setHours(hour, minute, 0, 0);
        if (!allowedDays.has(candidate.getDay())) continue;
        if (candidate.getTime() > now.getTime()) return candidate;
    }
    return null;
}

module.exports = { calculateNextRun };
