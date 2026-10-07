export const HOUR_HEIGHT = 46;
export const MIN_GRID_HEIGHT = 180;

function timeToMinutes(value, fallback) {
    const match = /^(\d{1,2}):(\d{2})$/.exec(String(value || ""));
    return match ? Number(match[1]) * 60 + Number(match[2]) : fallback;
}

export function computeGeometry(settings) {
    return {
        startHour: 0,
        endHour: 24,
        startMinute: 0,
        height: 24 * HOUR_HEIGHT,
        workStart: timeToMinutes(settings.workStart, 540),
        workEnd: timeToMinutes(settings.workEnd, 1080),
    };
}

export function clampGridHeight(height, availableHeight) {
    const maximum = Math.max(MIN_GRID_HEIGHT, Math.floor(availableHeight));
    return Math.min(maximum, Math.max(MIN_GRID_HEIGHT, Math.round(height)));
}
