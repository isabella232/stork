'use strict';

const querystring = require('querystring');
const AWS = require('aws-sdk');
const got = require('got');

/**
 * Add a webhook to a Github repository for a single stork region
 * @param  {Object}  options              - configuration
 * @param  {String}  options.region       - the stork region
 * @param  {String}  options.suffix       - the stork stack suffix
 * @param  {String}  options.token        - github access token (repo, user)
 * @param  {String}  options.org          - github repo's owner
 * @param  {String}  options.repo         - github repo's name
 * @return {Promise}                      - resolves when the hook has been created
 */
const setupHook = (options) => {
  const cfn = new AWS.CloudFormation({ region: options.region });
  const lambda = new AWS.Lambda({ region: options.region });

  const repo = () => {
    const query = { access_token: options.token };

    const config = {
      json: true,
      headers: {
        'User-Agent': 'github.com/mapbox/stork',
        'Content-Type': 'application/json'
      }
    };

    const uri = `https://api.github.com/repos/${options.org}/${options.repo}`;

    return got.get(`${uri}?${querystring.stringify(query)}`, config)
      .then((data) => data.body.id);
  };

  return Promise.all([
    repo(),
    cfn.describeStacks({ StackName: `stork-${options.suffix}` }).promise()
  ]).then((results) => {
    const repoId = results[0];
    const data = results[1];

    const outputs = data.Stacks[0].Outputs;
    const installationId = Number(outputs
      .find((output) => output.OutputKey === 'GithubAppInstallationId')
      .OutputValue);
    const FunctionName = outputs
      .find((output) => output.OutputKey === 'GatekeeperLambda')
      .OutputValue;

    return lambda.invoke({
      FunctionName,
      InvocationType: 'RequestResponse',
      Payload: JSON.stringify({ repoId, installationId })
    }).promise();
  });
};

module.exports = { setupHook };
