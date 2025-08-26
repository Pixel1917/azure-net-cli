import prompts from 'prompts';
import generateRepository from './generateRepository.js';
import generateService from './generateService.js';
import generatePresenter from './generatePresenter.js';
import generateSchema from './generateSchema.js';

export default async function generateModule() {
    console.log('🚀 Generating complete module...\n');
    console.log('⚠️  Note: This will create repository, service, presenter and schemas.');
    console.log('    You will need to manually wire them in the providers.\n');

    const { confirm } = await prompts({
        type: 'confirm',
        name: 'confirm',
        message: 'Continue?'
    });

    if (confirm) {
        await generateRepository();
        await generateService();
        await generatePresenter();
        await generateSchema(); // Create schema
        await generateSchema(); // Update schema

        console.log('\n✅ Module generation complete!');
        console.log('\n💡 Remember to:');
        console.log('   1. Add repository to InfrastructureProvider');
        console.log('   2. Add service to ApplicationProvider');
        console.log('   3. Update presenter to use the service from ApplicationProvider');
    }
}