import prompts from 'prompts';
import generateRepository from './generateRepository.js';
import generateService from './generateService.js';
import generatePresenter from './generatePresenter.js';
import generateSchema from './generateSchema.js';

export default async function generateModule() {
    console.log('🚀 Generating complete module...\n');

    const { confirm } = await prompts({
        type: 'confirm',
        name: 'confirm',
        message: 'This will create repository, service, presenter and schemas. Continue?'
    });

    if (confirm) {
        await generateRepository();
        await generateService();
        await generatePresenter();
        await generateSchema(); // Create schema
        await generateSchema(); // Update schema
    }
}