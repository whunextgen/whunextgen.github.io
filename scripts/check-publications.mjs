import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { load } from 'js-yaml';
import ts from 'typescript';

const root = new URL('../', import.meta.url);
const readYamls = folder => readdirSync(new URL(folder, root)).filter(f => f.endsWith('.yml')).map(file => ({
  id: file.replace(/\.yml$/, ''),
  ...load(readFileSync(new URL(`${folder}/${file}`, root), 'utf8')),
  slug: file.replace(/\.yml$/, ''),
}));
const all = readYamls('content/publications');
const displayed = all.filter(p => p.isPublished !== false);
const people = readYamls('content/people');
const fixture = JSON.parse(readFileSync(new URL('fixtures/publications-2026-11-11.json', import.meta.url), 'utf8'));
const compiled = ts.transpileModule(readFileSync(new URL('lib/publications.ts', root), 'utf8'), { compilerOptions: { module: ts.ModuleKind.ESNext } }).outputText;
const { publicationsForPerson } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`);

assert.equal(displayed.length, 49);
assert.equal(new Set(displayed.map(p => p.id)).size, displayed.length, 'Unique publication IDs');
assert.equal(new Set(displayed.map(p => p.title.toLowerCase().replace(/[^\p{L}\p{N}]/gu, ''))).size, displayed.length, 'No duplicate paper titles');
assert.equal(new Set(displayed.map(p => p.link)).size, displayed.length, 'No duplicate primary paper links');
for (const p of displayed) {
  const url = new URL(p.link);
  assert.equal(url.protocol, 'https:', `${p.title}: real HTTPS paper link`);
  assert.ok(!/abc123|1234567890abcdef|placeholder|^none$/i.test(p.link));
  assert.ok(p.authors.length > 0 && p.authors.every(a => a.trim() && a.toLowerCase() !== 'none'), `${p.title}: credited authors`);
  const source = fixture.publications.find(s => s.id === p.id);
  assert.ok(source, `${p.title}: primary-source audit`);
  for (const key of ['title', 'authors', 'year', 'venue', 'link']) assert.deepEqual(p[key], source[key], `${p.title}: ${key} agrees with verified source`);
}
for (const file of fixture.duplicates) assert.ok(!all.some(p => `${p.slug}.yml` === file), `Duplicate removed: ${file}`);
assert.deepEqual(all.filter(p => p.isPublished === false).map(p => p.id).sort(), fixture.unverified.slice().sort());
const students = people.filter(p => ['PhD', 'Master', 'Academic Master', 'Professional Master'].includes(p.category) && !p.isAlumni && !p.leftAt);
const roster = JSON.parse(readFileSync(new URL('fixtures/people-2026-11-11.json', import.meta.url), 'utf8'));
const expectedStudents = roster.active.filter(p => ['PhD', 'Master', 'Academic Master', 'Professional Master'].includes(p.category));
assert.deepEqual(students.map(p => p.nameZh || p.name).sort(), expectedStudents.map(p => p.name).sort(), 'Audit covers every active PhD/master student in the current roster');
assert.ok(students.every(p => fixture.members.some(m => m.slug === p.slug)), 'Every current student has a verified publication audit');
for (const member of fixture.members) {
  // Keep checking audited coauthors after a move to RA or research intern.
  const person = people.find(p => p.slug === member.slug);
  assert.ok(person, `${member.nameZh}: audited member still has a profile`);
  assert.deepEqual(publicationsForPerson(person, all).map(p => p.id).sort(), member.papers.slice().sort(), `${member.nameZh}: complete verified coauthor list`);
}
// Non-first authors must receive the same paper on their individual pages.
const forSlug = slug => publicationsForPerson(people.find(p => p.slug === slug), all);
assert.ok(forSlug('baojie-qu').some(p => p.id === '2026-raar' && p.authors.indexOf('Baojie Qu') === 2));
assert.ok(forSlug('zuchen-han').some(p => p.id === '2026-words-caught-in-the-heart' && p.authors.indexOf('Zuchen Han') === 5));
assert.ok(forSlug('xiyang-huang').some(p => p.id === '2024-water-conservancy-knowledge-graph'), 'Chinese coauthor name links to the same profile');
assert.ok(!forSlug('xiyang-huang').some(p => p.title.startsWith('CDEMapper')), 'Do not misattribute the unrelated Huang author');
assert.ok(!forSlug('zhentao-li').some(p => p.title.startsWith('From Scores')), 'Only credit the authors of the linked version');
const meta = forSlug('ziyan-kuang').find(p => p.id === '2024-metaaligner-v1');
assert.equal(meta.link, 'https://arxiv.org/abs/2403.17141v1', 'The credited v1 author list must link to v1');
assert.equal(forSlug('mengxi-xiao').filter(p => p.title.startsWith('MoodAngels')).length, 1);
const uniqueStudentPapers = new Set(fixture.members.flatMap(m => m.papers));
console.log(`Publications audit passed: ${displayed.length} displayed papers, ${fixture.publications.filter(p => p.added).length} additions, ${uniqueStudentPapers.size} distinct student papers, all ${students.length} students checked.`);
