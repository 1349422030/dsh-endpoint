/** The profile patch and the package manifest: the two files a rename has to keep in step. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const ROOT = new URL('..', import.meta.url);

/**
 * The package manifest, parsed.
 * @returns {object} parsed package.json.
 */
function manifest() {
    return JSON.parse(readFileSync(new URL('package.json', ROOT), 'utf8'));
}

/**
 * The entry the profile patch inserts, read without a YAML dependency.
 *
 * The patch is a one-entry array of the shape this plugin ships, so a narrow
 * regexp over the `insert` block is enough and keeps the test dependency-free.
 * @returns {{id: string, name: string}} the inserted loader entry.
 */
function insertedEntry() {
    const text = readFileSync(new URL('cordis.patch.yml', ROOT), 'utf8');
    const block = /insert:\s*\n((?:\s{4}.*\n?)+)/.exec(text)?.[1] ?? '';
    const id = /^\s+-?\s*id:\s*'?([^'\n]+)'?\s*$/m.exec(block)?.[1];
    const name = /^\s+-?\s*name:\s*'?([^'\n]+)'?\s*$/m.exec(block)?.[1];
    return { id: id ?? '', name: name ?? '' };
}

test('the patch inserts the package under the name it is installed as', async () => {
    const { name } = insertedEntry();
    assert.equal(name, manifest().name);
});

test('the profile entry id stays the stable settings namespace', async () => {
    const { id } = insertedEntry();
    assert.equal(id, 'dsh-endpoint');
});

test('the client bundle registers under the package name', async () => {
    const text = readFileSync(new URL('lib/client.js', ROOT), 'utf8');
    const registered = /__ModuleLoader__\.load\(\{[\s\S]{0,400}?id:\s*'([^']+)'/.exec(text)?.[1];
    assert.equal(registered, manifest().name);
});

test('the patch ships in the tarball, since the loader reads it from there', async () => {
    assert.ok(manifest().files.includes('cordis.patch.yml'));
});

test('the manifest points the bundle at the patch it ships', async () => {
    assert.equal(manifest().dsh.bundle.patch, './cordis.patch.yml');
});
