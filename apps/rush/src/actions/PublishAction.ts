// Copyright (c) Microsoft Corporation. All rights reserved. Licensed under the MIT license.
// See LICENSE in the project root for license information.

import * as colors from 'colors';
import * as path from 'path';
import { EOL } from 'os';
import {
  CommandLineAction,
  CommandLineFlagParameter,
  CommandLineStringParameter
} from '@microsoft/ts-command-line';
import {
  IChangeInfo,
  ChangeType,
  RushConfiguration,
  RushConfigurationProject,
  Utilities,
  Npm
} from '@microsoft/rush-lib';
import RushCommandLineParser from './RushCommandLineParser';
import PublishUtilities, {
  IChangeInfoHash
} from '../utilities/PublishUtilities';
import ChangelogGenerator from '../utilities/ChangelogGenerator';
import GitPolicy from '../utilities/GitPolicy';
import PrereleaseToken from '../utilities/PrereleaseToken';
import ChangeFiles from '../utilities/ChangeFiles';

export default class PublishAction extends CommandLineAction {
  private _addCommitDetails: CommandLineFlagParameter;
  private _apply: CommandLineFlagParameter;
  private _includeAll: CommandLineFlagParameter;
  private _npmAuthToken: CommandLineStringParameter;
  private _rushConfiguration: RushConfiguration;
  private _parser: RushCommandLineParser;
  private _publish: CommandLineFlagParameter;
  private _regenerateChangelogs: CommandLineFlagParameter;
  private _registryUrl: CommandLineStringParameter;
  private _targetBranch: CommandLineStringParameter;
  private _prereleaseName: CommandLineStringParameter;
  private _suffix: CommandLineStringParameter;
  private _force: CommandLineFlagParameter;
  private _prereleaseToken: PrereleaseToken;

  constructor(parser: RushCommandLineParser) {
    super({
      actionVerb: 'publish',
      summary:
      'Reads and processes package publishing change requests generated by "rush change". This is typically ' +
      'only executed by a CI workflow.',
      documentation:
      'Reads and processes package publishing change requests generated by "rush change". This will perform a ' +
      'read-only operation by default, printing operations executed to the console. To actually commit ' +
      'changes and publish packages, you must use the --commit flag.'
    });
    this._parser = parser;
  }

  protected onDefineParameters(): void {
    this._apply = this.defineFlagParameter({
      parameterLongName: '--apply',
      parameterShortName: '-a',
      description: 'If this flag is specified, the change requests will be applied to package.json files.'
    });
    this._targetBranch = this.defineStringParameter({
      parameterLongName: '--target-branch',
      parameterShortName: '-b',
      description:
      'If this flag is specified, applied changes and deleted change requests will be' +
      'committed and merged into the target branch.'
    });
    this._publish = this.defineFlagParameter({
      parameterLongName: '--publish',
      parameterShortName: '-p',
      description: 'If this flag is specified, applied changes will be published to npm.'
    });
    this._addCommitDetails = this.defineFlagParameter({
      parameterLongName: '--add-commit-details',
      parameterShortName: undefined,
      description: 'Adds commit author and hash to the changelog.json files for each change.'
    });
    this._regenerateChangelogs = this.defineFlagParameter({
      parameterLongName: '--regenerate-changelogs',
      parameterShortName: undefined,
      description: 'Regenerates all changelog files based on the current JSON content.'
    });
    this._registryUrl = this.defineStringParameter({
      parameterLongName: '--registry',
      parameterShortName: '-r',
      description:
      `Publishes to a specified NPM registry. If this is specified, it will prevent the commit to be tagged.`
    });
    this._npmAuthToken = this.defineStringParameter({
      parameterLongName: '--npm-auth-token',
      parameterShortName: '-n',
      description:
      'Provide the default scope npm auth token to be passed into npm publish for global package publishing.'
    });
    this._includeAll = this.defineFlagParameter({
      parameterLongName: '--include-all',
      parameterShortName: undefined,
      description: 'If this flag is specified with --publish, all packages with ShouldPublish being true ' +
      'will be published if their version is newer than published version.'
    });
    this._prereleaseName = this.defineStringParameter({
      parameterLongName: '--prerelease-name',
      parameterShortName: '-pn',
      description: 'Bump up to a prerelease version with the provided prerelease name.'
    });
    this._suffix = this.defineStringParameter({
      parameterLongName: '--suffix',
      description: 'Append a suffix to all changed versions. Cannot use with prerelease-name at the same time.'
    });
    this._force = this.defineFlagParameter({
      parameterLongName: '--force',
      parameterShortName: undefined,
      description: 'If this flag is specified with --publish, packages will be published with --force on npm'
    });
  }

