import prompts from 'prompts';
import generateDomain from './generateDomain.js';
import generateRepository from './generateRepository.js';
import generatePresenter from './generatePresenter.js';
import { printApplicationProviderWiring } from './repositoryModuleShared.js';
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
    printApplicationProviderWiring(repositoryResult.contextName, repositoryResult.repositoryName, repositoryResult.datasourceName);
    const { isReadyForPresenter } = await prompts({
        type: 'confirm',
        name: 'isReadyForPresenter',
        message: 'Did you register repository/use-cases in the central ApplicationProvider and want to continue?',
        initial: false
    });
    if (!isReadyForPresenter) {
        console.log('ℹ️ Module flow paused. Complete provider wiring and rerun `azure-net generate presenter`.');
        return;
    }
    await generatePresenter({
        contextName: repositoryResult.contextName,
        useCasesName: repositoryResult.useCasesName
    });
}
