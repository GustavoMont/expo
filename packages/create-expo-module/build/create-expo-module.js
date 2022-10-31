"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const spawn_async_1 = __importDefault(require("@expo/spawn-async"));
const chalk_1 = __importDefault(require("chalk"));
const commander_1 = require("commander");
const download_tarball_1 = __importDefault(require("download-tarball"));
const ejs_1 = __importDefault(require("ejs"));
const fs_extra_1 = __importDefault(require("fs-extra"));
const getenv_1 = require("getenv");
const path_1 = __importDefault(require("path"));
const prompts_1 = __importDefault(require("prompts"));
const createExampleApp_1 = require("./createExampleApp");
const packageManager_1 = require("./packageManager");
const prompts_2 = require("./prompts");
const resolvePackageManager_1 = require("./resolvePackageManager");
const utils_1 = require("./utils");
const debug = require('debug')('create-expo-module:main');
const packageJson = require('../package.json');
// Opt in to using beta versions
const EXPO_BETA = (0, getenv_1.boolish)('EXPO_BETA', false);
// `yarn run` may change the current working dir, then we should use `INIT_CWD` env.
const CWD = process.env.INIT_CWD || process.cwd();
// Ignore some paths. Especially `package.json` as it is rendered
// from `$package.json` file instead of the original one.
const IGNORES_PATHS = ['.DS_Store', 'build', 'node_modules', 'package.json'];
/**
 * The main function of the command.
 *
 * @param target Path to the directory where to create the module. Defaults to current working dir.
 * @param command An object from `commander`.
 */
async function main(target, options) {
    const slug = await askForPackageSlugAsync(target);
    const targetDir = path_1.default.join(CWD, target || slug);
    await fs_extra_1.default.ensureDir(targetDir);
    await confirmTargetDirAsync(targetDir);
    options.target = targetDir;
    const data = await askForSubstitutionDataAsync(slug);
    // Make one line break between prompts and progress logs
    console.log();
    const packageManager = await (0, resolvePackageManager_1.resolvePackageManager)();
    const packagePath = options.source
        ? path_1.default.join(CWD, options.source)
        : await downloadPackageAsync(targetDir);
    await (0, utils_1.newStep)('Creating the module from template files', async (step) => {
        await createModuleFromTemplate(packagePath, targetDir, data);
        step.succeed('Created the module from template files');
    });
    await (0, utils_1.newStep)('Installing module dependencies', async (step) => {
        await (0, packageManager_1.installDependencies)(packageManager, targetDir);
        step.succeed('Installed module dependencies');
    });
    await (0, utils_1.newStep)('Compiling TypeScript files', async (step) => {
        await (0, spawn_async_1.default)(packageManager, ['run', 'build'], {
            cwd: targetDir,
            stdio: 'ignore',
        });
        step.succeed('Compiled TypeScript files');
    });
    if (!options.source) {
        // Files in the downloaded tarball are wrapped in `package` dir.
        // We should remove it after all.
        await fs_extra_1.default.remove(packagePath);
    }
    if (!options.withReadme) {
        await fs_extra_1.default.remove(path_1.default.join(targetDir, 'README.md'));
    }
    if (!options.withChangelog) {
        await fs_extra_1.default.remove(path_1.default.join(targetDir, 'CHANGELOG.md'));
    }
    if (options.example) {
        // Create "example" folder
        await (0, createExampleApp_1.createExampleApp)(data, targetDir, packageManager);
    }
    console.log();
    console.log('✅ Successfully created Expo module');
}
/**
 * Recursively scans for the files within the directory. Returned paths are relative to the `root` path.
 */
async function getFilesAsync(root, dir = null) {
    const files = [];
    const baseDir = dir ? path_1.default.join(root, dir) : root;
    for (const file of await fs_extra_1.default.readdir(baseDir)) {
        const relativePath = dir ? path_1.default.join(dir, file) : file;
        if (IGNORES_PATHS.includes(relativePath) || IGNORES_PATHS.includes(file)) {
            continue;
        }
        const fullPath = path_1.default.join(baseDir, file);
        const stat = await fs_extra_1.default.lstat(fullPath);
        if (stat.isDirectory()) {
            files.push(...(await getFilesAsync(root, relativePath)));
        }
        else {
            files.push(relativePath);
        }
    }
    return files;
}
/**
 * Asks NPM registry for the url to the tarball.
 */
