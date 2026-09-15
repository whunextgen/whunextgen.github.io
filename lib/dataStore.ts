import { NewsItem, Person, Publication, ContactInfo, Project } from "../types";
import { NEWS, PEOPLE, PUBLICATIONS, PROJECTS, CONTACT } from "./content";

/**
 * Read-only data layer over the build-time content in /content.
 * Editing happens in Decap CMS (/admin/) which commits to the repository;
 * GitHub Actions rebuilds and redeploys the site on every push to main.
 */

export const fetchNews = async (): Promise<NewsItem[]> =>
  NEWS.filter((n) => n.isPublished !== false).sort((a, b) => {
    // Pinned first, then newest first; `order` only breaks ties on the same day.
    if (!!a.isPinned !== !!b.isPinned) return a.isPinned ? -1 : 1;
    const byDate = new Date(b.date).getTime() - new Date(a.date).getTime();
    if (byDate !== 0) return byDate;
    return (a.order || 0) - (b.order || 0);
  });

export const fetchNewsItem = async (id: string): Promise<NewsItem | null> =>
  NEWS.find((item) => item.id === id) || null;

export const trackNewsView = async (_id: string): Promise<void> => {};

export const fetchPeople = async (): Promise<Person[]> =>
  [...PEOPLE].sort((a, b) => (a.order || 99) - (b.order || 99));

export const fetchPublications = async (): Promise<Publication[]> =>
  [...PUBLICATIONS].sort((a, b) => {
    if (a.year !== b.year) return b.year - a.year;
    return (a.order || 0) - (b.order || 0);
  });

export const fetchProjects = async (): Promise<Project[]> =>
  [...PROJECTS].sort((a, b) => (a.order || 99) - (b.order || 99));

export const fetchContact = async (): Promise<ContactInfo> => CONTACT;
