// AWS EventBridge schedule expressions: 6-field cron ("min hour day-of-month month day-of-week year")
// and rate(). Used by the CLI (require) and the web manager (served as /cron.js, exposes window.ecsCron).
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.ecsCron = factory();
  }
}(typeof self !== 'undefined' ? self : this, () => {
  const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
  const DAYS = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];

  const FIELDS = [
    { name: 'Minutes', min: 0, max: 59 },
    { name: 'Hours', min: 0, max: 23 },
    { name: 'Day-of-month', min: 1, max: 31 },
    { name: 'Month', min: 1, max: 12, names: MONTHS },
    { name: 'Day-of-week', min: 1, max: 7, names: DAYS },
    { name: 'Year', min: 1970, max: 2199 },
  ];

  const toNumber = (value, field) => {
    const upper = String(value).toUpperCase();
    if (field.names && field.names.includes(upper)) {
      return field.names.indexOf(upper) + 1;
    }
    if (!/^\d+$/.test(upper)) {
      throw new Error(`${field.name}: invalid value "${value}"`);
    }
    const num = parseInt(upper, 10);
    if (num < field.min || num > field.max) {
      throw new Error(`${field.name}: ${num} is out of range (${field.min}-${field.max})`);
    }
    return num;
  };

  // Expands "*", "a", "a-b", "*/n", "a/n", "a-b/n" lists into a Set of numbers
  const parseList = (text, field) => {
    const values = new Set();
    text.split(',').forEach((part) => {
      if (!part) throw new Error(`${field.name}: empty list item`);
      const [range, stepText] = part.split('/');
      const step = stepText === undefined ? 1 : parseInt(stepText, 10);
      if (stepText !== undefined && (!/^\d+$/.test(stepText) || step < 1)) {
        throw new Error(`${field.name}: invalid step "${stepText}"`);
      }
      let start;
      let end;
      if (range === '*') {
        start = field.min;
        end = field.max;
      } else if (range.includes('-')) {
        const [a, b] = range.split('-');
        start = toNumber(a, field);
        end = toNumber(b, field);
        if (start > end) throw new Error(`${field.name}: range "${range}" goes backwards`);
      } else {
        start = toNumber(range, field);
        end = stepText === undefined ? start : field.max;
      }
      for (let i = start; i <= end; i += step) values.add(i);
    });
    return values;
  };

  const parseDayOfMonth = (text, field) => {
    if (text === '?') return null;
    if (text === 'L') return { last: true };
    if (text === 'LW') return { lastWeekday: true };
    const weekday = text.match(/^(\d+)W$/);
    if (weekday) return { nearestWeekday: toNumber(weekday[1], field) };
    return { values: parseList(text, field) };
  };

  const parseDayOfWeek = (text, field) => {
    if (text === '?') return null;
    if (text === 'L') return { values: new Set([7]) };
    const last = text.match(/^(\w+)L$/i);
    if (last) return { lastOf: toNumber(last[1], field) };
    const nth = text.match(/^(\w+)#(\d)$/i);
    if (nth) {
      const n = parseInt(nth[2], 10);
      if (n < 1 || n > 5) throw new Error(`${field.name}: "#${n}" must be between 1 and 5`);
      return { nth: toNumber(nth[1], field), n };
    }
    return { values: parseList(text, field) };
  };

  const stripWrapper = expression => String(expression || '').trim().replace(/^cron\((.*)\)$/i, '$1').trim();

  const parse = (expression) => {
    const text = String(expression || '').trim();
    const rate = text.match(/^rate\((\d+)\s+(minute|minutes|hour|hours|day|days)\)$/i);
    if (rate) {
      const value = parseInt(rate[1], 10);
      const unit = rate[2].toLowerCase();
      if (value < 1) throw new Error('rate value must be at least 1');
      if ((value === 1) !== !unit.endsWith('s')) {
        throw new Error(value === 1 ? `use the singular unit: rate(1 ${unit.replace(/s$/, '')})` : `use the plural unit: rate(${value} ${unit}s)`);
      }
      const minutes = { minute: 1, hour: 60, day: 1440 }[unit.replace(/s$/, '')];
      return { type: 'rate', intervalMinutes: value * minutes };
    }

    const parts = stripWrapper(text).split(/\s+/).filter(Boolean);
    if (parts.length !== 6) {
      throw new Error(`Expected 6 fields (minutes hours day-of-month month day-of-week year), got ${parts.length}`);
    }
    const [dom, dow] = [parts[2], parts[4]];
    if ((dom === '?') === (dow === '?')) {
      throw new Error('Use "?" in exactly one of day-of-month or day-of-week');
    }

    return {
      type: 'cron',
      minutes: parseList(parts[0], FIELDS[0]),
      hours: parseList(parts[1], FIELDS[1]),
      dayOfMonth: parseDayOfMonth(parts[2].toUpperCase(), FIELDS[2]),
      months: parseList(parts[3], FIELDS[3]),
      dayOfWeek: parseDayOfWeek(parts[4].toUpperCase(), FIELDS[4]),
      years: parseList(parts[5], FIELDS[5]),
    };
  };

  const daysInMonth = (year, month) => new Date(Date.UTC(year, month, 0)).getUTCDate();

  // year/month 1-based, day 1-based; all evaluated on wall-clock values
  const dayMatches = (spec, year, month, day) => {
    const dim = daysInMonth(year, month);
    const dow = new Date(Date.UTC(year, month - 1, day)).getUTCDay() + 1; // 1 = SUN
    if (spec.dayOfMonth) {
      const d = spec.dayOfMonth;
      if (d.values) return d.values.has(day);
      if (d.last) return day === dim;
      const weekdayNear = (target) => {
        const t = Math.min(target, dim);
        const tDow = new Date(Date.UTC(year, month - 1, t)).getUTCDay();
        if (tDow === 6) return t === 1 ? 3 : t - 1;
        if (tDow === 0) return t === dim ? t - 2 : t + 1;
        return t;
      };
      if (d.lastWeekday) return day === weekdayNear(dim);
      return day === weekdayNear(d.nearestWeekday);
    }
    const w = spec.dayOfWeek;
    if (w.values) return w.values.has(dow);
    if (w.lastOf) return dow === w.lastOf && day + 7 > dim;
    return dow === w.nth && Math.ceil(day / 7) === w.n;
  };

  // Offset (ms) of a timezone at a given instant: wall clock minus UTC
  const offsetAt = (timeZone, instant) => {
    if (!timeZone || timeZone === 'UTC') return 0;
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
    }).formatToParts(new Date(instant));
    const get = type => parseInt(parts.find(p => p.type === type).value, 10);
    const wall = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
    return wall - Math.floor(instant / 1000) * 1000;
  };

  const wallToInstant = (timeZone, wall) => {
    let instant = wall - offsetAt(timeZone, wall);
    instant = wall - offsetAt(timeZone, instant);
    return instant;
  };

  const isValidTimeZone = (timeZone) => {
    try {
      new Intl.DateTimeFormat('en-US', { timeZone });
      return true;
    } catch (error) {
      return false;
    }
  };

  // Next `count` run times (Date objects) after `from`. Cron fields are read in `timeZone` (default UTC).
  const nextRuns = (expression, count = 5, options = {}) => {
    const spec = parse(expression);
    const timeZone = options.timeZone || 'UTC';
    if (!isValidTimeZone(timeZone)) throw new Error(`Unknown timezone "${timeZone}"`);
    const from = options.from ? new Date(options.from).getTime() : Date.now();
    const runs = [];

    if (spec.type === 'rate') {
      const interval = spec.intervalMinutes * 60000;
      for (let i = 1; i <= count; i += 1) runs.push(new Date(Math.floor(from / 60000) * 60000 + interval * i));
      return runs;
    }

    // Walk wall-clock time (represented as a UTC timestamp) and skip whole years/months/days/hours that cannot match
    let wall = Math.floor((from + offsetAt(timeZone, from)) / 60000) * 60000 + 60000;
    const maxYear = Math.max(...spec.years);
    let guard = 0;

    while (runs.length < count && guard < 200000) {
      guard += 1;
      const d = new Date(wall);
      const year = d.getUTCFullYear();
      const month = d.getUTCMonth() + 1;
      const day = d.getUTCDate();
      const hour = d.getUTCHours();
      const minute = d.getUTCMinutes();

      if (year > maxYear) break;
      if (!spec.years.has(year)) { wall = Date.UTC(year + 1, 0, 1); continue; }
      if (!spec.months.has(month)) { wall = Date.UTC(year, month, 1); continue; }
      if (!dayMatches(spec, year, month, day)) { wall = Date.UTC(year, month - 1, day + 1); continue; }
      if (!spec.hours.has(hour)) { wall = Date.UTC(year, month - 1, day, hour + 1); continue; }
      if (!spec.minutes.has(minute)) { wall += 60000; continue; }

      const instant = wallToInstant(timeZone, wall);
      if (instant > from && (!runs.length || instant > runs[runs.length - 1].getTime())) {
        runs.push(new Date(instant));
      }
      wall += 60000;
    }

    return runs;
  };

  // Accepts "0 3 * * ? *", "cron(0 3 * * ? *)" or "rate(5 minutes)"; returns the AWS ScheduleExpression
  const toScheduleExpression = (expression) => {
    const text = String(expression || '').trim();
    if (/^rate\(/i.test(text)) return text;
    return `cron(${stripWrapper(text).split(/\s+/).join(' ')})`;
  };

  // Validates and returns { error } or { runs }
  const preview = (expression, count = 5, options = {}) => {
    try {
      const runs = nextRuns(expression, count, options);
      if (!runs.length) return { error: 'This expression never runs again' };
      return { runs };
    } catch (error) {
      return { error: error.message };
    }
  };

  const formatInZone = (date, timeZone) => new Intl.DateTimeFormat('en-GB', {
    timeZone, weekday: 'short', year: 'numeric', month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZoneName: 'short',
  }).format(date);

  return {
    parse, nextRuns, preview, toScheduleExpression, stripWrapper, isValidTimeZone, formatInZone,
  };
}));
