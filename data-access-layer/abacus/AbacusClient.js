'use strict';

const config = require('../../common/config');
const HttpClient = require('../../common/utils/HttpClient');
const CONST = require('../../common/constants');
const logger = require('../../common/logger');

class AbacusClient extends HttpClient {
  constructor() {
    super({
      baseUrl: config.abacus.url,
      headers: {
        Accept: 'application/json'
      },
      followRedirect: true
    });
  }

  startEvent(payLoad) {
    return this
      .request({
        method: 'POST',
        url: '/v1/events/start',
        json: true,
        body: payLoad
      }, CONST.HTTP_STATUS_CODE.ACCEPTED)
      .then(res => res.body)
      .tap(res => logger.debug('Start event response : ', res));
  }

  endEvent(payLoad) {
    return this
      .request({
        method: 'POST',
        url: '/v1/events/stop',
        json: true,
        body: payLoad
      }, CONST.HTTP_STATUS_CODE.ACCEPTED)
      .then(res => res.body)
      .tap(res => logger.debug('End event response : ', res));
  }

  registerPlan(payLoad) {
    return this
      .request({
        method: 'POST',
        url: '/v1/mappings',
        json: true,
        body: payLoad
      }, CONST.HTTP_STATUS_CODE.CREATED)
      .then(res => res.body)
      .tap(res => logger.debug('Register plan response : ', res));
  }
}
module.exports = new AbacusClient();