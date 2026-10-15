import prompts from 'prompts';
import { runGit } from './runGit.js';
export const commitTypes = [
    { value: 'feat', title: '\u2728 feat: New feature' },
    { value: 'fix', title: '\ud83d\udc1b fix: Bug fix' },
    { value: 'docs', title: '\ud83d\udcdd docs: Documentation' },
    { value: 'style', title: '\ud83c\udfa8 style: Formatting' },
    { value: 'refactor', title: '\u267b\ufe0f refactor: Code restructuring' },
    { value: 'perf', title: '\u26a1 perf: Performance' },
    { value: 'test', title: '\u2705 test: Tests' },
    { value: 'build', title: '\ud83d\udce6 build: Build system' },
    { value: 'ci', title: '\ud83d\udc77 ci: Continuous integration' },
    { value: 'chore', title: '\ud83d\udd27 chore: Maintenance' },
    { value: 'patch', title: '\ud83d\udd27 patch: Patch release' },
    { value: 'release', title: '\ud83d\ude80 release: Release' },
    { value: 'revert', title: '\u23ea revert: Revert changes' }
];
export class CommitCancelledError extends Error {
    constructor() {
        super('Commit cancelled.');
    }
}
export function validateSubject(value) {
    if (!value.trim())
        return 'A subject is required';
    if (/[\r\n\0]/.test(value))
        return 'Subject must be a single line';
    return Array.from(value.trim()).length <= 100 || 'Subject must be at most 100 characters';
}
export function formatCommitMessage(answers) {
    if (!commitTypes.some(({ value }) => value === answers.type))
        throw new Error('A conventional commit type is required');
    const validation = validateSubject(answers.subject ?? '');
    if (validation !== true)
        throw new Error(validation);
    const breaking = answers.breaking?.trim();
    const parts = [
        `${answers.type}(${commitTypes.find((item) => item.value === answers.type).title.split(' ')[0]})${breaking ? '!' : ''}: ${answers.subject.trim()}`,
        answers.body?.trim(),
        breaking ? `BREAKING CHANGE: ${breaking}` : undefined,
        answers.footer?.trim()
    ];
    const message = parts.filter(Boolean).join('\n\n');
    if (message.includes('\0'))
        throw new Error('Commit message must not contain null bytes');
    return message;
}
export default async function commit(dependencies = {}) {
    const prompt = dependencies.prompt ?? prompts;
    let cancelled = false;
    const answers = await prompt([
        { type: 'select', name: 'type', message: 'Commit type', choices: commitTypes },
        { type: 'text', name: 'subject', message: 'Subject (required, at most 100 characters)', validate: validateSubject },
        { type: 'text', name: 'body', message: 'Body (optional)' },
        { type: 'text', name: 'breaking', message: 'Breaking changes (optional)' },
        { type: 'text', name: 'footer', message: 'Footer / issue references (optional)' }
    ], {
        onCancel: () => {
            cancelled = true;
            return false;
        }
    });
    if (cancelled || !answers.type || answers.subject === undefined)
        throw new CommitCancelledError();
    const message = formatCommitMessage(answers);
    await (dependencies.git ?? runGit)(['commit', '-m', message]);
}
