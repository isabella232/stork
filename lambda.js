'use strict';

/* eslint-disable no-console */

const fs = require('fs');
const path = require('path');
const got = require('got');
const querystring = require('querystring');
const AWS = require('aws-sdk');

const projectName = (org, repo, imageUri) => {
  const imageName = imageUri.split('/').pop()
    .replace(/:/g, '_')
    .replace(/\./g, '_');
  return `${org}_${repo}_${imageName}`;
};

/**
 * Find an existing CodeBuild project for a repository.
 *
 * @param {object} options
 * @param {string} options.org
 * @param {string} options.repo
 * @param {string} options.imageUri
 * @param {string} options.region - for the CodeBuild project
 * @returns {Promise} CodeBuild project information
 */
const findProject = (options) => {
  const codebuild = new AWS.CodeBuild({ region: options.region });
  const name = projectName(options.org, options.repo, options.imageUri);

  console.log(`Looking for project: ${name}`);

  return codebuild.batchGetProjects({ names: [name] }).promise()
    .then((data) => data.projects[0]);
};

/**
 * Create a new CodeBuild project for a repository.
 *
 * @param {object} options
 * @param {string} options.org
 * @param {string} options.repo
 * @param {string} options.imageUri
 * @param {string} options.size - small, medium, or large
 * @param {string} options.bucket
 * @param {string} options.prefix
 * @param {string} options.region - for the CodeBuild project
 * @param {string} options.role - ARN for project's IAM role
 * @param {string} options.status - ARN for status Lambda function
 * @param {string} options.token - Github access token
 * @param {boolean} options.oauth
 * @returns {Promise} CodeBuild project information
 */
const createProject = (options) => {
  const project = {
    name: projectName(options.org, options.repo, options.imageUri),
    description: `Lambda builds for ${options.org}/${options.repo}`,
    serviceRole: options.role,
    source: {
      type: 'GITHUB',
      location: options.oauth
        ? `https://github.com/${options.org}/${options.repo}`
        : `https://${options.token}@github.com/${options.org}/${options.repo}`,
      auth: options.oauth
        ? { type: 'OAUTH' }
        : undefined
    },
    artifacts: {
      type: 'S3',
      packaging: 'ZIP',
      location: options.bucket,
      path: `${options.prefix}/${options.repo}`
    },
    environment: {
      type: 'LINUX_CONTAINER',
      image: options.imageUri,
      computeType: `BUILD_GENERAL1_${options.size.toUpperCase()}`
    }
  };

  const rule = {
    Name: project.name,
    Description: `Build status notifications for ${project.name}`,
    EventPattern: JSON.stringify({
      source: ['aws.codebuild'],
      'detail-type': ['CodeBuild Build State Change'],
      detail: {
        'build-status': ['IN_PROGRESS', 'SUCCEEDED', 'FAILED', 'STOPPED']
      },
      'project-name': [project.name]
    }),
    State: 'ENABLED'
  };

  const codebuild = new AWS.CodeBuild({ region: options.region });
  const events = new AWS.CloudWatchEvents({ region: options.region });

  return Promise.all([
    codebuild.createProject(project).promise(),
    events.putRule(rule).promise().then((data) => {
      const target = {
        Rule: data.RuleArn,
        Targets: [{ Id: 'invoke-lambda', Arn: options.status }]
      };
      return events.putTargets(target).promise();
    })
  ]).then((results) => results[0].project);
};

/**
 * Run a build for a particular commit to a repository.
 *
 * @param {object} options
 * @param {string} options.org
 * @param {string} options.repo
 * @param {string} options.imageUri
 * @param {string} options.sha
 * @param {string} options.bucket
 * @param {string} options.prefix
 * @param {string} [options.buildspec]
 * @returns {Promise} build information
 */
const runBuild = (options) => {
  const params = {
    projectName: projectName(options.org, options.repo, options.imageUri),
    sourceVersion: options.sha,
    artifactsOverride: {
      type: 'S3',
      packaging: 'ZIP',
      location: options.bucket,
      path: `${options.prefix}/${options.repo}`,
      name: `${options.sha}.zip`
    }
  };

  if (options.buildspec) params.buildspecOverride = options.buildspec;

  const codebuild = new AWS.CodeBuild({ region: options.region });
  return codebuild.startBuild(params).promise()
    .then((data) => data.build);
};

