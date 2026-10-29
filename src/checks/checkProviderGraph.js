import path from 'node:path';
import { providerDeclarations, report } from './architecture.js';
export default async function checkProviderGraph() {
    const issues = [];
    try {
        const providers = await providerDeclarations();
        const graph = new Map(providers.map((provider) => [provider.key, provider]));
        const visited = new Set();
        const active = new Set();
        const stack = [];
        const visit = (key) => {
            const provider = graph.get(key);
            if (!provider || visited.has(key))
                return;
            visited.add(key);
            active.add(key);
            stack.push(key);
            for (const dependency of provider.dependsOn) {
                if (active.has(dependency)) {
                    const cycle = [...stack.slice(stack.indexOf(dependency)), dependency].map((id) => graph.get(id).name);
                    issues.push({
                        file: provider.file,
                        line: provider.line,
                        message: `Circular provider dependency detected: ${cycle.join(' -> ')}`
                    });
                }
                else
                    visit(dependency);
            }
            stack.pop();
            active.delete(key);
        };
        for (const provider of providers)
            visit(provider.key);
        console.log(`Provider graph analyzed ${providers.length} service containers/composition roots.`);
    }
    catch (error) {
        issues.push({ file: path.join(process.cwd(), 'src'), line: 1, message: String(error) });
    }
    report('Provider graph', issues);
}
