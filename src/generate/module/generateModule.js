import { prepareComposition } from './composition.js';
import generateDomain from './generateDomain.js';
import generateRepository from './generateRepository.js';
import generatePresenter from './generatePresenter.js';
export default async function generateModule() {
    const domainResult = await generateDomain();
    if (!domainResult) {
        process.exitCode = 1;
        return;
    }
    const repositoryResult = await generateRepository({
        contextName: domainResult.contextName,
        domainName: domainResult.domainName,
        forceCreateUseCases: true
    });
    if (!repositoryResult) {
        process.exitCode = 1;
        return;
    }
    if (!repositoryResult.useCasesCreated) {
        process.exitCode = 1;
        return;
    }
    if (!(await prepareComposition({
        context: repositoryResult.contextName,
        aggregate: repositoryResult.domainName,
        repository: repositoryResult.repositoryName,
        datasource: repositoryResult.datasourceName
    })))
        return;
    await generatePresenter({
        contextName: repositoryResult.contextName,
        aggregateName: repositoryResult.domainName,
        useCasesName: repositoryResult.useCasesName
    });
}
