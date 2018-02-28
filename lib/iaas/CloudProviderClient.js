'use strict';

const _ = require('lodash');
const pkgcloud = require('pkgcloud');
const Promise = require('bluebird');
const logger = require('../logger');
const errors = require('../errors');
const utils = require('../utils');
const ComputeClient = require('./ComputeClient');
const CONST = require('../constants');
const BaseCloudClient = require('./BaseCloudClient');

Promise.promisifyAll([
  pkgcloud.storage.Container,
  pkgcloud.storage.File
]);

const NotFound = errors.NotFound;
const Unauthorized = errors.Unauthorized;

class CloudProviderClient extends BaseCloudClient {
  constructor(settings) {
    super(settings);
    this.pkgcloudProvider = pkgcloud.providers[this.provider];
    const providerConfig = _
      .chain(this.settings)
      .omit('name')
      .set('provider', this.provider)
      .value();
    this.storage = this.constructor.createStorageClient(_.cloneDeep(providerConfig));
    this.configureLogging(this.storage);
    this.storage.getFilesAsync = Promise.promisify(this.storage.getFiles, {
      multiArgs: true
    });
    this.blockstorage = this.constructor.createComputeClient(_.cloneDeep(providerConfig));
    this.configureLogging(this.blockstorage);
    if (this.pkgcloudProvider.network !== undefined) {
      this.networkClient = this.constructor.createNetworkClient(_.cloneDeep(providerConfig));
      this.networkClient._requestAsync = Promise.promisify(this.networkClient._request);
      this.configureLogging(this.networkClient);
      this.iaasClient = this.getIaasClient();
    }
  }

  getIaasClient() {
    switch (this.provider) {
    case 'openstack':
      return new OpenStackClient(this);
    default:
      return undefined;
    }
  }

  configureLogging(client) {
    if (client.on) {
      client.on('log::*', function onmessage(message, obj) {
        const event = _.nth(this.event.split('::'), 1);
        const level = _.includes([
          'warn',
          'info',
          'verbose',
          'debug'
        ], event) ? event : 'debug';
        if (obj) {
          logger.log(level, message, obj);
        } else {
          logger.log(level, message);
        }
      });
    }
  }

  getContainer(container) {
    logger.info('getting container..', container);
    if (arguments.length < 1) {
      container = this.containerName;
    }
    return this.storage.getContainerAsync(container);
  }

  list(container, options) {
    if (arguments.length < 2) {
      options = container;
      container = this.containerName;
    }
    return this.storage
      .getFilesAsync(container, options)
      .then(listOfFiles => {
        let list = [];
        let isTruncated = false;
        if (listOfFiles[0] instanceof Array) {
          list = listOfFiles[0];
          isTruncated = _.get(listOfFiles[1], 'isTruncated') ? true : false;
        } else {
          list = listOfFiles;
        }
        const files = [];
        _.each(list, file =>  files.push(_
          .chain(file)
          .pick('name', 'lastModified')
          .set('isTruncated', isTruncated)
          .value()
        ));
        return files;
      });
  }

  remove(container, file) {
    if (arguments.length < 2) {
      file = container;
      container = this.containerName;
    }
    logger.debug(`Deleting file ${file} in container ${container} `);
    return this.storage
      .removeFileAsync(container, file)
      .catch(BaseCloudClient.providerErrorTypes.Unauthorized, err => {
        logger.error(err.message);
        throw new Unauthorized('Authorization at the cloud storage provider failed');
      })
      .catchThrow(BaseCloudClient.providerErrorTypes.NotFound, new NotFound(`Object '${file}' not found`));
  }

  download(options) {
    return Promise
      .try(() => this.storage.download(options))
      .then(utils.streamToPromise)
      .catchThrow(BaseCloudClient.providerErrorTypes.NotFound, new NotFound(`Object '${options.remote}' not found`));
  }

  upload(options, buffer) {
    return new Promise((resolve, reject) => {
      function cleanup() {
        stream.removeListener('error', onerror);
        stream.removeListener('success', onsuccess);
      }

      function onerror(err) {
        cleanup();
        reject(err);
      }

      function onsuccess(file) {
        cleanup();
        resolve(file.toJSON());
      }

      const stream = this.storage.upload(options);
      stream.once('error', onerror);
      stream.once('success', onsuccess);
      stream.end(buffer);
    });
  }

  uploadJson(container, file, data) {
    if (arguments.length < 3) {
      data = file;
      file = container;
      container = this.containerName;
    }
    return this
      .upload({
        container: this.containerName,
        remote: file,
        headers: {
          'content-type': 'application/json'
        }
      }, new Buffer(JSON.stringify(data, null, 2), 'utf8'));
  }

