'use strict';

const _ = require('lodash');
const Promise = require('bluebird');
const BasePlatformManager = require('./BasePlatformManager');
const utils = require('../common/utils');
const assert = require('assert');
const errors = require('../common/errors');
const cloudController = require('../data-access-layer/cf').cloudController;
const logger = require('../common/logger');
const CONST = require('../common/constants');
const config = require('../common/config');
const SecurityGroupNotCreated = errors.SecurityGroupNotCreated;
const SecurityGroupNotFound = errors.SecurityGroupNotFound;
const InstanceSharingNotAllowed = errors.InstanceSharingNotAllowed;
const CrossOrganizationSharingNotAllowed = errors.CrossOrganizationSharingNotAllowed;
const ordinals = ['First', 'Second', 'Third', 'Fourth', 'Fifth', 'Sixth', 'Seventh', 'Eighth', 'Ninth', 'Tenth'];

class CfPlatformManager extends BasePlatformManager {
  constructor(platform) {
    super(platform);
    this.cloudController = cloudController;
  }

  getSecurityGroupName(guid) {
    return `${CONST.SERVICE_FABRIK_PREFIX}-${guid}`;
  }

  isInstanceSharingRequest(options) {
    const targetContext = options.bind_resource;
    const sourceContext = options.context;
    if (_.isNil(targetContext) || _.isNil(sourceContext) || !_.has(targetContext, 'app_guid')) {
      //service key creation requests are not part of sharing concept
      return false;
    }
    return targetContext.space_guid !== sourceContext.space_guid;
  }

  ensureValidShareRequest(options) {
    const allowCrossOrgSharing = _.get(config, 'AllowCrossOrganizationSharing', false);
    if (allowCrossOrgSharing) {
      return Promise.resolve(true);
    }
    return this.cloudController.getSpace(options.bind_resource.space_guid)
      .tap(targetSpaceDetails => logger.info(`shared instance binding: source instance organization: ${options.context.organization_guid}; target organization: ${targetSpaceDetails.entity.organization_guid}`))
      .then(targetSpaceDetails => options.context.organization_guid === targetSpaceDetails.entity.organization_guid);
  }

  preUnbindOperations(options) {
    return this.deleteSecurityGroupForShare(options);
  }

  preBindOperations(options) {
    console.log("---------------------->", JSON.stringify(options));
    const isSharing = this.isInstanceSharingRequest(options);
    const instanceSharingEnabled = _.get(config, 'feature.AllowInstanceSharing', true);

    return Promise.try(() => {
        if (isSharing) {
          if (!instanceSharingEnabled) {
            throw new InstanceSharingNotAllowed();
          }
          return this.ensureValidShareRequest(options);
        }
        return true;
      })
      .then(validBind => {
        if (!validBind) {
          throw new CrossOrganizationSharingNotAllowed();
        }
      });
  }

  postBindOperations(options) {
    const isSharing = this.isInstanceSharingRequest(options);
    if (isSharing) {
      return this.createSecurityGroupForShare(options);
    } else {
      return Promise.try(() => logger.info('Binding created in same space as instance- not creating security group'));
    }
  }

  postInstanceProvisionOperations(options) {
    if (_.get(config, 'feature.EnableSecurityGroupsOps', true)) {
      return this.createSecurityGroupForInstance(options);
    } else {
      return Promise.try(() => logger.info('Feature EnableSecurityGroupsOps set to false. Not creating security groups.'));
    }
  }

  preInstanceDeleteOperations(options) {
    if (_.get(config, 'feature.EnableSecurityGroupsOps', true)) {
      return this.deleteSecurityGroupForInstance(options);
    } else {
      return Promise.try(() => logger.info('Feature EnableSecurityGroupsOps set to false. Not deleting security groups.'));
    }
  }

  postInstanceUpdateOperations(options) {
    if (_.get(config, 'feature.EnableSecurityGroupsOps', true)) {
      return this.ensureSecurityGroupExists(options);
    } else {
      return Promise.try(() => logger.info('Feature EnableSecurityGroupsOps set to false. Not creating security groups.'));
    }
  }

  createApplicationSecurityGroup(name, rules, spaceId) {
    logger.info(`Creating security group '${name}' with rules ...`, rules);
    return utils
      .retry(tries => {
        logger.info(`+-> ${ordinals[tries]} attempt to create security group '${name}'...`);
        return this.cloudController
          .createSecurityGroup(name, rules, [spaceId]);
      }, {
        maxAttempts: 4,
        minDelay: 1000
      })
      .then(securityGroup => securityGroup.metadata.guid)
      .tap(guid => logger.info(`+-> Created security group with guid '${guid}'`))
      .catch(err => {
        logger.error(`+-> Failed to create security group ${name}`, err);
        throw new SecurityGroupNotCreated(name);
      });
  }