/**
 * Gets a file from Github.
 *
 * @param {object} options
 * @param {string} options.org
 * @param {string} options.repo
 * @param {string} options.sha
 * @param {string} options.token
 * @param {string} options.path
 */
const getFromGithub = (options) => {
  const query = {
    access_token: options.token,
    ref: options.sha
  };

  const config = {
    json: true,
    headers: { 'User-Agent': 'github.com/mapbox/bundle-shepherd' }
  };

  const uri = `https://api.github.com/repos/${options.org}/${options.repo}/contents/${options.path}`;

  return got
    .get(`${uri}?${querystring.stringify(query)}`, config)
    .then((data) => data.body)
    .catch((err) => err);
};

/**
 * Checks the org/repo@sha for a configuration file and/or buildspec.yml
 *
 * @param {object} options
 * @param {string} options.org
 * @param {string} options.repo
 * @param {string} options.sha
 * @param {string} options.token
 */
const checkRepoOverrides = (options) => {
  return Promise.all([
    getFromGithub(Object.assign({ path: 'buildspec.yml' }, options)),
    getFromGithub(Object.assign({ path: '.bundle-shepherd.json' }, options))
  ]).then((data) => {
    const buildspec = data[0];
    let config = data[1];

    const result = {
      buildspec: false,
      image: 'nodejs6.x',
      size: 'small'
    };

    if (buildspec.type === 'file') result.buildspec = true;
    if (config.type === 'file') {
      config = Buffer.from(config.content, config.encoding).toString('utf8');
      config = JSON.parse(config);
      if (config.image) result.image = config.image;
      if (config.size) result.size = config.size;
    }

    console.log(`Override result: ${JSON.stringify(result)}`);

    return result;
  });
};

/**
 * Get image URI for default images
 *
 * @param {object} options
 * @param {string} options.accountId
 * @param {string} options.region
 * @param {string} options.imageName
 * @returns
 */
const getImageUri = (options) => {
  const defaultImages = {
    'nodejs6.x': `${options.accountId}.dkr.ecr.${options.region}.amazonaws.com/bundle-shepherd:nodejs6.x`
  };

  return defaultImages[options.imageName] || options.imageName;
};

/**
 * Get the default buildspec.yml as text.
 *
 * @param {object} defaultImage
 * @returns {string} the default buildspec.yml as a string
 */
const getDefaultBuildspec = (defaultImage) => {
  const buildspec = path.resolve(__dirname, 'buildspecs', `${defaultImage}.yml`);
  return fs.readFileSync(buildspec, 'utf8');
};

const trigger = (event, context, callback) => {
  const commit = JSON.parse(event.Records[0].Sns.Message);
  const options = {
    org: commit.repository.owner.name,
    repo: commit.repository.name,
    sha: commit.after,
    token: process.env.GITHUB_ACCESS_TOKEN,
    accountId: process.env.AWS_ACCOUNT_ID,
    region: process.env.AWS_DEFAULT_REGION,
    bucket: process.env.S3_BUCKET,
    prefix: process.env.S3_PREFIX,
    role: process.env.PROJECT_ROLE,
    status: process.env.STATUS_FUNCTION,
    oauth: process.env.USE_OAUTH === 'true' ? true : false
  };

  console.log(`Looking for repo overrides in ${options.org}/${options.repo}@${options.sha}`);

  return checkRepoOverrides(options)
    .then((config) => {
      options.imageUri = getImageUri(Object.assign({ imageName: config.image }, options));
      options.size = config.size;

      console.log(`Looking for existing project for ${options.org}/${options.repo} using image ${options.image}`);

      return Promise.all([config, findProject(options)]);
    })
    .then((results) => {
      const config = results[0];
      const project = results[1];

      console.log(project
        ? 'Found existing project'
        : 'Creating a new project'
      );

      return Promise.all([
        config,
        project ? project : createProject(options)
      ]);
    })
    .then((results) => {
      const config = results[0];
      if (!config.buildspec)
        options.buildspec = getDefaultBuildspec(config.image);

      console.log(`Running a build for ${options.org}/${options.repo}@${options.sha}`);

      return runBuild(options);
    })
    .then((data) => callback(null, data))
    .catch((err) => callback(err));
};

const status = (event, context, callback) => {
  console.log(JSON.stringify(event));
  callback();
};

module.exports = {
  trigger,
  status
};