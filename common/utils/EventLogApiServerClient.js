'use strict';

const _ = require('lodash');
const pubsub = require('pubsub-js');
const config = require('../config');
const logger = require('../logger');
const CONST = require('../constants');
const errors = require('../errors');
const utils = require('../../common/utils');
const catalog = require('../../common/models/catalog');
const eventmesh = require('../../data-access-layer/eventmesh');

class EventLogApiServerClient {
  constructor(options) {
    this.options = options;
    this.eventsToBeLogged = [];
    this.APP_SHUTDOWN_TOPIC = pubsub.subscribe(CONST.TOPIC.APP_SHUTTING_DOWN, () => this.shutDownHook());
    this.initialize();
  }

  initialize() {
    const eventNames = _.get(config, 'monitoring.events_logged_in_apiserver', '').replace(/\s*/g, '');
    this.eventsToBeLogged = eventNames.split(',');
    if (_.get(this.options, 'event_type') && this.HANDLE_EVENT_TOPIC === undefined) {
      this.HANDLE_EVENT_TOPIC = pubsub.subscribe(`${this.options.event_type}_SYNCH`, (message, data) => this.handleEvent(message, data));
      logger.debug(`EventLogAPIServerClient subscribed to event ${this.options.event_type}`);
    } else {
      if (_.get(this.options, 'event_type') === undefined) {
        logger.info('Event Type for EventLogAPIServerClient is empty.!');
      } else {
        logger.info(`Already subscribed to event ${this.options.event_type}`);
      }
    }
  }

  handleEvent(message, data) {
    if (data.event && data.event.eventName) {
      const completeEventName = data.event.eventName;
      const parsedEventName = data.event.eventName.split('.');
      const eventName = parsedEventName[parsedEventName.length - 1];
      if (eventName && this.eventsToBeLogged.indexOf(eventName) !== -1) {
        logger.debug(`${eventName} configured to be logged into APIServer`);
        const eventInfo = _.cloneDeep(data.event);
        if ((eventInfo.eventName === CONST.SFEVENT_TYPE.CREATE_INSTANCE || eventInfo.UPDATE_INSTANCE) &&
          eventInfo.metric !== config.monitoring.success_metric) {
          return;
          //If not success, then no need to meter create or update.
        }
        eventInfo.eventName = eventName;
        eventInfo.completeEventName = completeEventName;
        let events = [];
        events[0] = eventInfo;
        if (eventName === CONST.SFEVENT_TYPE.UPDATE_INSTANCE) {
          events = this.convertUpdateToStartAndStopEvents(eventInfo);
        }
        const log = (event) => this.logEvent(event);
        for (let x = 0; x < events.length; x++) {
          //Adding in a delay of 1 sec to just ensure stop event and start event have a sec diff among them.
          setTimeout(() => log(events[x]), x * 1000);
          //this.logEvent(events[x]);
        }
      }
    }
  }

  convertUpdateToStartAndStopEvents(eventInfo) {
    const operation = utils.decodeBase64(eventInfo.request.operation);
    logger.info('Operation is -', operation);
    if (!operation.plan_update) {
      return [];
    }
    const stopEvent = _.cloneDeep(eventInfo);
    stopEvent.request.plan_id = operation.previous_plan_id;
    stopEvent.eventName = CONST.SFEVENT_TYPE.DELETE_INSTANCE;
    let completeEventName = eventInfo.completeEventName.split('.');
    completeEventName[completeEventName.length - 1] = CONST.SFEVENT_TYPE.DELETE_INSTANCE;
    stopEvent.completeEventName = completeEventName.join('.');

    const startEvent = _.cloneDeep(eventInfo);
    startEvent.eventName = CONST.SFEVENT_TYPE.CREATE_INSTANCE;
    startEvent.request.plan_id = operation.plan_id;
    completeEventName = startEvent.completeEventName.split('.');
    completeEventName[completeEventName.length - 1] = CONST.SFEVENT_TYPE.CREATE_INSTANCE;
    startEvent.completeEventName = completeEventName.join('.');
    logger.info('Sending start and stop event for update - ');
    return [stopEvent, startEvent];
  }

  logEvent(eventInfo) {
    eventInfo.instanceId = _.get(eventInfo, 'request.instance_id') || _.get(eventInfo, 'request.instance_guid') ||
      _.get(eventInfo, 'response.instance_id') || _.get(eventInfo, 'response.instance_guid', 'NA');
    //Pick instance id either from request / response attribs
    logger.debug('event being written to API Server - ', eventInfo);
    const labels = {
      name: eventInfo.instanceId,
      type: eventInfo.eventName,
      meter_state: CONST.METER_STATE.TO_BE_METERED
    };
    const plan = catalog.getPlan(eventInfo.request.plan_id);
    return eventmesh.apiServerClient.getResource({
        resourceGroup: plan.manager.resource_mappings.resource_group,
        resourceType: plan.manager.resource_mappings.resource_type,
        resourceId: eventInfo.instanceId
      })
      .tap(resource => logger.silly('Recieved Resource to be logged...- ', JSON.stringify(resource)))
      .then(resource => {
        eventInfo.request.context = resource.spec.options.context;
        return eventmesh.apiServerClient.createResource({
          resourceGroup: CONST.APISERVER.RESOURCE_GROUPS.INSTANCE,
          resourceType: CONST.APISERVER.RESOURCE_TYPES.EVENT,
          resourceId: `${eventInfo.request.plan_id}.${eventInfo.instanceId}.${eventInfo.eventName.replace('_', '-')}`,
          labels: labels,
          options: eventInfo,
          status: {
            meter_state: CONST.METER_STATE.TO_BE_METERED
          }
        });
      })
      .tap(() => logger.debug(`Successfully logged event resource in API Server with instance Id: ${eventInfo.instanceId} `))
      .catch(errors.Conflict, () => logger.info('event already logged. Ignoring subsequent entry!'));
  }

  shutDownHook() {
    pubsub.unsubscribe(this.APP_SHUTDOWN_TOPIC);
    if (this.HANDLE_EVENT_TOPIC) {
      pubsub.unsubscribe(this.HANDLE_EVENT_TOPIC);
    }
  }
}

pubsub.subscribe(CONST.TOPIC.APP_STARTUP, (eventName, eventInfo) => {
  logger.debug('-> Received event ->', eventName);
  if (eventInfo.type === 'internal') {
    //return eventmesh.apiServerClient.unRegisterCrds(CONST.APISERVER.RESOURCE_GROUPS.INSTANCE, CONST.APISERVER.RESOURCE_TYPES.EVENT);
    logger.info('Registering .. METER PLAN..');
    return Promise.all([eventmesh.apiServerClient.registerCrds(CONST.APISERVER.RESOURCE_GROUPS.INSTANCE, CONST.APISERVER.RESOURCE_TYPES.EVENT),
      eventmesh.apiServerClient.registerCrds(CONST.APISERVER.RESOURCE_GROUPS.METER, CONST.APISERVER.RESOURCE_TYPES.PLAN)
    ]);
  }
});

module.exports = EventLogApiServerClient;