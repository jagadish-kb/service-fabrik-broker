'use strict';

const _ = require('lodash');
const Promise = require('bluebird');
const logger = require('../common/logger');
const errors = require('../common/errors');
const BaseJob = require('./BaseJob');
const abacusClient = require('../data-access-layer/abacus');
const catalog = require('../common/models/catalog');

const apiServerClient = require('../data-access-layer/eventmesh').apiServerClient;
const CONST = require('../common/constants');

class MeterInstanceJob extends BaseJob {
  static run(job, done) {
    return Promise.try(() => {
      logger.debug('Starting MeterInstanceJob Job');
      this
        .registerNewPlans()
        .then(() => this.getInstanceEvents())
        .tap(events => logger.info('recieved events -> ', events))
        .then(events => this.meter(events))
        .then((meterResponse) => this.runSucceeded(meterResponse, job, done))
        .catch((err) => this.runFailed(err, {}, job, done));
    });
  }

  static registerNewPlans() {
    return Promise.try(() => {
      return this
        .getRegisteredPlans()
        .then(registredPlans => {
          logger.debug('Registered plans ..', registredPlans.length);
          logger.debug('number of services', catalog.toJSON().services.length);
          return Promise.map(catalog.toJSON().services, (service) => {
            logger.debug('Registering plans of service : ', service.name);
            return Promise.map(service.plans, (plan) => {
              logger.debug(`plan to be registered ${plan.name} ${plan.id}`);
              const labels = {
                name: plan.id
              };
              if (_.find(registredPlans, registedPlan => registedPlan.spec.options.planId === plan.id) !== undefined) {
                logger.debug(`Plan ${plan.id} already registered with abacus`);
                return;
              }
              logger.info(`Registering plan ${plan.id} with abacus`);
              return this
                .registerPlan(service.id, plan.id)
                .tap(() => logger.info(`Successfully registered service : ${service.id} Plan : ${plan.id} with Abacus`))
                .then(() =>
                  apiServerClient.createResource({
                    resourceGroup: CONST.APISERVER.RESOURCE_GROUPS.METER,
                    resourceType: CONST.APISERVER.RESOURCE_TYPES.PLAN,
                    resourceId: `${service.id}.${plan.id}`,
                    labels: labels,
                    options: {
                      planId: plan.id,
                      serviceId: service.id,
                      planName: plan.name,
                      serviceName: service.name
                    },
                    status: {
                      state: CONST.OPERATION.SUCCEEDED
                    }
                  }))
                .tap(() => logger.info(`Successfully registered plan for ${plan.id} `))
                .catch(errors.Conflict, () => logger.info('event already logged. Ignoring subsequent entry!'));
            });
          });
        });
    });
  }

  static getRegisteredPlans() {
    const options = {
      resourceGroup: CONST.APISERVER.RESOURCE_GROUPS.METER,
      resourceType: CONST.APISERVER.RESOURCE_TYPES.PLAN,
      query: {}
    };
    return apiServerClient.getResources(options);
  }

  static getInstanceEvents() {
    const options = {
      resourceGroup: CONST.APISERVER.RESOURCE_GROUPS.INSTANCE,
      resourceType: CONST.APISERVER.RESOURCE_TYPES.EVENT,
      query: {
        labelSelector: `meter_state in (${CONST.METER_STATE.TO_BE_METERED}, ${CONST.OPERATION.FAILED})`
      }
    };
    return apiServerClient.getResources(options);
  }

  static meter(events) {
    logger.info(`Number of events to be metered in this run - ${events.length}`);
    return Promise.try(() => {
      let successCount = 0,
        failureCount = 0,
        failedEvents = [];
      return Promise.map(events, (event) => {
        const serviceId = _.get(event, 'spec.options.request.service_id');
        const planId = _.get(event, 'spec.options.request.plan_id');
        return this
          .sendEvent(serviceId, planId, event)
          .then((status) => {
            if (status) {
              successCount++;
            } else {
              failureCount++;
              failedEvents.push(event);
            }
          })
          .catch(err => {
            logger.error(`Error occurred while metering event : `, err);
          });
      }).then(() => {
        return {
          totalEvents: events.length,
          success: successCount,
          failed: failureCount,
          failedEvents: failedEvents
        };
      });
    });
  }

