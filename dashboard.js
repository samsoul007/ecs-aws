const colors = require('colors');
const moment = require('moment');
const AWS = require('aws-sdk');
const blessed = require('blessed');
const contrib = require('blessed-contrib');

const { getServiceData, getLogStreams, getLogEvents } = require('./aws');

const wait = iSecondInterval => uData => new Promise(resolve => setTimeout(() => {
  resolve(uData);
}, iSecondInterval * 1000));

const fGetLogs = (arroProfileData, seconds) => getLogStreams(arroProfileData.log)
  .then((arrsStreams) => {
    arrsStreams.reverse();
    const arroPromises = [];
    const date = moment();

    date.subtract(seconds || 60 * 60, 'seconds');
    for (let i = 0; i < arrsStreams.length; i += 1) {
      arroPromises.push(getLogEvents(arroProfileData.log, arrsStreams[i], date.unix()));
    }

    return Promise.all(arroPromises)
      .then((arroData) => {
        const arroLog = [];

        for (let i = 0; i < arroData.length; i += 1) {
          Object.keys(arroData[i]).forEach((key) => {
            const arrsMessage = arroData[i][key];
            const oDate = new Date();
            oDate.setTime(key);
            arroLog.push([oDate, arrsMessage.join('\n')]);
          });
        }

        arroLog.sort((a, b) => moment.utc(b[0]).diff(moment.utc(a[0])));

        return arroLog.slice(0, 25);
      });
  });


const fGetStats = (arroProfileData, metricName) => {
  const cloudwatch = new AWS.CloudWatch();

  const params = {
    EndTime: new Date(),
    /* required */
    MetricName: metricName,
    /* required */
    Namespace: 'AWS/ECS',
    /* required */
    Period: 5,
    /* required */
    StartTime: moment().subtract(20, 'minutes').unix(),
    /* required */
    Dimensions: [{
      Name: 'ClusterName',
      /* required */
      Value: arroProfileData.cluster.split('cluster/')[1], /* required */
    },
    {
      Name: 'ServiceName',
      /* required */
      Value: arroProfileData.service.split('service/')[1], /* required */
    },
      /* more items */
    ],
    Statistics: [
      'Average',
      'Minimum',
      'Maximum',
      /* more items */
    ],
    Unit: 'Percent',
  };
  return cloudwatch.getMetricStatistics(params).promise()
    .then(data => data.Datapoints
      .map((dp) => {
        const dataPoint = dp;
        dataPoint.Timestamp = new Date(dataPoint.Timestamp);
        return dataPoint;
      })
      .sort((a, b) => a.Timestamp - b.Timestamp));
};

