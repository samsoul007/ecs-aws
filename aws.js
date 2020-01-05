const AWS = require('aws-sdk');

const getServiceData = (arroProfileData) => {
  const ecs = new AWS.ECS();

  const params = {
    services: [ /* required */
      arroProfileData.service,
      /* more items */
    ],
    cluster: arroProfileData.cluster,
  };
  return ecs.describeServices(params).promise();
};

const getLogStreams = (sLogName) => {
  const cloudwatchlogs = new AWS.CloudWatchLogs();

  const params = {
    logGroupName: sLogName,
    /* required */
    descending: true,
    limit: 2,
    orderBy: 'LastEventTime',
  };

  return cloudwatchlogs.describeLogStreams(params).promise()
    .then(data => data.logStreams.map(oStream => oStream.logStreamName));
};

const getLogEvents = (logName, streamName, startime) => {
  const cloudwatchlogs = new AWS.CloudWatchLogs();

  const params = {
    logGroupName: logName,
    logStreamName: streamName,
  };

  if (startime) {
    params.startTime = startime;
  }

  return cloudwatchlogs.getLogEvents(params).promise().then((data) => {
    const arroEvents = {};

    for (let i = 0; i < data.events.length; i += 1) {
      const oEvent = data.events[i];

      if (!arroEvents[oEvent.timestamp]) arroEvents[oEvent.timestamp] = [];

      arroEvents[oEvent.timestamp].push(oEvent.message);
    }
    return arroEvents; // successful response
  });
};

module.exports = {
  getServiceData,
  getLogStreams,
  getLogEvents,
};