  deleteApplicationSecurityGroup(name) {
    logger.info(`Deleting security group '${name}'...`);
    return this.cloudController
      .findSecurityGroupByName(name)
      .tap(securityGroup => assert.strictEqual(securityGroup.entity.name, name))
      .then(securityGroup => securityGroup.metadata.guid)
      .tap(guid => logger.info(`+-> Found security group with guid '${guid}'`))
      .then(guid => this.cloudController.deleteSecurityGroup(guid))
      .tap(() => logger.info('+-> Deleted security group'))
      .catch(SecurityGroupNotFound, err => {
        logger.warn('+-> Could not find security group');
        logger.warn(err);
      }).catch(err => {
        logger.error('+-> Failed to delete security group', err);
        throw err;
      });
  }

  createSecurityGroupForShare(options) {
    const name = this.getSecurityGroupName(options.bindingId);
    const rules = _.map(options.ipRuleOptions, opts => this.buildSecurityGroupRules(opts));
    return this.createApplicationSecurityGroup(name, rules, options.bind_resource.space_guid);
  }

  createSecurityGroupForInstance(options) {
    const name = this.getSecurityGroupName(options.guid);
    const rules = _.map(options.ipRuleOptions, opts => this.buildSecurityGroupRules(opts));
    return this.createApplicationSecurityGroup(name, rules, options.context.space_guid);
  }

  ensureSecurityGroupExists(options) {
    const name = this.getSecurityGroupName(options.guid);
    logger.info(`Ensuring existence of security group '${name}'...`);
    return this.cloudController
      .findSecurityGroupByName(name)
      .tap(() => logger.info('+-> Security group exists'))
      .catch(SecurityGroupNotFound, () => {
        logger.warn('+-> Security group does not exist. Trying to create it again.');
        return this.ensureTenantId(options)
          .then(() => this.createSecurityGroupForInstance(options));
      });
  }

  deleteSecurityGroupForShare(options) {
    const name = this.getSecurityGroupName(options.bindingId);
    return this.deleteApplicationSecurityGroup(name);
  }

  deleteSecurityGroupForInstance(options) {
    const name = this.getSecurityGroupName(options.guid);
    return this.deleteApplicationSecurityGroup(name);
  }

  ensureTenantId(options) {
    return Promise
      .try(() => _.get(options, 'context.space_guid') ? options.context.space_guid : this.cloudController.getServiceInstance(options.guid)
        .then(instance => instance.entity.space_guid)
      );
  }

  buildSecurityGroupRules(options) {
    let portRule = '1024-65535';
    if (Array.isArray(options.applicationAccessPorts) && _.size(options.applicationAccessPorts) > 0) {
      portRule = _.join(options.applicationAccessPorts, ',');
    }
    return {
      protocol: options.protocol,
      destination: _.size(options.ips) === 1 ? `${_.first(options.ips)}` : `${_.first(options.ips)}-${_.last(options.ips)}`,
      ports: portRule
    };
  }

  isTenantWhiteListed(options) {
    const orgId = _.get(options, 'context.organization_guid');
    assert.ok(orgId, 'OrgId must be present when checking for whitelisting of Tenant in CF Context');
    return this.cloudController.getOrganization(orgId)
      .then(org => _.includes(config.quota.whitelist, org.entity.name))
      .tap(result => logger.info(`Current org - ${orgId} is whitelisted: ${result}`));
  }

  isMultiAzDeploymentEnabled(options) {
    return Promise.try(() => {
      if (config.multi_az_enabled === CONST.INTERNAL) {
        return this.isTenantWhiteListed(options);
      } else if (config.multi_az_enabled === CONST.ALL || config.multi_az_enabled === true) {
        logger.info('+-> Multi-AZ Deployment enabled for all consumers : ${config.multi_az_enabled}');
        return true;
      } else if (config.multi_az_enabled === CONST.DISABLED || config.multi_az_enabled === false) {
        logger.info(`+-> Multi-AZ Deployment disabled for all consumers : ${config.multi_az_enabled}`);
        return false;
      }
      throw new errors.UnprocessableEntity(`config.multi_az_enabled is set to ${config.multi_az_enabled}. Allowed values: [${CONST.INTERNAL}, ${CONST.ALL}/true, ${CONST.DISABLED}/false]`);
    });
  }

}

module.exports = CfPlatformManager;