  downloadJson(container, file) {
    if (arguments.length < 2) {
      file = container;
      container = this.containerName;
    }
    return this
      .download({
        container: this.containerName,
        remote: file
      })
      .then((data) => {
        const response = JSON.parse(data);
        response.trigger = response.trigger === CONST.BACKUP.TRIGGER.MANUAL ? CONST.BACKUP.TRIGGER.SCHEDULED : response.trigger;
        //The above conversion is done to handle existing CRON Jobs which set this trigger as 'manual' even for scheduled Jobs
        //Above conversion can be removed and code changes can be revereted 14 days after the current fix goes live
        return response;
      })
      .catchThrow(SyntaxError, new NotFound(`Object '${file}' not found`));
  }

  deleteSnapshot(snapshotId) {
    return Promise
      .try(() => {
        return this.blockstorage
          .deleteSnapshot({
            SnapshotId: snapshotId
          })
          .promise()
          .then(retval => logger.info(`Deleted snapshot ${snapshotId}`, retval))
          .catch(err => logger.error('Error occured while deleting snapshot', err));
      });
  }

  createSecurityGroup(name, description) {
    if (this.iaasClient) {
      return this.iaasClient.createSecurityGroup(name, description);
    } else {
      throw errors.NotImplemented(`createSecurityGroup not implmented by provider for : ${this.provider}`);
    }
  }

  createSecurityRules(securityRules) {
    if (this.iaasClient) {
      return Promise.map(securityRules, securityRule => this.networkClient.createSecurityGroupRuleAsync(securityRule));
    } else {
      throw errors.NotImplemented(`createSecurityRules not implmented by provider for : ${this.provider}`);
    }
  }

  getSecurityGroup(name, throwIfNotFound) {
    if (this.iaasClient) {
      return this.iaasClient.getSecurityGroup(name, throwIfNotFound);
    } else {
      return Promise.resolve({});
      //throw new errors.NotImplemented(`getSecurityGroup not implmented by provider for : ${this.provider}`);
    }
  }

  static createStorageClient(options) {
    if (options.authUrl && options.keystoneAuthVersion) {
      const pattern = new RegExp(`\/${options.keystoneAuthVersion}\/?$`);
      options.authUrl = options.authUrl.replace(pattern, '');
    }
    return Promise.promisifyAll(pkgcloud.storage.createClient(options));
  }

  static createNetworkClient(options) {
    if (options.authUrl && options.keystoneAuthVersion) {
      const pattern = new RegExp(`\/${options.keystoneAuthVersion}\/?$`);
      options.authUrl = options.authUrl.replace(pattern, '');
    }
    return Promise.promisifyAll(pkgcloud.network.createClient(options));
  }

  static createComputeClient(settings) {
    return ComputeClient.createComputeClient(settings).value();
  }
}

class OpenStackClient {
  constructor(cloudProviderClient) {
    this.cloudProviderClient = cloudProviderClient;
  }

  createSecurityGroup(name, description) {
    return Promise.try(() => this.cloudProviderClient.networkClient.createSecurityGroupAsync({
        name: name,
        description: description,
        tenant_id: this.cloudProviderClient.settings.tenantId
      }))
      .then(() => this.getSecurityGroup(name))
      .tap(securityGroup => {
        logger.info('Security group info..', securityGroup);
        return Promise.try(() => securityGroup.securityGroupRules)
          .each(securityRule => this.cloudProviderClient.networkClient.destroySecurityGroupRuleAsync(securityRule.id));
      })
      .then(securityGroup => {
        securityGroup.securityGroupRules = [];
        return securityGroup;
      });
  }

  getSecurityGroup(name, throwIfNotFound) {
    let options = {
      method: 'GET',
      path: 'security-groups',
      qs: {
        tenant_id: this.cloudProviderClient.settings.tenantId,
        name: name
      }
    };

    const networkClient = this.cloudProviderClient.networkClient;
    logger.info('getting security group....');
    return networkClient
      ._requestAsync.call(networkClient, options)
      .then(body => body.security_groups.map((securityGroup) =>
        (new networkClient.models.SecurityGroup(this.cloudProviderClient.networkClient, securityGroup))
      ))
      .then(securityGroups => {
        let securityGroup = _.find(securityGroups, item => item.name === name);
        if (!securityGroup && throwIfNotFound) {
          logger.error(`Security group ${name} not found`);
          throw new errors.NotFound(`Security group ${name} not found`);
        }
        logger.debug(`security group ${name} retrieved successfully`, securityGroup);
        return securityGroup;
      });
  }

}

module.exports = CloudProviderClient;