module.exports = (arroProfileData) => {
  // return fGetLogs(arroProfileData).then(arroLogs => JSON.stringify(arroLogs,null,2)).then(console.log)
  const iSecondInterval = 5;

  const screen = blessed.screen({
    title: arroProfileData.task,
  });

  const grid = new contrib.grid({ // eslint-disable-line new-cap
    rows: 12,
    cols: 12,
    screen,
  });


  screen.key(['escape', 'q', 'C-c'], () => process.exit(0));

  // Service events;
  const eventLogs = grid.set(6, 4, 6, 8, contrib.log, {
    fg: 'black',
    selectedFg: 'green',
    label: 'Events',
  });

  eventLogs.log(colors.green('Please wait while the events are loading...'));
  // end service logs

  // Service info
  const table = grid.set(0, 0, 3, 4, contrib.table, {
    keys: false,
    fg: 'black',
    selectedFg: 'black',
    interactive: false,
    label: `Service "${arroProfileData.service.split('service/')[1]}" Information (updated every ${iSecondInterval} seconds)`,
    border: {
      type: 'line',
      fg: 'black',
    },
    columnSpacing: 1, // in chars
    columnWidth: [20, 30], /* in chars */
  });

  screen.render();

  table.setData({
    headers: [''],
    data: [
      [colors.green.bold('loading information...')],
    ],
  });

  screen.render();
  // end service info


  const getMetrics = (sMetricName, line) => fGetStats(arroProfileData, sMetricName).then((data) => {
    const times = data.map(d => moment(d.Timestamp).format('HH:mm'));
    line.setData([{
      title: 'Average',
      x: times,
      y: data.map(d => d.Average),
      style: {
        line: 'green',
      },
    },
    {
      title: 'Minimum',
      x: times,
      y: data.map(d => d.Minimum),
      style: {
        line: 'yellow',
      },
    },
    {
      title: 'Maximum',
      x: times,
      y: data.map(d => d.Maximum),
      style: {
        line: 'red',
      },
    },
    ]);

    return screen.render();
    // return setTimeout(() => {
    //   getMetrics(p_sMetricName, line);
    // }, iSecondInterval * 1000);
  })
    .then(wait(iSecondInterval))
    .then(() => getMetrics(sMetricName, line));

  // Metrics

  const line = grid.set(6, 0, 3, 4, contrib.line, {
    style: {
      line: 'yellow',
      text: 'green',
      baseline: 'green',
    },
    xLabelPadding: 3,
    xPadding: 5,
    showLegend: false,
    wholeNumbersOnly: false, // true=do not show fraction in y axis
    label: 'CPUUtilization (%)',
  });

  getMetrics('CPUUtilization', line);

  // Metrics2

  const line2 = grid.set(9, 0, 3, 4, contrib.line, {
    style: {
      line: 'yellow',
      text: 'green',
      baseline: 'green',
    },
    xLabelPadding: 3,
    xPadding: 5,
    showLegend: false,
    wholeNumbersOnly: false, // true=do not show fraction in y axis
    label: 'MemoryUtilization (%)',
  });

  getMetrics('MemoryUtilization', line2);

  // service info data
  const getInfo = () => getServiceData(arroProfileData).then((data) => {
    const oService = data.services[0];
    table.setData({
      headers: ['', ''],
      data: [
        [colors.red.bold('Service name'), oService.serviceName],
        [colors.red.bold('Task definition'), oService.taskDefinition.split('task-definition/')[1]],
        [colors.red.bold('Desired tasks'), oService.desiredCount],
        [colors.red.bold('Running tasks'), oService.runningCount],
        [colors.red.bold('Pending tasks'), oService.pendingCount],
        [colors.red.bold('Created'), moment(oService.createdAt).format('DD MMMM YYYY @ HH:mm:ss')],
        [colors.red.bold('Deployed'), moment(oService.deployments[0].updatedAt).format('DD MMMM YYYY @ HH:mm:ss')],
      ],
    });

    for (let i = 0; i < oService.events.length; i += 1) {
      const oEvent = oService.events[i];
      eventLogs.log(`${colors.red(moment(oEvent.createdAt).format('MMM DD HH:mm:ss'))}:\t${oEvent.message}`);
    }

    return screen.render();
  })
    .then(wait(iSecondInterval))
    .then(getInfo);

  getInfo();

  // service logs
  let log = grid.set(0, 4, 6, 8, contrib.log, {
    fg: 'black',
    selectedFg: 'green',
    label: 'Logs',
  });
  log.log(colors.green('Please wait while the logs are loading...'));
  // end service logs

  // logs update
  const getLogs = () => fGetLogs(arroProfileData)
    .then((arroLogs) => {
      log = grid.set(0, 4, 6, 8, contrib.log, {
        fg: 'black',
        selectedFg: 'green',
        label: 'Logs',
      });

      return arroLogs;
    })
    .then((arroLogs) => {
      for (let i = 0; i < arroLogs.length; i += 1) {
        log.log(`${colors.red(moment(arroLogs[i][0]).format('MMM DD HH:mm:ss'))}:\t${arroLogs[i][1]}`);
      }

      return screen.render();
    })
    .then(wait(iSecondInterval))
    .then(getLogs);

  getLogs();
};
