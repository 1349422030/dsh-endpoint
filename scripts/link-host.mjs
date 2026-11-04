/**
 * Dev-only: make the Harness packages this plugin imports at runtime resolvable
 * from this checkout, so `node --test` can run without a build step.
 *
 * At runtime these are supplied by the DSH host through the plugin context; they
 * are not installed here. This script links the host's own copies into
 * `node_modules/` (which is ignored by git) instead of pulling a second copy
 * from the registry, so tests run against exactly the version the host runs.
 */
import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, symlinkSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..');

/** Packages this plugin imports at runtime, provided by the host. */
// schemastery backs the Config schema in lib/plugin.js; it only has to be
// resolvable for `node --test` (the host passes it through at runtime).
const PACKAGES = ['dsh-llm', 'dsh-attachment', 'schemastery'];

/**
 * Locate the installed `@deepseek-ai/dsh` package.
 * @returns {string} absolute path to its directory.
 */
function hostPackageRoot() {
    const override = process.env.DSH_PACKAGE_ROOT;
    if (override !== undefined && override !== '') return override;
    const globalRoot = execSync('npm root -g', { encoding: 'utf8' }).trim();
    const candidates = [path.join(globalRoot, '@deepseek-ai', 'dsh')];
    const found = candidates.find((candidate) => existsSync(path.join(candidate, 'package.json')));
    if (found === undefined) {
        throw new Error(`Cannot find @deepseek-ai/dsh under ${globalRoot}. Set DSH_PACKAGE_ROOT to its directory.`);
    }
    return found;
}

const host = hostPackageRoot();
const scope = path.join(repo, 'node_modules', '@deepseek-ai');
mkdirSync(scope, { recursive: true });

for (const name of PACKAGES) {
    const candidates = [
        path.join(host, 'node_modules', '@deepseek-ai', name),
        path.join(path.dirname(host), name),
    ];
    const source = candidates.find((candidate) => existsSync(path.join(candidate, 'package.json')));
    const link = path.join(scope, name);
    if (source === undefined) {
        console.warn(`skip @deepseek-ai/${name}: not installed under ${host}`);
        continue;
    }
    rmSync(link, { recursive: true, force: true });
    symlinkSync(source, link, 'junction');
    console.log(`linked @deepseek-ai/${name} -> ${source}`);
}
