import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { load } from 'js-yaml';
import ts from 'typescript';
import { execFileSync } from 'node:child_process';

// Exercise the same helper as the UI while keeping this audit compatible with Node 20.
const helper = ts.transpileModule(readFileSync(new URL('../lib/personnel.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.ESNext },
}).outputText;
const { hasLeftLab } = await import(`data:text/javascript;base64,${Buffer.from(helper).toString('base64')}`);

const root = fileURLToPath(new URL('../', import.meta.url));
const expected = JSON.parse(readFileSync(new URL('./fixtures/people-2026-11-11.json', import.meta.url), 'utf8'));
const dir = join(root, 'content/people');
const people = readdirSync(dir).filter(f => f.endsWith('.yml')).map(file => ({
  ...load(readFileSync(join(dir, file), 'utf8')),
  slug: file.replace(/\.yml$/, ''),
}));
const displayName = p => p.nameZh || p.name;
const active = people.filter(p => !hasLeftLab(p));
const alumni = people.filter(hasLeftLab);
const originalFiles = execFileSync('git', ['ls-tree', '-r', '--name-only', 'HEAD', 'content/people'], { cwd: root, encoding: 'utf8' }).trim().split('\n');
for (const file of originalFiles) {
  const original = load(execFileSync('git', ['show', `HEAD:${file}`], { cwd: root, encoding: 'utf8' }));
  const current = people.find(p => p.slug === file.split('/').pop().replace(/\.yml$/, ''));
  assert.ok(current, `Retain existing profile: ${file}`);
  for (const field of ['name', 'nameZh', 'avatar', 'bio', 'bioZh', 'email', 'homepage', 'advisor', 'teacherProfile']) {
    assert.deepEqual(current[field], original[field], `${displayName(current)}: preserve existing ${field}`);
  }
  if (['Teachers', 'Visiting Scholars'].includes(original.category)) {
    for (const [field, value] of Object.entries(original)) assert.deepEqual(current[field], value, `${displayName(current)}: preserve original faculty/visiting profile`);
  }
}

assert.equal(people.length, 101, '101 total records');
assert.equal(new Set(people.map(displayName)).size, people.length, 'No duplicate people');
assert.equal(new Set(people.map(p => p.id || p.slug)).size, people.length, 'No duplicate card IDs');
assert.equal(active.length, 90, '90 active members');
assert.equal(alumni.length, 11, '11 former members');

for (const [actual, targets, label] of [[active, expected.active, 'active'], [alumni, expected.alumni, 'alumni']]) {
  assert.deepEqual(actual.map(displayName).sort(), targets.map(p => p.name).sort(), `${label} membership`);
  for (const target of targets) {
    const person = actual.find(p => displayName(p) === target.name);
    assert.equal(person.category, target.category, `${target.name}: category`);
    if (target.grade) assert.equal(String(person.grade), target.grade, `${target.name}: entry year`);
    if (target.leftAt) assert.equal(person.leftAt, target.leftAt, `${target.name}: original departure date`);
    if (label === 'alumni' && !target.leftAt) assert.equal(person.leftAt, undefined, `${target.name}: do not invent departure dates`);
  }
}

assert.equal(hasLeftLab({}), false);
assert.equal(hasLeftLab({ isAlumni: false }), false);
assert.equal(hasLeftLab({ isAlumni: true }), true);
assert.equal(hasLeftLab({ leftAt: '2026-08', isAlumni: false }), true, 'Original dates remain authoritative');
assert.ok(!people.some(p => ['黄济民', '黄鸿杰', '朱曜宇'].includes(displayName(p))), 'Excluded and superseded names must not appear');

const locales = readFileSync(join(root, 'i18n/locales.ts'), 'utf8');
const cms = load(readFileSync(join(root, 'public/admin/config.yml'), 'utf8'));
const categoryOptions = cms.collections.find(c => c.name === 'people').fields.find(f => f.name === 'category').options;
for (const category of new Set(people.map(p => p.category))) {
  assert.ok(categoryOptions.includes(category), `CMS supports ${category}`);
  assert.ok(locales.includes(`${JSON.stringify(category)}:`) || locales.includes(`${category}:`), `Category has a translation: ${category}`);
}
for (const p of people) {
  assert.ok(!/[\u3400-\u9fff]/.test(p.name), `${displayName(p)}: English display name must be romanized`);
  if (p.category === 'PhD') assert.equal(p.titleZh, '武汉大学博士生', `${displayName(p)}: consistent PhD title`);
  if (['Academic Master', 'Professional Master', 'Master'].includes(p.category)) assert.equal(p.titleZh, '武汉大学硕士生', `${displayName(p)}: consistent master title`);
  assert.notEqual(p.avatar, '/avatar-placeholder.svg', `${displayName(p)}: no silhouette placeholder`);
  if (p.avatar?.startsWith('./assets/')) continue; // Retained repository image paths.
  if (p.avatar?.startsWith('/')) assert.ok(readFileSync(join(root, 'public', p.avatar.slice(1))).length, `Local avatar exists: ${displayName(p)}`);
}

console.log(`Roster ${expected.asOf}: 90 active, 11 alumni; names, categories, entry years and departure dates verified.`);
console.log(Object.fromEntries([...new Set(active.map(p => p.category))].map(c => [c, active.filter(p => p.category === c).length])));
