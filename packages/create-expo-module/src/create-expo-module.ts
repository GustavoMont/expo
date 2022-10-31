import spawnAsync from '@expo/spawn-async';
import chalk from 'chalk';
import { Command } from 'commander';
import downloadTarball from 'download-tarball';
import ejs from 'ejs';
import fs from 'fs-extra';
import { boolish } from 'getenv';
import path from 'path';
import prompts from 'prompts';

import { createExampleApp } from './createExampleApp';
import { installDependencies } from './packageManager';
import { getSlugPrompt, getSubstitutionDataPrompts } from './prompts';
import { resolvePackageManager } from './resolvePackageManager';
import { CommandOptions, SubstitutionData } from './types';
import { newStep } from './utils';

const debug = require('debug')('create-expo-module:main') as typeof console.log;
const packageJson = require('../package.json');

// Opt in to using beta versions
const EXPO_BETA = boolish('EXPO_BETA', false);

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
async function main(target: string | undefined, options: CommandOptions) {
  const slug = await askForPackageSlugAsync(target);
  const targetDir = path.join(CWD, target || slug);

  await fs.ensureDir(targetDir);
  await confirmTargetDirAsync(targetDir);

  options.target = targetDir;

  const data = await askForSubstitutionDataAsync(slug);

  // Make one line break between prompts and progress logs
  console.log();

  const packageManager = await resolvePackageManager();
  const packagePath = options.source
    ? path.join(CWD, options.source)
    : await downloadPackageAsync(targetDir);

  await newStep('Creating the module from template files', async (step) => {
    await createModuleFromTemplate(packagePath, targetDir, data);
    step.succeed('Created the module from template files');
  });

  await newStep('Installing module dependencies', async (step) => {
    await installDependencies(packageManager, targetDir);
    step.succeed('Installed module dependencies');
  });

  await newStep('Compiling TypeScript files', async (step) => {
    await spawnAsync(packageManager, ['run', 'build'], {
      cwd: targetDir,
      stdio: 'ignore',
    });
    step.succeed('Compiled TypeScript files');
  });

  if (!options.source) {
    // Files in the downloaded tarball are wrapped in `package` dir.
    // We should remove it after all.
    await fs.remove(packagePath);
  }
  if (!options.withReadme) {
    await fs.remove(path.join(targetDir, 'README.md'));
  }
  if (!options.withChangelog) {
    await fs.remove(path.join(targetDir, 'CHANGELOG.md'));
  }
  if (options.example) {
    // Create "example" folder
    await createExampleApp(data, targetDir, packageManager);
  }

  console.log();
  console.log('✅ Successfully created Expo module');
}

/**
 * Recursively scans for the files within the directory. Returned paths are relative to the `root` path.
 */
async function getFilesAsync(root: string, dir: string | null = null): Promise<string[]> {
  const files: string[] = [];
  const baseDir = dir ? path.join(root, dir) : root;

  for (const file of await fs.readdir(baseDir)) {
    const relativePath = dir ? path.join(dir, file) : file;

    if (IGNORES_PATHS.includes(relativePath) || IGNORES_PATHS.includes(file)) {
      continue;
    }

    const fullPath = path.join(baseDir, file);
    const stat = await fs.lstat(fullPath);

    if (stat.isDirectory()) {
      files.push(...(await getFilesAsync(root, relativePath)));
    } else {
      files.push(relativePath);
    }
  }
  return files;
}

/**
 * Asks NPM registry for the url to the tarball.
 */
async function getNpmTarballUrl(packageName: string, version: string = 'latest'): Promise<string> {
  debug(`Using module template ${chalk.bold(packageName)}@${chalk.bold(version)}`);
  const { stdout } = await spawnAsync('npm', ['view', `${packageName}@${version}`, 'dist.tarball']);
  return stdout.trim();
}

/**
 * Downloads the template from NPM registry.
 */
async function downloadPackageAsync(targetDir: string): Promise<string> {
  return await newStep('Downloading module template from npm', async (step) => {
    const tarballUrl = await getNpmTarballUrl(
      'expo-module-template',
      EXPO_BETA ? 'next' : 'latest'
    );

    await downloadTarball({
      url: tarballUrl,
      dir: targetDir,
    });

    step.succeed('Downloaded module template from npm');

    return path.join(targetDir, 'package');
  });
}

/**
 * Creates the module based on the `ejs` template (e.g. `expo-module-template` package).
 */
async function createModuleFromTemplate(
  templatePath: string,
  targetPath: string,
  data: SubstitutionData
) {
  const files = await getFilesAsync(templatePath);

  // Iterate through all template files.
  for (const file of files) {
    const renderedRelativePath = ejs.render(file.replace(/^\$/, ''), data, {
      openDelimiter: '{',
      closeDelimiter: '}',
      escape: (value: string) => value.replace('.', path.sep),
    });
    const fromPath = path.join(templatePath, file);
    const toPath = path.join(targetPath, renderedRelativePath);
    const template = await fs.readFile(fromPath, { encoding: 'utf8' });
    const renderedContent = ejs.render(template, data);

    await fs.outputFile(toPath, renderedContent, { encoding: 'utf8' });
  }
}

/**
 * Asks the user for the package slug (npm package name).
 */
async function askForPackageSlugAsync(customTargetPath?: string): Promise<string> {
  const { slug } = await prompts(getSlugPrompt(customTargetPath), {
    onCancel: () => process.exit(0),
  });
  return slug;
}

/**
 * Asks the user for some data necessary to render the template.
 * Some values may already be provided by command options, the prompt is skipped in that case.
 */
async function askForSubstitutionDataAsync(slug: string): Promise<SubstitutionData> {
  const promptQueries = await getSubstitutionDataPrompts(slug);

  // Stop the process when the user cancels/exits the prompt.
  const onCancel = () => {
    process.exit(0);
  };

  const {
    name,
    description,
    package: projectPackage,
    authorName,
    authorEmail,
    authorUrl,
    repo,
  } = await prompts(promptQueries, { onCancel });

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
async function confirmTargetDirAsync(targetDir: string): Promise<void> {
  const files = await fs.readdir(targetDir);

  if (files.length === 0) {
    return;
  }
  const { shouldContinue } = await prompts(
    {
      type: 'confirm',
      name: 'shouldContinue',
      message: `The target directory ${chalk.magenta(
        targetDir
      )} is not empty, do you want to continue anyway?`,
      initial: true,
    },
    {
      onCancel: () => false,
    }
  );
  if (!shouldContinue) {
    process.exit(0);
  }
}

const program = new Command();

program
  .name(packageJson.name)
  .version(packageJson.version)
  .description(packageJson.description)
  .arguments('[path]')
  .option(
    '-s, --source <source_dir>',
    'Local path to the template. By default it downloads `expo-module-template` from NPM.'
  )
  .option('--with-readme', 'Whether to include README.md file.', false)
  .option('--with-changelog', 'Whether to include CHANGELOG.md file.', false)
  .option('--no-example', 'Whether to skip creating the example app.', false)
  .action(main);

program.parse(process.argv);
