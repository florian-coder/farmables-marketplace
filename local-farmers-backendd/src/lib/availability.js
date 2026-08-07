// OPS-06 — when a farm is actually open.
//
// A farm is a person. They sleep, they have Sundays, and they can only pack so
// many boxes in a day. Taking an order they cannot fill is not a sale, it is a
// refund with extra steps — and it costs the customer their evening as well.
//
// Every default here is "no restriction", because every farm that already
// exists has none configured and none of them should suddenly go dark.

const { toBani } = require('./money');

/** 0 = Sunday, matching `Date.getDay()`. */
const WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

const parseHoursObject = (value) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }
  return value;
};

const parseClosedDates = (value) => {
  if (Array.isArray(value)) {
    return value.map((entry) => String(entry).slice(0, 10));
  }
  return [];
};

/** `2026-08-07` in the local sense we care about — the farm's delivery day. */
const isoDate = (date) => date.toISOString().slice(0, 10);

const minutesOfDay = (date) => date.getUTCHours() * 60 + date.getUTCMinutes();

const parseClockToMinutes = (value) => {
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(value || '').trim());
  if (!match) {
    return null;
  }
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) {
    return null;
  }
  return hours * 60 + minutes;
};

/**
 * Is this farm taking orders right now?
 *
 * Returns `null` when it is, or a blocker `{ code, message }` when it is not —
 * the same shape `pricing.js` already uses, so the cart page renders it with no
 * special case.
 *
 * `ordersToday` is passed in rather than counted here: the authoritative count
 * belongs inside `process_checkout`'s transaction, where two simultaneous
 * checkouts cannot both claim the last slot. This is the friendly warning that
 * happens first.
 */
const availabilityBlocker = ({ farmer, farmName, now = new Date(), ordersToday = 0 }) => {
  if (!farmer) {
    return null;
  }

  const closedDates = parseClosedDates(farmer.closed_dates);
  if (closedDates.includes(isoDate(now))) {
    return {
      code: 'farm_closed_today',
      message: `${farmName} is closed today. You can still order — they will start on it when they reopen.`,
      // Advisory, not blocking: a closed day is a delay, not a refusal, and
      // refusing the order would just send the customer elsewhere.
      advisory: true,
    };
  }

  const hours = parseHoursObject(farmer.working_hours);
  // An empty object means "no hours configured", which is every farm today.
  if (Object.keys(hours).length > 0) {
    const today = hours[String(now.getUTCDay())];
    if (!today) {
      return {
        code: 'farm_closed_weekday',
        message: `${farmName} does not take orders on ${WEEKDAY_NAMES[now.getUTCDay()]}. Your order will wait until they are open.`,
        advisory: true,
      };
    }

    const open = parseClockToMinutes(today.open);
    const close = parseClockToMinutes(today.close);
    const nowMinutes = minutesOfDay(now);
    if (open !== null && close !== null && (nowMinutes < open || nowMinutes >= close)) {
      return {
        code: 'farm_closed_now',
        message: `${farmName} takes orders between ${today.open} and ${today.close}. Yours will be picked up when they open.`,
        advisory: true,
      };
    }
  }

  const capacity = toBani(farmer.daily_order_capacity);
  if (capacity > 0 && ordersToday >= capacity) {
    // This one *is* blocking. A farm at capacity has said, in advance, how
    // many boxes it can pack today; taking one more is knowingly selling
    // something that will not be delivered.
    return {
      code: 'farm_at_capacity',
      message: `${farmName} is fully booked for today. Try again tomorrow — they cap orders so yours actually arrives.`,
      advisory: false,
    };
  }

  return null;
};

/** The shape the farm's public page and the vendor dashboard both render. */
const serializeAvailability = (farmer) => {
  const hours = parseHoursObject(farmer?.working_hours);
  return {
    workingHours: Object.entries(hours).map(([day, window]) => ({
      day: Number(day),
      dayLabel: WEEKDAY_NAMES[Number(day)] || '',
      open: window?.open || '',
      close: window?.close || '',
    })),
    closedDates: parseClosedDates(farmer?.closed_dates),
    dailyOrderCapacity: toBani(farmer?.daily_order_capacity),
    leadTimeHours: toBani(farmer?.lead_time_hours),
    // No hours configured is "always open", which is the honest description of
    // every farm that has not filled this in.
    alwaysOpen: Object.keys(hours).length === 0,
  };
};

/** Validate what a farmer submits before it reaches the database. */
const parseAvailabilityInput = (body) => {
  const hours = {};
  const rawHours = body?.workingHours;

  if (Array.isArray(rawHours)) {
    for (const entry of rawHours) {
      const day = Number(entry?.day);
      if (!Number.isInteger(day) || day < 0 || day > 6) {
        return { ok: false, error: 'Each working-hours entry needs a day between 0 and 6.' };
      }
      const open = parseClockToMinutes(entry?.open);
      const close = parseClockToMinutes(entry?.close);
      if (open === null || close === null) {
        return { ok: false, error: 'Opening and closing times must look like 08:00.' };
      }
      if (close <= open) {
        return { ok: false, error: 'Closing time has to be after opening time.' };
      }
      hours[String(day)] = { open: entry.open, close: entry.close };
    }
  }

  const closedDates = [];
  if (Array.isArray(body?.closedDates)) {
    for (const entry of body.closedDates) {
      const value = String(entry || '').slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
        return { ok: false, error: 'Closed dates must look like 2026-12-25.' };
      }
      closedDates.push(value);
    }
  }

  const capacity = Number(body?.dailyOrderCapacity ?? 0);
  if (!Number.isFinite(capacity) || capacity < 0 || capacity > 10000) {
    return { ok: false, error: 'Daily capacity must be a number between 0 and 10000 (0 = no limit).' };
  }

  const leadTime = Number(body?.leadTimeHours ?? 0);
  if (!Number.isFinite(leadTime) || leadTime < 0 || leadTime > 720) {
    return { ok: false, error: 'Lead time must be between 0 and 720 hours.' };
  }

  return {
    ok: true,
    patch: {
      working_hours: hours,
      closed_dates: closedDates,
      daily_order_capacity: Math.round(capacity),
      lead_time_hours: Math.round(leadTime),
    },
  };
};

module.exports = {
  WEEKDAY_NAMES,
  isoDate,
  parseClockToMinutes,
  availabilityBlocker,
  serializeAvailability,
  parseAvailabilityInput,
};
