import fs from 'node:fs/promises';
import path from 'node:path';
import { dependencies, sourceFiles, report } from './architecture.js';
export default async function checkImports() {
    const issues = [];
    const src = path.join(process.cwd(), 'src');
    try {
        for (const file of await sourceFiles(src)) {
            let previous = 0;
            for (const entry of dependencies(await fs.readFile(file, 'utf8'), file)) {
                if (/\.(?:ts|js)(?:$|[?#])/.test(entry.source))
                    issues.push({ file, line: entry.line, message: `Import "${entry.source}" must not include .ts/.js extension` });
                if (['export', 'dynamic'].includes(entry.kind))
                    continue;
                const style = /\.(?:css|scss|sass|less|styl)(?:$|[?#])/.test(entry.source);
                const order = style || entry.kind === 'side-effect' ? 2 : entry.kind === 'type' ? 1 : 0;
                if (order < previous)
                    issues.push({
                        file,
                        line: entry.line,
                        message: 'Import order violation: value imports first, then type imports, then side-effect imports'
                    });
                previous = Math.max(previous, order);
            }
        }
    }
    catch (error) {
        issues.push({ file: src, line: 1, message: String(error) });
    }
    report('Imports', issues);
}
