import type { Person, Publication } from "../types";

/** Match every author position, including Chinese names on Chinese papers. */
export const publicationsForPerson = (
  person: Pick<Person, "name" | "nameZh">,
  publications: Publication[],
): Publication[] => {
  const names = new Set([person.name, person.nameZh].filter(Boolean).map((name) => name!.trim().toLowerCase()));
  return publications
    .filter((publication) => publication.isPublished !== false && publication.authors.some((author) => names.has(author.trim().toLowerCase())))
    .sort((a, b) => b.year - a.year || a.title.localeCompare(b.title));
};