  static sendEvent(serviceId, planId, event) {
    const instanceId = _.get(event, 'spec.options.request.instance_id');
    const eventType = _.get(event, 'spec.options.eventName');
    const eventGuid = _.get(event, 'metadata.uid');
    const orgId = _.get(event, 'spec.options.request.context.organization_guid');
    const spaceId = _.get(event, 'spec.options.request.context.space_guid');
    return Promise.try(() => {
        logger.info(`registered plan -  ${serviceId} : ${planId}`);
        switch (eventType) {
        case CONST.SFEVENT_TYPE.CREATE_INSTANCE:
          logger.info(`Sending in start event -  for Instance : ${instanceId} - service : ${serviceId} - planId : ${planId} for event - eventType`);
          return this
            .sendStartEvent(serviceId, planId, instanceId, eventGuid, orgId, spaceId)
            .return(true);
        case CONST.SFEVENT_TYPE.DELETE_INSTANCE:
          logger.info(`Sending in end event -  for Instance : ${instanceId} - service : ${serviceId} - planId : ${planId} for event - eventType`);
          return this
            .sendEndEvent(serviceId, planId, instanceId, eventGuid, orgId, spaceId)
            .return(true);
        default:
          logger.error(`Unknown event type : ${eventType} added into sfevents for processing.`, event);
          return false;
        }
      })
      .then(validEvent => validEvent ? this.updateMeterState(CONST.OPERATION.SUCCEEDED, instanceId, eventType, event) : false)
      .return(true)
      .catch(err => {
        logger.error('Error occurred while metering event : ', event);
        logger.error('Error Details - ', err);
        return this
          .updateMeterState(CONST.OPERATION.FAILED, instanceId, eventType, event)
          .return(false);
      });
  }

  static sendStartEvent(serviceId, planId, instanceId, eventGuid, orgId, spaceId) {
    const payLoad = this.getEventPayload(serviceId, planId, instanceId, eventGuid, orgId, spaceId);
    payLoad.measured_usage = [];
    logger.info('Sending start event - ', payLoad);
    return abacusClient.startEvent(payLoad);
  }

  static sendEndEvent(serviceId, planId, instanceId, eventGuid, orgId, spaceId) {
    const payLoad = this.getEventPayload(serviceId, planId, instanceId, eventGuid, orgId, spaceId);
    logger.info('Sending end event - ', payLoad);
    return abacusClient.endEvent(payLoad);
  }

  static registerPlan(serviceId, planId) {
    const service = catalog.getService(serviceId);
    const payLoad = {
      resource_id: service.name,
      plan_id: planId,
      metering_plan: 'standard-services-hours',
      rating_plan: 'standard-services-hours',
      pricing_plan: 'standard-services-hours'
    };
    return abacusClient.registerPlan(payLoad);
  }

  static getEventPayload(serviceId, planId, instanceId, eventGuid, orgId, spaceId) {
    const service = catalog.getService(serviceId);
    return {
      id: eventGuid,
      timestamp: new Date().getTime(),
      organization_id: orgId,
      space_id: spaceId,
      consumer_id: `service:${instanceId}`,
      resource_id: service.name,
      plan_id: planId,
      resource_instance_id: `service:${instanceId}:${planId}:${service.name}`
    };
  }

  static updateMeterState(status, instanceId, eventType, event) {
    const metadata = event.metadata;
    metadata.labels.meter_state = status;
    return apiServerClient.updateResource({
        resourceGroup: CONST.APISERVER.RESOURCE_GROUPS.INSTANCE,
        resourceType: CONST.APISERVER.RESOURCE_TYPES.EVENT,
        resourceId: `${instanceId}.${eventType.replace('_', '-')}`,
        metadata: metadata,
        status: {
          meter_state: status
        }
      })
      .tap((response) => logger.info('Successfully updated meter state : ', response));
  }
}

module.exports = MeterInstanceJob;