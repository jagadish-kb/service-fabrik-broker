'use strict';

const _ = require('lodash');
const nock = require('nock');
const lib = require('../../lib');
const logger = require('../../lib/logger');
const config = lib.config;
const provider = config.backup.provider;
const cloudProviderUrl = provider.authUrl;
const objectStoreUrl = `http://objectstore/v1/AUTH_${provider.tenantId}`;
const networkUrl = `https://cluster-4.eu-de-1.cloud.sap:8776/v2/${provider.tenantId}`;
const authToken = '5702f655079c43f5a36687976db0a404';

exports.auth = auth;
exports.getSecurityGroups = getSecurityGroups;
exports.download = download;
exports.upload = upload;
exports.headObject = headObject;
exports.getContainer = getContainer;
exports.list = list;
exports.remove = remove;

function auth() {
  const time = Date.now();
  const response = {
    body: {
      token: {
        expires_at: new Date(time + 365 * 24 * 60 * 60 * 1000),
        issued_at: new Date(time),
        project: {
          id: provider.tenantId
        },
        catalog: [{
            type: 'object-store',
            name: 'object-store',
            endpoints: [{
              region: provider.region,
              url: objectStoreUrl,
              interface: 'public'
            }]
          },
          {
            type: 'network',
            name: 'network',
            endpoints: [{
              url: networkUrl,
              region: provider.region,
              global: 'True',
              interface: 'public',
              id: 'f2db1a77cbb14237b9aec8ff938e8715'
            }]
          }
        ]
      }
    },
    headers: {
      'x-subject-token': authToken
    }
  };
  return nock(cloudProviderUrl)
    .replyContentLength()
    .post(`/${provider.keystoneAuthVersion}/auth/tokens`, body => _.isObject(body.auth))
    .reply(201, response.body, response.headers);
}

function getSecurityGroups(securityGroupName) {
  const headers = {
    'x-auth-token': authToken,
    'User-Agent': 'nodejs-pkgcloud/1.3.0'
  };
  const qs = {
    name: securityGroupName,
    tenant_id: provider.tenantId
  };
  return nock(`${networkUrl}`, {
      reqheaders: headers
    })
    .get('/v2.0/security-groups')
    .query(qs)
    .reply(200, {
      security_groups: [{
        id: 'a0813bfc-e331-41c5-80ce-3b40cde03d75',
        name: securityGroupName,
        description: 'Service Fabrik Bosh Services Network rules for Space d4731fb8-7b84-4f57-914f-c3d55d793dd4',
        tenantId: provider.tenantId,
        securityGroupRules: [{
          remote_group_id: null,
          direction: 'ingress',
          remote_ip_prefix: '10.14.0.0/16',
          protocol: 'tcp',
          ethertype: 'IPv4',
          tenant_id: provider.tenantId,
          port_range_max: 2717,
          port_range_min: 1024,
          id: '2f02b85d-cdf2-494a-b019-355f0030aca1',
          security_group_id: 'a0813bfc-e331-41c5-80ce-3b40cde03d75'
        }]
      }]
    });
}

function encodePath(pathname) {
  return pathname.replace(/:/g, '%3A');
}

function download(remote, body) {
  const headers = {
    'content-type': 'application/json'
  };
  let status = 200;
  if (body instanceof Error && body.status) {
    const err = _.pick(body, 'status', 'message');
    status = err.status;
    headers['content-type'] = 'text/html';
    body = `<h1>${err.message}</h1>`;
  } else if (_.isPlainObject(body)) {
    body = JSON.stringify(body);
  }
  return nock(objectStoreUrl)
    .replyContentLength()
    .get(encodePath(remote))
    .reply(status, body, headers);
}

function upload(remote, verifier) {
  return nock(objectStoreUrl)
    .replyContentLength()
    .put(encodePath(remote), verifier)
    .reply(201);
}

function headObject(remote) {
  return nock(objectStoreUrl)
    .replyContentLength()
    .head(encodePath(remote))
    .query({
      format: 'json'
    })
    .reply(200);
}

function remove(remote) {
  return nock(objectStoreUrl)
    .delete(encodePath(remote))
    .reply(204);
}

function getContainer(containerName) {
  return nock(objectStoreUrl)
    .replyContentLength()
    .head(`/${containerName}`)
    .reply(204, null, {
      'X-Container-Object-Count': 0
    });
}

function list(containerName, prefix, filenames, responseStatusCode) {
  const files = _
    .chain(filenames)
    .map(name => ({
      name: name,
      lastModified: new Date().toISOString()
    }))
    .value();
  const qs = {
    format: 'json'
  };
  if (prefix) {
    qs.prefix = prefix;
  }
  return nock(objectStoreUrl)
    .replyContentLength()
    .get(`/${containerName}`)
    .query(qs)
    .reply(responseStatusCode || 200, files, {
      'X-Container-Object-Count': '42'
    });
}