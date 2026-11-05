// Display units. Everything is calculated and stored in millimeters. Inches only exist at the
// edges, where numbers are typed or shown, so switching units can never change a result.
import { shimLabel } from './lash.js';

export const MM_PER_IN = 25.4;
const STORAGE_KEY = 'miata-shim-finder:units';

// Inches are shown to 4 decimals, so a shown value can sit this far from the true value.
const INCH_ROUNDING_MM = 0.0018;

function readSaved() {
  try {
    return window.localStorage.getItem(STORAGE_KEY) === 'in' ? 'in' : 'mm';
  } catch {
    return 'mm';
  }
}

let unit = readSaved();
const listeners = [];

export const getUnit = () => unit;
export const isImperial = () => unit === 'in';
export const unitName = (u = unit) => (u === 'in' ? 'in' : 'mm');
export const unitLong = (u = unit) => (u === 'in' ? 'inches' : 'mm');

export function onUnitChange(listener) {
  listeners.push(listener);
}

export function setUnit(next) {
  if (next === unit) return;
  const previous = unit;
  unit = next;
  try {
    window.localStorage.setItem(STORAGE_KEY, next);
  } catch {
    /* Storage is a convenience only. */
  }
  for (const listener of listeners) listener(next, previous);
}

// A typed number, in the given unit, as millimeters.
export function toMm(value, u = unit) {
  const mm = u === 'in' ? value * MM_PER_IN : value;
  return Math.round(mm * 1000) / 1000;
}

// Undo inch rounding: 0.0110 in is 0.279 mm, but it is how 0.28 mm is displayed.
export function snapToKnown(mm, known) {
  let best = mm;
  let gap = INCH_ROUNDING_MM;
  for (const value of known) {
    const distance = Math.abs(value - mm);
    if (distance <= gap) {
      best = value;
      gap = distance;
    }
  }
  return best;
}

const inches = (mm) => (mm / MM_PER_IN).toFixed(4);

export const formatShim = (mm, u = unit) => (u === 'in' ? inches(mm) : shimLabel(mm));
export const formatExact = (mm, u = unit) => (u === 'in' ? inches(mm) : mm.toFixed(3));
export const formatLash = (mm, u = unit) =>
  u === 'in' ? inches(mm) : mm.toFixed(Math.round(mm * 1000) % 10 ? 3 : 2);
