import {updateCoreIndex, writeIfNotExists} from '../../utils/fileUtils.js';
import path from 'path';

const presenterPath = path.join(process.cwd(), 'src/app/core/presenters/AppPresenter.ts');

const presenterTemplate = `import { createPresenterFactory } from '@azure-net/kit/edges';
import { createAsyncHelpers, createErrorParser } from '@azure-net/kit';

const ErrorHandler = createErrorParser();
const AsyncHelpers = createAsyncHelpers({ parseError: ErrorHandler });

export const AppPresenter = createPresenterFactory({ ...AsyncHelpers, handleError: ErrorHandler });`;

export default async function initPresenter() {
    await writeIfNotExists(presenterPath, presenterTemplate);
    await writeIfNotExists(
        path.join(process.cwd(), 'src/app/core/presenters/index.ts'),
        `export * from './AppPresenter';`
    );

    // Update core index
    await updateCoreIndex();

    console.log('✅ Presenter factory initialized');
}