  /**
   * Executes the publish action, which will read change request files, apply changes to package.jsons,
   */
  protected onExecute(): void {
    console.log(`Starting "rush publish" ${EOL}`);

    this._rushConfiguration = RushConfiguration.loadFromDefaultLocation();
    if (!GitPolicy.check(this._rushConfiguration)) {
      process.exit(1);
      return;
    }
    const allPackages: Map<string, RushConfigurationProject> = this._rushConfiguration.projectsByName;

    if (this._regenerateChangelogs.value) {
      console.log('Regenerating changelogs');
      ChangelogGenerator.regenerateChangelogs(allPackages);
      return;
    }

    if (this._includeAll.value && this._publish.value) {
      this._publishAll(allPackages);
    } else {
      this._prereleaseToken = new PrereleaseToken(this._prereleaseName.value, this._suffix.value);
      this._publishChanges(allPackages);
    }

    console.log(EOL + colors.green('Rush publish finished successfully.'));
  }

  private _publishChanges(allPackages: Map<string, RushConfigurationProject>): void {
    const changesPath: string = path.join(this._rushConfiguration.commonFolder, 'changes');
    const changeFiles: ChangeFiles = new ChangeFiles(changesPath);
    const allChanges: IChangeInfoHash = PublishUtilities.findChangeRequests(
      allPackages,
      changeFiles,
      this._addCommitDetails.value,
      this._prereleaseToken);
    const orderedChanges: IChangeInfo[] = PublishUtilities.sortChangeRequests(allChanges);

    if (orderedChanges.length > 0) {
      const tempBranch: string = 'publish-' + new Date().getTime();

      // Make changes in temp branch.
      this._gitCheckout(tempBranch, true);

      // Apply all changes to package.json files.
      PublishUtilities.updatePackages(allChanges, allPackages, this._apply.value,
        this._prereleaseToken);

      // Do not update changelog or delete the change files for prerelease.
      // Save them for the official release.
      if (!this._prereleaseToken.hasValue) {
        // Update changelogs.
        ChangelogGenerator.updateChangelogs(allChanges, allPackages, this._apply.value);

        // Remove the change request files only if "-a" or "-b" was provided
        changeFiles.deleteAll(this._apply.value || !!this._targetBranch.value);
      }

      // Stage, commit, and push the changes to remote temp branch.
      this._gitAddChanges();
      this._gitCommit();
      this._gitPush(tempBranch);

      // NPM publish the things that need publishing.
      for (const change of orderedChanges) {
        if (change.changeType > ChangeType.dependency) {
          this._npmPublish(change.packageName, allPackages.get(change.packageName).projectFolder);
        }
      }

      // Create and push appropriate git tags.
      this._gitAddTags(orderedChanges);
      this._gitPush(tempBranch);

      // Now merge to target branch.
      this._gitCheckout(this._targetBranch.value);
      this._gitPull();
      this._gitMerge(tempBranch);
      this._gitPush(this._targetBranch.value);
      this._gitDeleteBranch(tempBranch);
    }
  }

  private _publishAll(allPackages: Map<string, RushConfigurationProject>): void {
    let updated: boolean = false;
    allPackages.forEach((packageConfig, packageName) => {
      if (packageConfig.shouldPublish) {
        if (this._force.value || !this._packageExists(packageConfig)) {
          this._npmPublish(packageName, packageConfig.projectFolder);
          this._gitAddTag(packageName, packageConfig.packageJson.version);
          updated = true;
        } else {
          console.log(`Skip ${packageName}. Not updated.`);
        }
      }
    });
    if (updated) {
      this._gitPush(this._targetBranch.value);
    }
  }

  private _getEnvArgs(): { [key: string]: string } {
    const env: { [key: string]: string } = {};

    // Copy existing process.env values (for nodist)
    Object.keys(process.env).forEach((key: string) => {
      env[key] = process.env[key];
    });
    return env;
  }

