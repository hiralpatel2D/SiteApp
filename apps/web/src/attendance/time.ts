import { ATTENDANCE_TZ } from '@sitediary/shared';

/** HH:MM (24 h) in the site's timezone. */
export const timeOf = (iso: string, tz: string = ATTENDANCE_TZ) =>
  new Date(iso).toLocaleTimeString('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    timeZone: tz,
  });
