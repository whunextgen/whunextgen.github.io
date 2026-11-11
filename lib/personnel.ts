import type { Person } from "../types";

/** Existing dated departures and confirmed departures without a known date. */
export const hasLeftLab = (person: Pick<Person, "leftAt" | "isAlumni">): boolean =>
  person.isAlumni === true || Boolean(person.leftAt);