  private _execCommand(
    shouldExecute: boolean,
    command: string,
    args: string[] = [],
    workingDirectory: string = process.cwd(),
    env?: { [key: string]: string }
  ): void {

    let relativeDirectory: string = path.relative(process.cwd(), workingDirectory);
    const envArgs: { [key: string]: string } = this._getEnvArgs();

    if (relativeDirectory) {
      relativeDirectory = `(${relativeDirectory})`;
    }

    if (env) {
      Object.keys(env).forEach((name: string) => envArgs[name] = env[name]);
    }

    console.log(
      `${EOL}* ${shouldExecute ? 'EXECUTING' : 'DRYRUN'}: ${command} ${args.join(' ')} ${relativeDirectory}`
    );

    if (shouldExecute) {
      Utilities.executeCommand(
        command,
        args,
        workingDirectory,
        false,
        env);
    }
  }

  private _gitCheckout(branchName: string, createBranch?: boolean): void {
    const params: string = `checkout ${createBranch ? '-b ' : ''}${branchName}`;

    this._execCommand(!!this._targetBranch.value, 'git', params.split(' '));
  }

  private _gitMerge(branchName: string): void {
    this._execCommand(!!this._targetBranch.value, 'git', `merge ${branchName} --no-edit`.split(' '));
  }

  private _gitDeleteBranch(branchName: string): void {
    this._execCommand(!!this._targetBranch.value, 'git', `branch -d ${branchName}`.split(' '));
    this._execCommand(!!this._targetBranch.value, 'git', `push origin --delete ${branchName}`.split(' '));
  }

  private _gitPull(): void {
    this._execCommand(!!this._targetBranch.value, 'git', `pull origin ${this._targetBranch.value}`.split(' '));
  }

  private _gitAddChanges(): void {
    this._execCommand(!!this._targetBranch.value, 'git', ['add', '.']);
  }

  private _gitAddTags(orderedChanges: IChangeInfo[]): void {
    for (const change of orderedChanges) {
      if (
        change.changeType > ChangeType.dependency &&
        this._rushConfiguration.projectsByName.get(change.packageName).shouldPublish
      ) {
        this._gitAddTag(change.packageName, change.newVersion);
      }
    }
  }

  private _gitAddTag(packageName: string, packageVersion: string): void {
    // Tagging only happens if we're publishing to real NPM and committing to git.
    const tagName: string = PublishUtilities.createTagname(packageName, packageVersion);
    this._execCommand(
      !!this._targetBranch.value && !!this._publish.value && !this._registryUrl.value,
      'git',
      ['tag', '-a', tagName, '-m', `"${packageName} v${packageVersion}"`]);
  }

  private _gitCommit(): void {
    this._execCommand(!!this._targetBranch.value, 'git', ['commit', '-m', '"Applying package updates."']);
  }

  private _gitPush(branchName: string): void {
    this._execCommand(
      !!this._targetBranch.value,
      'git',
      ['push', 'origin', 'HEAD:' + branchName, '--follow-tags', '--verbose']);
  }

  private _npmPublish(packageName: string, packagePath: string): void {
    const env: { [key: string]: string } = this._getEnvArgs();
    const args: string[] = ['publish'];

    if (this._rushConfiguration.projectsByName.get(packageName).shouldPublish) {
      let registry: string = '//registry.npmjs.org/';
      if (this._registryUrl.value) {
        const registryUrl: string = this._registryUrl.value;
        env['npm_config_registry'] = registryUrl; // tslint:disable-line:no-string-literal
        registry = registryUrl.substring(registryUrl.indexOf('//'));
      }

      if (this._npmAuthToken.value) {
        args.push(`--${registry}:_authToken=${this._npmAuthToken.value}`);
      }

      if (this._force.value) {
        args.push(`--force`);
      }

      this._execCommand(
        !!this._publish.value,
        this._rushConfiguration.npmToolFilename,
        args,
        packagePath,
        env);
    }
  }

  private _packageExists(packageConfig: RushConfigurationProject): boolean {
    const env: { [key: string]: string } = this._getEnvArgs();
    if (this._registryUrl.value) {
      env['npm_config_registry'] = this._registryUrl.value; // tslint:disable-line:no-string-literal
    }
    const publishedVersions: string[] = Npm.publishedVersions(packageConfig.packageName,
      packageConfig.projectFolder,
      env);
    return publishedVersions.indexOf(packageConfig.packageJson.version) >= 0;
  }
}