async function getNpmTarballUrl(packageName, version = 'latest') {
    debug(`Using module template ${chalk_1.default.bold(packageName)}@${chalk_1.default.bold(version)}`);
    const { stdout } = await (0, spawn_async_1.default)('npm', ['view', `${packageName}@${version}`, 'dist.tarball']);
    return stdout.trim();
}
/**
 * Downloads the template from NPM registry.
 */
async function downloadPackageAsync(targetDir) {
    return await (0, utils_1.newStep)('Downloading module template from npm', async (step) => {
        const tarballUrl = await getNpmTarballUrl('expo-module-template', EXPO_BETA ? 'next' : 'latest');
        await (0, download_tarball_1.default)({
            url: tarballUrl,
            dir: targetDir,
        });
        step.succeed('Downloaded module template from npm');
        return path_1.default.join(targetDir, 'package');
    });
}
/**
 * Creates the module based on the `ejs` template (e.g. `expo-module-template` package).
 */
async function createModuleFromTemplate(templatePath, targetPath, data) {
    const files = await getFilesAsync(templatePath);
    // Iterate through all template files.
    for (const file of files) {
        const renderedRelativePath = ejs_1.default.render(file.replace(/^\$/, ''), data, {
            openDelimiter: '{',
            closeDelimiter: '}',
            escape: (value) => value.replace('.', path_1.default.sep),
        });
        const fromPath = path_1.default.join(templatePath, file);
        const toPath = path_1.default.join(targetPath, renderedRelativePath);
        const template = await fs_extra_1.default.readFile(fromPath, { encoding: 'utf8' });
        const renderedContent = ejs_1.default.render(template, data);
        await fs_extra_1.default.outputFile(toPath, renderedContent, { encoding: 'utf8' });
    }
}
/**
 * Asks the user for the package slug (npm package name).
 */
async function askForPackageSlugAsync(customTargetPath) {
    const { slug } = await (0, prompts_1.default)((0, prompts_2.getSlugPrompt)(customTargetPath), {
        onCancel: () => process.exit(0),
    });
    return slug;
}
/**
 * Asks the user for some data necessary to render the template.
 * Some values may already be provided by command options, the prompt is skipped in that case.
 */
async function askForSubstitutionDataAsync(slug) {
    const promptQueries = await (0, prompts_2.getSubstitutionDataPrompts)(slug);
    // Stop the process when the user cancels/exits the prompt.
    const onCancel = () => {
        process.exit(0);
    };
    const { name, description, package: projectPackage, authorName, authorEmail, authorUrl, repo, } = await (0, prompts_1.default)(promptQueries, { onCancel });
    return {
        project: {
            slug,
            name,
            version: '0.1.0',
            description,
            package: projectPackage,
        },
        author: `${authorName} <${authorEmail}> (${authorUrl})`,
        license: 'MIT',
        repo,
    };
}
/**
 * Checks whether the target directory is empty and if not, asks the user to confirm if he wants to continue.
 */
async function confirmTargetDirAsync(targetDir) {
    const files = await fs_extra_1.default.readdir(targetDir);
    if (files.length === 0) {
        return;
    }
    const { shouldContinue } = await (0, prompts_1.default)({
        type: 'confirm',
        name: 'shouldContinue',
        message: `The target directory ${chalk_1.default.magenta(targetDir)} is not empty, do you want to continue anyway?`,
        initial: true,
    }, {
        onCancel: () => false,
    });
    if (!shouldContinue) {
        process.exit(0);
    }
}
const program = new commander_1.Command();
program
    .name(packageJson.name)
    .version(packageJson.version)
    .description(packageJson.description)
    .arguments('[path]')
    .option('-s, --source <source_dir>', 'Local path to the template. By default it downloads `expo-module-template` from NPM.')
    .option('--with-readme', 'Whether to include README.md file.', false)
    .option('--with-changelog', 'Whether to include CHANGELOG.md file.', false)
    .option('--no-example', 'Whether to skip creating the example app.', false)
    .action(main);
program.parse(process.argv);
//# sourceMappingURL=create-expo-module.js.map